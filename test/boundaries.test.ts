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
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { Collector, endpoint, IDENTITY } from "../src/collect.ts";
import { AppConfig, parseConfig, type Source } from "../src/config.ts";
import { keyed } from "../src/inbox.ts";
import { Store, type Clean, type Writer } from "../src/store.ts";
import { clock } from "../src/clock.ts";
import { snapshot } from "../src/snapshot.ts";
import { Platform, run, withStore } from "./effect.ts";

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
  // The database, the configuration and a collector over them, alive until close().
  const runtime = ManagedRuntime.make(Collector.layer.pipe(Layer.provideMerge(Store.layer(dataDir)), Layer.provideMerge(AppConfig.layer(config)), Layer.provideMerge(Platform)));
  const go = <A>(effect: Effect.Effect<A, unknown, Collector | Store | AppConfig>) => runtime.runPromise(effect);
  let now = Date.UTC(2026, 10, 1), mono = 1e6;
  clock.set(now, mono);
  const ready = go(Collector.use((c) => c.setSpace({ freeBytes: 1024 ** 4, dbBytes: 0 })));
  return {
    get now() { return now; },
    async step() {
      await ready;
      now += 60_000; mono += 60_000; clock.set(now, mono);
      await go(Collector.use((c) => c.pass));
    },
    snap: () => go(Collector.use((c) => snapshot(c.view, true))),
    reading: (r: string) => go(Store.use((s) => s.get<{ state: string; ok_ms: number | null }>("SELECT state, ok_ms FROM readings WHERE reading = ?", r))),
    readingAt: () => go(Store.use((s) => s.get<{ at_ms: number }>("SELECT at_ms FROM readings"))),
    count: () => go(Store.use((s) => s.get<{ n: number }>("SELECT coalesce(sum(count), 0) AS n FROM incidents"))).then((r) => r!.n),
    close: () => runtime.dispose(),
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
      const m = await r.reading("monitors"), l = await r.reading("logs");
      const numericId = (x: unknown) => typeof x === "number" || (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)));
      if (m?.state === "ok") assert.ok(recognisedMonitors(monitors) && (monitors as Array<{ id: unknown }>).every((x) => typeof x.id === "number" || x.id !== ""), JSON.stringify(monitors));
      if (recognisedMonitors(monitors) && (monitors as Array<{ id: unknown }>).every((x) => numericId(x.id))) assert.equal(m?.state, "ok");
      const listed = !!logs && typeof logs === "object" && Array.isArray((logs as { data?: unknown }).data);
      if (l?.state === "ok") assert.ok(listed, JSON.stringify(logs));
      if (!listed) assert.notEqual(l?.state, "ok");
      seen[m?.state === "ok" ? "ok" : "gap"]++;
      await r.close();
    }),
    { numRuns: 60 },
  );
  assert.ok(seen.ok > 0 && seen.gap > 0, JSON.stringify(seen)); // both sides of the rule were exercised
});

test("class: monitors certify quiet only when every member is in a known measured state; any other state is a gap", async () => {
  const known = ["OK", "Alert", "Warn", "Ignored", "Skipped"];
  const state = fc.oneof(fc.constantFrom(...known), fc.constantFrom("Unknown", "No Data", "ok", "Paused", ""), fc.string({ maxLength: 8 }));
  await fc.assert(
    fc.asyncProperty(fc.array(state, { minLength: 1, maxLength: 5 }), async (states) => {
      const r = rig(["monitors"]);
      reply.monitors = states.map((overall_state, i) => ({ id: i + 1, name: `m${i}`, overall_state }));
      await r.step();
      assert.equal((await r.reading("monitors"))?.state === "ok", states.every((x) => known.includes(x)), JSON.stringify(states));
      if (!states.every((x) => known.includes(x))) assert.notEqual((await r.snap()).environments[0]!.health, "quiet");
      await r.close();
    }),
    { numRuns: 40 },
  );
});

test("class: a metric point is a measurement only inside the queried window, on either side", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: -3 * 60_000, max: 3 * 60_000 }), async (offset) => {
      const r = rig(["metrics"]);
      const end = r.now + 60_000;
      reply.query = { series: [{ metric: "shop.errors", pointlist: [[end + offset, 1]] }] };
      await r.step();
      assert.equal((await r.reading("metrics"))?.state === "ok", offset <= 0 && offset >= -60_000, String(offset));
      await r.close();
    }),
    { numRuns: 40 },
  );
});

