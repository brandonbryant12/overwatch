import { scratch } from "./scratch.ts";
/**
 * The two boundaries, one property per class. Observation: a reading is complete only when the adapter recognised the
 * reply; its freshness is the provider's observation time; a count is transitions, not a high-water mark. Receipts:
 * the receipt and its change commit together and a key binds one request; a writer cannot outlive its transaction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collector, endpoint, IDENTITY } from "../src/collect.ts";
import { parseConfig, type Source } from "../src/config.ts";
import { HttpError, keyed } from "../src/inbox.ts";
import { Store, type Clean, type Writer } from "../src/store.ts";
import { clock } from "../src/clock.ts";
import { snapshot } from "../src/snapshot.ts";

// A Datadog that answers whatever the property puts in `reply`.
const reply: { monitors: unknown; logs: unknown; query: unknown } = { monitors: [], logs: { data: [] }, query: { series: [] } };
const server = createServer((req, res) => {
  const path = req.url ?? "";
  const body = path.startsWith("/api/v1/monitor") ? reply.monitors : path.startsWith("/api/v2/logs") ? reply.logs : reply.query;
  req.resume();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
});
const base = await new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
process.env.OW_TEST_DD_A = "a";
process.env.OW_TEST_DD_B = "b";
test.after(() => server.close());

function rig(readings: string[]) {
  const dataDir = scratch("ow-boundary-");
  const config = parseConfig({
    version: 2, dataDir,
    apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { dd: { type: "datadog", baseUrl: base, apiKey: "env:OW_TEST_DD_A", appKey: "env:OW_TEST_DD_B", query: "service:shop", metric: "avg:shop.errors{*}", readings } } } } } },
    watchers: [{ app: "shop", environment: "prod", every: "1m" }],
  }, join(dataDir, "c.json"));
  const store = Store.own(dataDir);
  const collector = new Collector(store, config, dataDir);
  collector.setSpace({ freeBytes: 1024 ** 4, dbBytes: 0 });
  let now = Date.UTC(2026, 10, 1), mono = 1e6;
  clock.set(now, mono);
  return {
    store,
    get now() { return now; },
    async step() {
      now += 60_000; mono += 60_000; clock.set(now, mono);
      await collector.pass();
    },
    snap: () => snapshot(store, config, collector, true),
    reading: (r: string) => store.get<{ state: string; ok_ms: number | null }>("SELECT state, ok_ms FROM readings WHERE reading = ?", r),
    count: () => store.get<{ n: number }>("SELECT coalesce(sum(count), 0) AS n FROM incidents")!.n,
  };
}
const recognisedMonitors = (v: unknown) =>
  Array.isArray(v) && v.every((m) => m && typeof m === "object" && ["string", "number"].includes(typeof (m as Record<string, unknown>).id) && typeof (m as Record<string, unknown>).overall_state === "string");

test("class: a reading is complete only when the adapter recognised the reply; anything else is a gap", async () => {
  const seen = { ok: 0, gap: 0 };
  const shaped = fc.array(fc.record({ id: fc.oneof(fc.integer({ min: 1 }), fc.constant(null), fc.string()), name: fc.string(), overall_state: fc.oneof(fc.constantFrom("OK", "Alert", "Warn"), fc.constant(null), fc.integer()) }, { requiredKeys: [] }), { maxLength: 4 });
  await fc.assert(
    fc.asyncProperty(fc.oneof(fc.jsonValue({ maxDepth: 2 }), shaped), fc.oneof(fc.jsonValue({ maxDepth: 2 }), fc.constant({ data: [] })), async (monitors, logs) => {
      const r = rig(["monitors", "logs"]);
      reply.monitors = monitors;
      reply.logs = logs;
      await r.step();
      const m = r.reading("monitors"), l = r.reading("logs");
      const numericId = (x: unknown) => typeof x === "number" || (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)));
      if (m?.state === "ok") assert.ok(recognisedMonitors(monitors) && (monitors as Array<{ id: unknown }>).every((x) => typeof x.id === "number" || x.id !== ""), JSON.stringify(monitors));
      if (recognisedMonitors(monitors) && (monitors as Array<{ id: unknown }>).every((x) => numericId(x.id))) assert.equal(m?.state, "ok");
      const listed = !!logs && typeof logs === "object" && Array.isArray((logs as { data?: unknown }).data);
      if (l?.state === "ok") assert.ok(listed, JSON.stringify(logs));
      if (!listed) assert.notEqual(l?.state, "ok");
      seen[m?.state === "ok" ? "ok" : "gap"]++;
      r.store.close();
    }),
    { numRuns: 60 },
  );
  assert.ok(seen.ok > 0 && seen.gap > 0, JSON.stringify(seen)); // both sides of the rule were exercised
});

test("class: freshness is the provider's observation time, never the time Overwatch asked", async () => {
  await fc.assert(
    fc.asyncProperty(fc.oneof(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 60_001, max: 50 * 60_000 })), async (age) => {
      const r = rig(["metrics"]);
      reply.query = { series: [{ metric: "shop.errors", pointlist: [[r.now + 60_000 - age, 1]] }] };
      await r.step();
      // A point dated outside the queried window (one interval) proves nothing about it: a gap, never fresh.
      if (age > 60_000) {
        assert.equal(r.reading("metrics")?.state, "gap");
        assert.notEqual(r.snap().environments[0]!.health, "quiet");
        return r.store.close();
      }
      // Stored, and as every consumer sees it: the snapshot's reading age and the environment's health.
      assert.equal(r.reading("metrics")?.ok_ms, r.now - age);
      assert.equal(r.store.get<{ at_ms: number }>("SELECT at_ms FROM readings")!.at_ms, r.now - age);
      const env = r.snap().environments[0]!;
      assert.equal(env.readings[0]!.okMs, r.now - age);
      if (age > env.freshForMs) assert.equal(env.health, "stale");
      r.store.close();
    }),
    { numRuns: 25 },
  );
});

test("class: a monitor's count is its transitions into alerting, not the time it spent there", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom("OK", "Alert", "Warn", "No Data"), { minLength: 1, maxLength: 8 }), async (states) => {
      const r = rig(["monitors"]);
      let expected = 0, was = false;
      for (const state of states) {
        reply.monitors = [{ id: 7, name: "Checkout", overall_state: state }];
        await r.step();
        // No Data is not a measurement: it neither ends an alert nor starts one.
        if (state === "No Data") continue;
        const alerting = /^(alert|warn)/i.test(state);
        if (alerting && !was) expected++;
        was = alerting;
      }
      assert.equal(r.count(), expected, states.join(" → "));
      r.store.close();
    }),
    { numRuns: 40 },
  );
});

test("class: a new source kind inherits no identity and no endpoint", () => {
  fc.assert(
    fc.property(fc.string().filter((k) => !(k in IDENTITY)), (kind) => {
      assert.throws(() => endpoint({ kind } as unknown as Source));
    }),
  );
});

test("class: a receipt commits with its change or not at all, and a key binds one request forever", () => {
  const keys = ["rk_" + "a".repeat(24), "rk_" + "b".repeat(24), "rk_" + "c".repeat(24)];
  fc.assert(
    fc.property(fc.array(fc.record({ key: fc.nat(2), subject: fc.nat(1), body: fc.nat(1), fails: fc.boolean() }), { maxLength: 12 }), (calls) => {
      const store = Store.own(scratch("ow-receipt-"));
      clock.set(Date.UTC(2026, 10, 1), 1e6);
      const first = new Map<number, { subject: number; body: number; result: unknown }>();
      for (const c of calls) {
        const run = () => keyed(store, keys[c.key], { op: "probe", subject: `s${c.subject}`, body: { b: c.body }, change: (w: Writer) => {
          const seq = w.event("probe", null, { b: c.body });
          if (c.fails) throw new Error("the change failed");
          return { seq };
        } });
        const prior = first.get(c.key);
        if (prior && (prior.subject !== c.subject || prior.body !== c.body)) assert.throws(run, (e) => e instanceof HttpError && e.status === 409);
        else if (prior) assert.deepEqual(run(), prior.result);
        else if (c.fails) assert.throws(run, /failed/);
        else first.set(c.key, { subject: c.subject, body: c.body, result: run() });
      }
      // Receipts and the changes they protect: equal in number, because they commit together.
      assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM requests")!.n, first.size);
      assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM events WHERE kind = 'probe'")!.n, first.size);
      store.close();
    }),
  );
});

test("class: a writer kept past its transaction cannot write, so nothing writes without admission", () => {
  const store = Store.own(scratch("ow-writer-"));
  let kept: Writer | null = null;
  store.tx((w) => {
    kept = w;
  });
  assert.throws(() => kept!.event("late", null, {}), /ended/);
  assert.throws(() => kept!.run("DELETE FROM events" as Clean), /ended/);
  assert.equal(Object.keys(store).some((k) => /db|writer/i.test(k)), false);
  store.close();
});
