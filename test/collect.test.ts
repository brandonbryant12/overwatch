import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { problem, Slice } from "../src/collect.ts";
import { LIMITS, parseConfig } from "../src/config.ts";
import { backoff, classify } from "../src/failures.ts";
import { snapshot } from "../src/snapshot.ts";
import { Store, type Clean } from "../src/store.ts";
import { clock } from "../src/clock.ts";

const source = parseConfig(
  {
    version: 2,
    dataDir: "/tmp/ow-collect-test",
    apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } },
    watchers: [{ app: "shop", environment: "prod", every: "1m" }],
  },
  "/tmp/c.json",
);

test("problems group by their words: numbers and IDs do not split them", () => {
  assert.equal(problem("ERROR storm 41")!.title, "ERROR storm");
  assert.equal(problem("ERROR storm 41")!.fingerprint, problem("ERROR storm 99")!.fingerprint);
  assert.notEqual(problem("ERROR alpha 1")!.fingerprint, problem("ERROR beta 1")!.fingerprint);
  assert.equal(problem("INFO all good"), null);
  assert.equal(problem("WARN slow start")!.severity, "warn");
});

test("a slice admits at most the occurrence limit and folds problems past 500 into one overflow", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 520 }), fc.integer({ min: 1, max: 3 }), (distinct, each) => {
      const slice = new Slice(source.sources[0]!, 0, 1, []);
      let n = 0;
      for (let d = 0; d < distinct; d++) for (let e = 0; e < each; e++) slice.add(`k${n++}`, 1, `fp${d}`, `ERROR w${d}`, "error");
      assert.equal(slice.admitted.length, Math.min(n, LIMITS.occurrencesPerSlice));
      assert.equal([...slice.buckets.keys()].filter((k) => k !== "overflow").length, Math.min(distinct, LIMITS.problemsPerSlice));
      assert.equal(slice.buckets.has("overflow"), distinct > LIMITS.problemsPerSlice);
      assert.equal(slice.admitted.filter((r) => r.bucket === "overflow").length, Math.max(0, distinct - LIMITS.problemsPerSlice) * each);
    }),
    { numRuns: 60 },
  );
});

test("past the storm limit the count is a lower bound, and a saturated interval admits nothing on replay", () => {
  const slice = new Slice(source.sources[0]!, 0, 10, []);
  for (let i = 0; i < LIMITS.occurrencesPerSlice + 7; i++) slice.add(`k${i}`, 5, "storm", "ERROR storm", "error");
  assert.equal(slice.admitted.length, LIMITS.occurrencesPerSlice);
  assert.equal(slice.buckets.get("storm")!.inexact, true);
  assert.ok(slice.capped);
  const replay = new Slice(source.sources[0]!, 0, 20, [{ from: 0, to: 10 }]);
  for (let i = 0; i < 100; i++) replay.add(`k${i}`, 5, "storm", "ERROR storm", "error");
  assert.equal(replay.admitted.length, 0);
});

test("back-off: sign-in suspends on its second refusal; others wait one, two intervals, then suspend; never past five minutes", () => {
  assert.deepEqual(backoff("signin", 0, 60_000), { streak: 1, suspended: false, delayMs: 60_000 });
  assert.deepEqual(backoff("signin", 1, 60_000), { streak: 2, suspended: true, delayMs: 300_000 });
  fc.assert(
    fc.property(fc.constantFrom("unreachable", "rate", "config", "permission"), fc.integer({ min: 0, max: 10 }), fc.integer({ min: 60_000, max: 3_600_000 }), (kind, streak, every) => {
      const b = backoff(kind as "unreachable", streak, every);
      assert.equal(b.streak, streak + 1);
      assert.equal(b.suspended, streak + 1 >= 3);
      assert.ok(b.delayMs <= 300_000);
    }),
  );
  assert.equal(classify("error: You must be logged in to the server (Unauthorized)"), "signin");
  assert.equal(classify("Forbidden: cannot list resource pods.metrics.k8s.io"), "permission");
  assert.equal(classify("Unable to connect to the server: dial tcp: i/o timeout"), "unreachable");
  assert.equal(classify("x", 429), "rate");
});

test("health is quiet only when every expected reading is fresh, measured and no source is failing", () => {
  const config = parseConfig({ ...JSON.parse(JSON.stringify({ version: 2, apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } }, watchers: [{ app: "shop", environment: "prod", every: "1m" }] })), dataDir: "/tmp/x" }, "/tmp/c.json");
  const readings = ["logs", "events", "workloads", "usage"];
  fc.assert(
    fc.property(
      fc.record({
        states: fc.array(fc.constantFrom("ok", "ok", "capped", "gap", "failed", "absent", "old"), { minLength: 4, maxLength: 4 }),
        failure: fc.constantFrom(null, null, "signin", "unreachable"),
        error: fc.boolean(),
      }),
      ({ states, failure, error }) => {
        const store = Store.own(mkdtempSync(join(tmpdir(), "ow-health-")));
        clock.set(10_000_000, 0);
        store.tx((w) => {
          readings.forEach((r, i) => {
            const s = states[i]!;
            if (s === "absent") return;
            const at = s === "old" ? 10_000_000 - 4 * 60_000 : 10_000_000 - 1000;
            w.run("INSERT INTO readings (source, reading, state, at_ms, ok_ms) VALUES ('shop/prod/pods', ?, ?, ?, ?)", r as Clean, (s === "old" ? "ok" : s) as Clean, at, s === "failed" ? null : at);
          });
          w.run("INSERT INTO sources (id, checkpoint_ms, failure, streak, next_ms, suspended) VALUES ('shop/prod/pods', 0, ?, 1, 0, 0)", failure as Clean | null);
          if (error) w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES ('inc_1', 'shop', 'prod', 's', 'ERROR x', 'error', 1, 1, 0, 0, 1)");
        });
        const health = snapshot(store, config, null, false).environments[0]!.health;
        store.close();
        const clean = states.every((s) => s === "ok") && failure === null && !error;
        assert.equal(health === "quiet", clean, JSON.stringify({ states, failure, error, health }));
        if (failure === "signin") assert.equal(health, "signed_out");
        else if (states.some((s) => s === "absent" || s === "old")) assert.equal(health, "stale");
      },
    ),
    { numRuns: 150 },
  );
});
