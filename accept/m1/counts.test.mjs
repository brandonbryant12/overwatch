import test from "node:test"
import assert from "node:assert/strict"
import fc from "fast-check"
import { rig, T, iso, stamp, total, byTitle } from "./rig.mjs"

test("multiset replay preserves nanoseconds, late siblings and container identity", async (t) => {
  const x = await rig(t)
  await x.start()
  const bags = fc.array(
    fc.tuple(
      fc.integer({ min: 0, max: 2 }),
      fc.constantFrom("alpha", "beta"),
      fc.integer({ min: 1, max: 4 }),
    ),
    { minLength: 1, maxLength: 6 },
  )
  let expected = 0,
    generation = 0
  await fc.assert(
    fc.asyncProperty(bags, async (bag) => {
      const time = iso(x.now() - 1).replace("Z", "00000")
      const lines = bag.flatMap(([ns, w, n]) =>
        Array.from({ length: n }, () => [time + ns + "Z", "ERROR " + w]),
      )
      // Monotonic independent generations, identical contents inside each generation.
      x.world({ restart: generation++, lines })
      await x.poll()
      expected += lines.length
      const count = (s) => total(s, "alpha") + total(s, "beta")
      assert.equal(count(await x.status()), expected)
      await x.advance(60000)
      x.world({ lines: [...lines].reverse().concat([[lines[0][0], "ERROR late"]]) })
      await x.poll()
      assert.equal(count(await x.status()), expected)
      assert.equal(total(await x.status(), "late"), generation)
      await x.stop("SIGKILL")
      await x.start()
      await x.advance(60000)
    }),
    { numRuns: 4, endOnFailure: true },
  )
})

test("Datadog pagination, overlap edges, old key pruning and cumulative Kubernetes events", async (t) => {
  const x = await rig(t, { both: true })
  const row = (id, time) => ({ id, time: iso(time), text: "ERROR ledger" })
  const first = ["a", "b", "c", "d", "e"].map((id) => row(id, T - 1000))
  const ev = (n) => ({
    metadata: { uid: "event-1", name: "event" },
    type: "Warning",
    reason: "BackOff",
    message: "BackOff fixture event",
    count: n,
    firstTimestamp: stamp,
    lastTimestamp: iso(x.now() - 1),
    involvedObject: { kind: "Pod", name: "shop-000" },
  })
  x.world({ ddLogs: first, events: [ev(3)] })
  await x.start()
  await x.poll()
  assert.equal(total(await x.status(), "ledger"), 5)
  const eventCount = (s) =>
    s.incidents.filter((i) => /backoff/i.test(i.title)).reduce((n, i) => n + i.count, 0)
  assert.equal(eventCount(await x.status()), 3)
  await x.advance(60000)
  x.world({ ddLogs: [...first, row("at", T - 300000), row("outside", T - 300001)], events: [ev(8)] })
  await x.poll()
  assert.equal(total(await x.status(), "ledger"), 6)
  assert.equal(eventCount(await x.status()), 8)
  await x.advance(7 * 60000)
  await x.poll()
  await x.advance(60000)
  await x.poll()
  assert.equal(total(await x.status(), "ledger"), 6)
  assert.equal(eventCount(await x.status()), 8)
  const watermark = (await x.status()).sources.find((s) => s.id.endsWith("/dd")).checkpointMs
  await x.stop()
  x.inspect((db) =>
    assert.equal(
      db.prepare("select count(*) as n from occurrences where at_ms < ?").get(watermark - 300000).n,
      0,
    ),
  )
})

test("rotation never inflates identical records; a cut log tail has no count", async (t) => {
  const x = await rig(t)
  const line = [stamp, "ERROR rotated"]
  x.world({ lines: [line, line, line] })
  await x.start()
  await x.poll()
  await x.advance(60000)
  x.world({ lines: [line], tail: stamp + " ERROR unfinished" })
  await x.poll()
  const s = await x.status()
  assert.equal(total(s, "rotated"), 3)
  assert.equal(total(s, "unfinished"), 0)
  assert.ok(s.coverage.some((c) => ["gap", "capped"].includes(c.state)))
  assert.notEqual(s.environments[0].health, "quiet")
})

test("six-hour catch-up slices leave a dated gap and never investigate unobserved time", async (t) => {
  const x = await rig(t, { both: true })
  delete x.cfg.apps.shop.environments.prod.sources.pods
  x.save()
  await x.start()
  await x.poll()
  const horizon = 14 * 86400000
  await x.advance(horizon + 86400000)
  await x.poll()
  let s = await x.status()
  for (let i = 0; i < 60 && s.sources.some((src) => src.checkpointMs < x.now()); i++) {
    await x.poll()
    s = await x.status()
  }
  const gap = s.coverage.find((c) => c.state === "gap" && c.fromMs <= T && c.toMs === x.now() - horizon)
  assert.ok(gap)
  assert.equal(gap.missed, null)
  assert.ok(s.sources.every((c) => c.checkpointMs === x.now()))
  const windows = x.p.requests.filter((q) => q.body.filter).map((q) => q.body.filter)
  assert.ok(windows.length >= 57)
  assert.ok(windows.every((q) => Date.parse(q.to) - Date.parse(q.from) <= 6 * 3600000 + 300000))
  assert.ok(s.jobs.filter((j) => j.state === "running").length <= 2)
})