test("class: freshness is the provider's observation time, never the time Overwatch asked", async () => {
  await fc.assert(
    fc.asyncProperty(fc.oneof(fc.integer({ min: 0, max: 60_000 }), fc.integer({ min: 60_001, max: 50 * 60_000 })), async (age) => {
      const r = rig(["metrics"]);
      reply.query = { series: [{ metric: "shop.errors", pointlist: [[r.now + 60_000 - age, 1]] }] };
      await r.step();
      // A point dated outside the queried window (one interval) proves nothing about it: a gap, never fresh.
      if (age > 60_000) {
        assert.equal((await r.reading("metrics"))?.state, "gap");
        assert.notEqual((await r.snap()).environments[0]!.health, "quiet");
        return r.close();
      }
      // Stored, and as every consumer sees it: the snapshot's reading age and the environment's health.
      assert.equal((await r.reading("metrics"))?.ok_ms, r.now - age);
      assert.equal((await r.readingAt())!.at_ms, r.now - age);
      const env = (await r.snap()).environments[0]!;
      assert.equal(env.readings[0]!.okMs, r.now - age);
      if (age > env.freshForMs) assert.equal(env.health, "stale");
      await r.close();
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
      assert.equal(await r.count(), expected, states.join(" → "));
      await r.close();
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

test("class: a receipt commits with its change or not at all, and a key binds one request forever", async () => {
  const keys = ["rk_" + "a".repeat(24), "rk_" + "b".repeat(24), "rk_" + "c".repeat(24)];
  await fc.assert(
    fc.asyncProperty(fc.array(fc.record({ key: fc.nat(2), subject: fc.nat(1), body: fc.nat(1), fails: fc.boolean() }), { maxLength: 12 }), (calls) =>
      run(withStore(scratch("ow-receipt-"), (store) => Effect.gen(function* () {
        clock.set(Date.UTC(2026, 10, 1), 1e6);
        const first = new Map<number, { subject: number; body: number; result: unknown }>();
        for (const c of calls) {
          const attempt = Effect.exit(keyed(keys[c.key], { op: "probe", subject: `s${c.subject}`, body: { b: c.body }, change: (w: Writer) => Effect.gen(function* () {
            const seq = yield* w.event("probe", null, { b: c.body });
            if (c.fails) return yield* Effect.fail({ _tag: "ChangeFailed" as const, message: "the change failed" });
            return { seq };
          }) }));
          const prior = first.get(c.key);
          const exit = yield* attempt;
          const error = Exit.isFailure(exit) ? (exit.cause.reasons[0] as { error?: { _tag: string; status?: number; message?: string } }).error : undefined;
          if (prior && (prior.subject !== c.subject || prior.body !== c.body)) assert.ok(error?._tag === "ApiError" && error.status === 409);
          else if (prior) assert.deepEqual(Exit.isSuccess(exit) ? exit.value : error, prior.result);
          else if (c.fails) assert.match(String(error?.message), /failed/);
          else if (Exit.isSuccess(exit)) first.set(c.key, { subject: c.subject, body: c.body, result: exit.value });
          else assert.fail(String(error?.message));
        }
        // Receipts and the changes they protect: equal in number, because they commit together.
        assert.equal((yield* store.get<{ n: number }>("SELECT count(*) AS n FROM requests"))!.n, first.size);
        assert.equal((yield* store.get<{ n: number }>("SELECT count(*) AS n FROM events WHERE kind = 'probe'"))!.n, first.size);
      }))),
    ),
  );
});

test("class: a writer kept past its transaction cannot write, so nothing writes without admission", () =>
  run(withStore(scratch("ow-writer-"), (store) => Effect.gen(function* () {
    let kept: Writer | null = null;
    yield* store.tx((w) => Effect.sync(() => void (kept = w)));
    const message = (e: Effect.Effect<unknown>) => Effect.map(Effect.exit(e), (x) => (Exit.isFailure(x) ? String((x.cause.reasons[0] as { defect?: unknown }).defect) : "wrote"));
    assert.match(yield* message(kept!.event("late", null, {})), /ended/);
    assert.match(yield* message(kept!.run("DELETE FROM events" as Clean)), /ended/);
    // The connection and the writer are not reachable from the store's shape.
    assert.equal(Object.keys(store).some((k) => /db|writer|sql/i.test(k)), false);
  }))));
