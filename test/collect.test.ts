import { scratch } from "./scratch.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { Effect } from "effect";
import { problem, Slice, within } from "../src/collect.ts";
import { count, num, time } from "../src/parse.ts";
import { LIMITS, parseConfig } from "../src/config.ts";
import { backoff, classify } from "../src/failures.ts";
import { snapshot } from "../src/snapshot.ts";
import { type Clean } from "../src/store.ts";
import { clock } from "../src/clock.ts";
import { run, withConfig, withStore } from "./effect.ts";

/** A slice's admission, run to its end (the tests' `known` answers at once). */
const add = (slice: Slice, ...args: Parameters<Slice["add"]>) => Effect.runSync(slice.add(...args));

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
      const slice = new Slice(source.sources[0]!, { from: 0, to: 10 }, []);
      let n = 0;
      for (let d = 0; d < distinct; d++) for (let e = 0; e < each; e++) add(slice, `k${n++}`, "s", 1, `fp${d}`, `ERROR w${d}`, "error");
      assert.equal(slice.admitted.length, Math.min(n, LIMITS.occurrencesPerSlice));
      assert.equal([...slice.buckets.keys()].filter((k) => k !== "overflow").length, Math.min(distinct, LIMITS.problemsPerSlice));
      assert.equal(slice.buckets.has("overflow"), distinct > LIMITS.problemsPerSlice);
      assert.equal(slice.admitted.filter((r) => r.bucket === "overflow").length, Math.max(0, distinct - LIMITS.problemsPerSlice) * each);
    }),
    { numRuns: 60 },
  );
});

test("past the storm limit the count is a lower bound, and a saturated interval admits nothing on replay", () => {
  const slice = new Slice(source.sources[0]!, { from: 0, to: 10 }, []);
  for (let i = 0; i < LIMITS.occurrencesPerSlice + 7; i++) add(slice, `k${i}`, "s", 5, "storm", "ERROR storm", "error");
  assert.equal(slice.admitted.length, LIMITS.occurrencesPerSlice);
  assert.equal(slice.buckets.get("storm")!.inexact, true);
  assert.ok(slice.capped);
  const replay = new Slice(source.sources[0]!, { from: 0, to: 20 }, [{ from: 0, to: 10 }]);
  for (let i = 0; i < 100; i++) add(replay, `k${i}`, "s", 5, "storm", "ERROR storm", "error");
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

test("health is quiet only when every expected reading is fresh, measured and no source is failing", async () => {
  const config = parseConfig({ ...JSON.parse(JSON.stringify({ version: 2, apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } }, watchers: [{ app: "shop", environment: "prod", every: "1m" }] })), dataDir: "/tmp/x" }, "/tmp/c.json");
  const readings = ["logs", "events", "workloads", "usage"];
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        states: fc.array(fc.constantFrom("ok", "ok", "capped", "gap", "failed", "absent", "old"), { minLength: 4, maxLength: 4 }),
        failure: fc.constantFrom(null, null, "signin", "unreachable"),
        error: fc.boolean(),
      }),
      async ({ states, failure, error }) => {
        clock.set(10_000_000, 0);
        const health = await run(
          withStore(scratch("ow-health-"), (store) =>
            Effect.gen(function* () {
              yield* store.tx((w) =>
                Effect.gen(function* () {
                  for (const [i, r] of readings.entries()) {
                    const s = states[i]!;
                    if (s === "absent") continue;
                    const at = s === "old" ? 10_000_000 - 4 * 60_000 : 10_000_000 - 1000;
                    yield* w.run("INSERT INTO readings (source, reading, state, at_ms, ok_ms) VALUES ('shop/prod/pods', ?, ?, ?, ?)", r as Clean, (s === "old" ? "ok" : s) as Clean, at, s === "failed" ? null : at);
                  }
                  yield* w.run("INSERT INTO sources (id, checkpoint_ms, failure, streak, next_ms, suspended) VALUES ('shop/prod/pods', 0, ?, 1, 0, 0)", failure as Clean | null);
                  if (error) yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES ('inc_1', 'shop', 'prod', 's', 'ERROR x', 'error', 1, 1, 0, 0, 1)");
                }),
              );
              return (yield* snapshot(null, false).pipe(withConfig(config))).environments[0]!.health;
            }),
          ),
        );
        const clean = states.every((s) => s === "ok") && failure === null && !error;
        assert.equal(health === "quiet", clean, JSON.stringify({ states, failure, error, health }));
        if (failure === "signin") assert.equal(health, "signed_out");
        else if (states.some((s) => s === "absent" || s === "old")) assert.equal(health, "stale");
      },
    ),
    { numRuns: 150 },
  );
});