for (const [label, patch, count, exact] of [
  ["50,000", { pods: 10, burst: { count: 50000, stamp } }, 50000, true],
  ["250,000", { pods: 20, burst: { count: 250000, stamp } }, 50000, false],
  [
    "4 MiB",
    { lines: [[stamp, "ERROR boundary"]], tail: stamp + " ERROR trailing " + "z".repeat(4 * 1024 * 1024) },
    1,
    null,
  ],
])
  test(
    label + " per window; replay cannot inflate an admitted prefix",
    { skip: !process.env.M1_LONG },
    async (t) => {
      const x = await rig(t)
      x.world(patch)
      await x.start()
      await x.poll()
      for (let i = 0; i < 2; i++) {
        const s = await x.status(),
          inc = byTitle(s, exact === null ? "boundary" : "storm")
        assert.equal(inc.length, 1)
        assert.equal(inc[0].count, count)
        if (exact !== null) assert.equal(Boolean(inc[0].exact), exact)
        assert.equal(
          s.coverage.some((c) => c.state === "capped"),
          exact !== true,
        )
        assert.equal(total(s, "trailing"), 0)
        assert.equal(s.sources[0].checkpointMs, x.now())
        if (i === 0) {
          await x.advance(60000)
          await x.poll()
        }
      }
    },
  )

test("501st problem folds into one overflow row, 21st pod marks coverage partial", async (t) => {
  const x = await rig(t)
  x.world({ pods: 1, burst: { count: 517, stamp, distinct: true } })
  await x.start()
  await x.poll()
  let s = await x.status()
  assert.equal(s.incidents.length, 501)
  assert.equal(total(s, "many other errors"), 17)
  assert.equal(
    s.incidents.reduce((a, i) => a + i.count, 0),
    517,
  )
  const calls = x.calls().length
  await x.advance(60000)
  x.world({ pods: 21, burst: null })
  await x.poll()
  s = await x.status()
  assert.ok(s.coverage.some((c) => c.state === "capped"))
  assert.notEqual(s.environments[0].health, "quiet")
  assert.equal(
    new Set(
      x
        .calls()
        .slice(calls)
        .filter((c) => c.args.includes("logs"))
        .map((c) => c.args[c.args.indexOf("logs") + 1]),
    ).size,
    20,
  )
})

test("pod reuse, full timestamps and inclusive Kubernetes overlap do not merge or recount rows", async (t) => {
  const x = await rig(t)
  const dup = [iso(T - 1), "ERROR identical"]
  // Same names, same time and bytes, independent physical pods.
  x.world({
    pods: 2,
    lines: [
      [...dup, 0],
      [...dup, 1],
    ],
  })
  await x.start()
  await x.poll()
  assert.equal(total(await x.status(), "identical"), 2)
  await x.advance(60000)
  x.world({
    restart: 1,
    previous: [
      [...dup, 0],
      [...dup, 1],
    ],
    lines: [
      [...dup, 0],
      [...dup, 1],
      [iso(T - 120000), "ERROR admitted"],
      [iso(T - 120001), "ERROR rejected"],
    ],
  })
  await x.poll()
  const s = await x.status()
  assert.equal(total(s, "identical"), 4)
  assert.equal(total(s, "admitted"), 1)
  assert.equal(total(s, "rejected"), 0)
  await x.advance(60000)
  x.world({
    podUIDPrefix: "replacement-",
    restart: 0,
    previous: [],
    lines: [
      [...dup, 0],
      [...dup, 1],
    ],
  })
  await x.poll()
  assert.equal(total(await x.status(), "identical"), 6)
})

test("Datadog monitor and metric responses reach the service snapshot", async (t) => {
  const x = await rig(t, { both: true })
  x.world({
    monitors: [
      {
        id: 17,
        name: "checkout availability",
        overall_state: "Alert",
        query: "avg(last_5m):avg:shop.errors{*} > 1",
        message: "fixture alert",
        tags: ["service:shop"],
      },
    ],
  })
  await x.start()
  await x.poll()
  const s = await x.status()
  assert.ok(s.incidents.some((i) => i.title.toLowerCase().includes("checkout availability")))
  assert.ok(
    s.metrics.some((m) => m.source === "shop/prod/dd" && m.name.includes("shop.errors") && m.value === 1),
  )
  assert.notEqual(s.environments[0].health, "quiet")
  assert.ok(
    s.coverage.some((c) => c.source === "shop/prod/dd" && c.reading === "monitors" && c.state === "ok"),
  )
})