test("the demo stays as seeded for as long as it runs", async () => {
  const { demoConfig, seedDemo, freshen } = await import("../src/demo.ts");
  clock.set(Date.UTC(2026, 10, 1), 5_000_000);
  const config = await run(demoConfig(0));
  await run(
    withStore(config.dataDir, () =>
      Effect.gen(function* () {
        yield* seedDemo;
        const health = Effect.map(snapshot(null, true), (s) => Object.fromEntries(s.environments.map((e) => [e.environment, e.health])));
        const seeded = yield* health;
        assert.deepEqual(seeded, { production: "attention", staging: "quiet", qa: "signed_out" });
        for (let i = 1; i <= 120; i++) {
          clock.set(Date.UTC(2026, 10, 1) + i * 60_000, 5_000_000 + i * 60_000);
          yield* freshen;
        }
        assert.deepEqual(yield* health, seeded);
      }).pipe(withConfig(config)),
    ),
  );
});

test("only what is new is charged: replays and saturated records leave room, and problem slots, for a fresh record", () => {
  const stored = new Set(Array.from({ length: LIMITS.occurrencesPerSlice + 1 }, (_, i) => `old${i}`));
  const slice = new Slice(source.sources[0]!, { from: 0, to: 100 }, [{ from: 50, to: 60 }], (k) => Effect.succeed(stored.has(k)));
  for (const key of stored) add(slice, key, "s", 10, `fp-${key}`, "ERROR storm", "error");
  for (let i = 0; i < 10; i++) add(slice, `new-in-saturated${i}`, "s", 55, "fp-sat", "ERROR storm", "error");
  add(slice, "fresh", "s", 70, "fp-fresh", "ERROR fresh", "error");
  assert.deepEqual(slice.admitted.map((a) => a.key), ["fresh"]);
  assert.equal(slice.fresh, 1);
  assert.deepEqual([...slice.buckets.keys()], ["fp-fresh"], "replayed problems do not take distinct-problem slots");
  assert.equal(slice.capped, false);
});

test("every window is half-open: a record at a slice's end belongs to the next one", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 1, max: 1000 }), fc.integer({ min: -5, max: 2005 }), (from, length, at) => {
      const to = from + length, next = to + length;
      const a = new Slice(source.sources[0]!, { from, to }, []), b = new Slice(source.sources[0]!, { from: to, to: next }, []);
      add(a, "k", "s", at, "fp", "ERROR x", "error");
      add(b, "k", "s", at, "fp", "ERROR x", "error");
      assert.equal(a.admitted.length + b.admitted.length, at >= from && at < next ? 1 : 0);
      assert.equal(within({ from, to }, at), at >= from && at < to);
    }),
    { numRuns: 300 },
  );
});

test("an outside value that is not clearly a number, count or time is not measured", () => {
  fc.assert(
    fc.property(fc.oneof(fc.constant(null), fc.constant(undefined), fc.constant(""), fc.constant("  "), fc.boolean(), fc.constant(NaN), fc.constant(Infinity), fc.string().filter((s) => !/^\s*-?\d/.test(s)), fc.object()), (v) => {
      assert.equal(num(v), null);
      assert.equal(count(v), null);
    }),
  );
  assert.deepEqual([num("1.5"), num(0), count("3"), count(-1), count(1.5), time("2026-01-01T00:00:00Z"), time("soon"), time(null)], [1.5, 0, 3, null, null, Date.UTC(2026, 0, 1), null, null]);
});
