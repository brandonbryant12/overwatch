import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { rig, iso, stamp, T, total } from "./rig.mjs"
import { api, act } from "../m2/api.mjs"
import { service, model, investigate, finished, send } from "../m3/rig.mjs"

const minute = 60000,
  day = 86400000
async function source(t, kind, readings, patch) {
  const x = await rig(t, { both: true })
  const sources = x.cfg.apps.shop.environments.prod.sources
  delete sources[kind === "dd" ? "pods" : "dd"]
  sources[kind].readings = readings
  x.save()
  x.world(patch)
  await x.start()
  await x.poll()
  return x
}
async function step(x, patch = {}, elapsed = minute, wall = elapsed) {
  x.world(patch)
  await x.advance(elapsed, wall)
  await x.poll()
  return x.status()
}
async function restoreWith(x, sql) {
  const file = x.dir("detached.sqlite")
  const before = await x.json("backup", ["--to", file])
  await x.stop()
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  try {
    assert.ok(db.prepare(sql).run().changes > 0)
  } finally {
    db.close()
  }
  const r = await x.cli("restore", ["--from", file])
  assert.equal(r.code, 5, r.out)
  assert.equal((await x.json("status")).seq, before.seq)
}
const monitor = (state) => [{ id: 8, name: "Lag", overall_state: state }]
const log = (id, at, text) => ({ id, time: iso(at), text: "ERROR " + text })

test("A01 a boolean metric between two numeric points is a coverage gap", async (t) => {
  const x = await source(t, "dd", ["metrics"], { ddValue: 4 })
  const s = await step(x, { ddValue: false })
  assert.deepEqual([s.metrics[0].value, s.coverage.at(-1).state], [4, "gap"])
  assert.equal((await step(x, { ddValue: 0 })).metrics[0].value, 0)
})
test("A02 switching back to a previously revoked model does not inherit a second model's pass", async (t) => {
  const x = await rig(t)
  await x.start()
  x.p.mode = "wrong"
  assert.equal((await x.json("trial", [], 4)).automation, false)
  await x.stop()
  x.cfg.opencode.model = "fixture/other"
  x.save()
  await x.start()
  x.p.mode = "correct"
  assert.ok((await x.json("trial")).automation)
  await x.stop()
  x.cfg.opencode.model = "fixture/glm"
  x.save()
  await x.start()
  assert.equal((await x.status()).automation, false)
})
test(
  "A03 first record exactly at saturated slice end is counted in the next slice",
  { skip: !process.env.M1_LONG },
  async (t) => {
    const x = await source(t, "pods", ["logs"], { burst: { count: 50001, stamp } })
    const s = await step(x, { burst: null, lines: [[iso(T), "ERROR boundary"]] })
    assert.deepEqual([total(s, "storm"), total(s, "boundary")], [50000, 1])
  },
)
test("A04 a failed pass breaks the opening streak as well as recovery", async (t) => {
  const x = await source(t, "pods", ["usage"], { memory: "500Mi" })
  await step(x, { kubeFailure: "network unreachable" })
  const s = await step(x, { kubeFailure: null })
  assert.equal(s.metrics[0].breach, false)
  assert.equal((await step(x)).metrics[0].breach, true)
})
test("A05 two event UIDs with the same reason change counter formats independently", async (t) => {
  const e = (uid, fields) => ({
    metadata: { uid },
    type: "Warning",
    reason: "Backoff",
    message: "worker",
    eventTime: stamp,
    ...fields,
  })
  const x = await source(t, "pods", ["events"], {
    events: [e("a", { series: { count: 4 } }), e("b", { count: 2 })],
  })
  const s = await step(x, { events: [e("a", { deprecatedCount: 5 }), e("b", { series: { count: 3 } })] })
  assert.equal(total(s, "backoff"), 8)
})
test("A06 known previous identity reappears after a gap without certifying prior counts", async (t) => {
  const x = await source(t, "pods", ["logs"], {
    restart: 1,
    lostPrevious: true,
    lines: [[stamp, "ERROR current"]],
  })
  const s = await step(x, { lostPrevious: false, previous: [[stamp, "ERROR older"]] })
  assert.deepEqual(
    [total(s, "current"), total(s, "older"), s.incidents.find((i) => i.title.includes("current")).exact],
    [1, 1, false],
  )
})
test("A07 a monitor without an ID makes the reading incomplete even beside a valid monitor", async (t) => {
  const x = await source(t, "dd", ["monitors"], {
    monitors: [...monitor("OK"), { name: "Unknown", overall_state: "Alert" }],
  })
  assert.deepEqual(
    (await x.status()).coverage.map((c) => c.state),
    ["gap"],
  )
})
test("A08 investigating manually below the reserve creates no job", async (t) => {
  const x = await service(t)
  await x.control("space", { freeBytes: 1, dbBytes: 1 })
  const before = await x.status()
  await send(x, "items/" + x.subject + "/investigate", {}, 503)
  assert.deepEqual((await x.status()).jobs, before.jobs)
})
test("A09 the challenger's cited material remains after the real evidence horizon and restart", async (t) => {
  const x = await service(t, { readings: 1 })
  model(x, ["real"])
  const j = await finished(x, (await investigate(x)).jobId)
  const h = j.result.challenge.pieces[0].handle
  await x.advance(15 * day)
  await x.poll()
  await x.stop()
  assert.ok(x.inspect((db) => db.prepare("select 1 from evidence where handle=?").get(h)))
  await x.start()
  assert.equal((await api(x, "jobs/" + j.id)).result.challenge.pieces[0].handle, h)
})
test("A10 a rate refusal recovers on the persisted elapsed delay after a rollback", async (t) => {
  const x = await source(t, "dd", ["logs"], { ddRate: true, retryAfter: 32 })
  assert.equal((await x.status()).sources[0].failure, "rate")
  await x.advance(0, -day)
  await x.stop()
  await x.start()
  const s = await step(x, { ddRate: false }, minute, 0)
  assert.equal(s.sources[0].failure, null)
})
test("A11 restore rejects a work row referencing a nonexistent run", async (t) => {
  const x = await service(t, { readings: 1 })
  model(x, ["not_real"])
  await finished(x, (await investigate(x)).jobId)
  await restoreWith(x, "update work set run_id='absent' where run_id is not null")
})
test("A12 an expired manual reading releases its slot for an owner reply", async (t) => {
  const x = await service(t, { readings: 2 })
  const held = Promise.withResolvers()
  let busy = 0
  x.p.workScript = async ({ s }) => {
    if (s.agent === "ow-responder") return "Ready"
    if (++busy <= 2) await held.promise
    return "No filing"
  }
  try {
    await investigate(x)
    const { until, job } = await import("../m3/rig.mjs")
    await until(x, () => busy === 2, "two readers did not start")
    const q = await send(x, "ask", { subject: x.subject, text: "Report state", mode: "new" })
    await x.advance(300001, 0)
    await until(
      x,
      async () => (await job(x, q.jobId)).turns[0]?.answer === "Ready",
      "answer blocked by expired readers",
    )
  } finally {
    held.resolve()
  }
})
test("A13 Alert to Warn to Alert restores error urgency", async (t) => {
  const x = await source(t, "dd", ["monitors"], { monitors: monitor("Alert") })
  await step(x, { monitors: monitor("Warn") })
  const s = await step(x, { monitors: monitor("Alert") })
  assert.deepEqual([s.incidents[0].severity, s.environments[0].health], ["error", "attention"])
})
test("A14 a refusal on one adapter leaves the other adapter in the same watcher readable", async (t) => {
  const x = await rig(t, { both: true })
  x.world({ kubeFailure: "Unauthorized", ddLogs: [log("one", T - 1, "receipt")] })
  await x.start()
  await x.poll()
  assert.equal(total(await x.status(), "receipt"), 1)
})
test("A15 a registry throttle names its status and offers a repair", async (t) => {
  const x = await rig(t)
  x.world({ registryStatus: 429 })
  await x.start()
  const c = (await x.json("doctor", [], 4)).checks.find((c) => c.id === "proxy")
  assert.equal(c.ok, false)
  assert.match(c.detail, /429/)
  assert.ok(c.fix)
})
test("A16 doctor must distinguish an available investigator from missing M3 roles", async (t) => {
  const x = await rig(t)
  await x.start()
  const cs = (await x.json("doctor", [], 4)).checks
  assert.ok(
    cs.some((c) => !c.ok && /challenger|responder/i.test(c.detail + " " + c.fix)),
    "no missing-role diagnosis",
  )
})
test("A17 floor and same-timestamp duplicate IDs across three Datadog pages", async (t) => {
  const x = await source(t, "dd", ["logs"], {})
  const floor = T + minute
  const records = [
    log("past", floor - 1, "past"),
    ...["a", "b", "b", "c", "c"].map((id) => log(id, floor, "due")),
  ]
  const s = await step(x, { ddLogs: records }, 14 * day + minute)
  assert.deepEqual([total(s, "past"), total(s, "due")], [0, 3])
})
test("A18 two distinct IDs on a six-hour internal boundary survive inclusive vendor pages", async (t) => {
  const x = await source(t, "dd", ["logs"], {})
  const at = T + 6 * 3600000
  const s = await step(x, { ddLogs: [log("a", at, "edge"), log("b", at, "edge")] }, 6 * 3600000 + minute)
  assert.equal(total(s, "edge"), 2)
  assert.equal(total(await step(x), "edge"), 2)
})
test("A19 a changed failure kind replaces its obsolete credential repair", async (t) => {
  const x = await source(t, "dd", ["logs"], { ddFailure: 401 })
  const s = await step(x, { ddFailure: null, ddRate: true, retryAfter: 33 })
  assert.equal(s.sources[0].failure, "rate")
  assert.doesNotMatch(s.sources[0].fix, /DD_APP_KEY/)
})
test("A21 demo renewals preserve an owner's disposition and advance the stream", async (t) => {
  const x = await rig(t)
  await x.start("demo")
  const before = await x.status()
  const id = before.incidents.find((i) => i.active && !i.way).id
  await act(x, id, { action: "never" })
  const a = await x.status()
  await x.advance(7 * day)
  await x.poll()
  const b = await x.status()
  assert.ok(b.seq > a.seq)
  assert.equal(b.incidents.find((i) => i.id === id).way.kind, "never")
  assert.equal(x.calls().length + x.p.requests.length, 0)
})

test("B01 a previous-window Datadog sample cannot refresh the strip indefinitely", async (t) => {
  const x = await source(t, "dd", ["metrics"], { ddPointTime: T })
  const s = await step(x, {}, 4 * minute)
  assert.notEqual(s.environments[0].health, "quiet", "quiet over four-minute-old point")
})
test("B04 a partial fleet sample between two high readings breaks the opening streak across restart", async (t) => {
  const x = await source(t, "pods", ["usage"], { pods: 2, memory: "500Mi" })
  assert.equal((await step(x, { usagePods: 1 })).coverage.at(-1).state, "gap")
  await x.stop()
  await x.start()
  assert.equal((await step(x, { usagePods: 2 })).metrics[0].breach, false)
  assert.equal((await step(x)).metrics[0].breach, true)
})
test("B07 an unexpected log response envelope cannot count as a complete empty window", async (t) => {
  const x = await source(t, "dd", ["logs"], { ddLogEnvelope: { status: "unknown" } })
  assert.equal((await x.status()).coverage.at(-1).state, "gap")
})
test("B08 a correction refused for space can subsequently be retried once", async (t) => {
  const x = await service(t, { readings: 1 })
  model(x, ["not_real"])
  const { id: jobId } = await finished(x, (await investigate(x)).jobId)
  const path = "items/" + x.subject + "/corrections",
    body = { jobId, text: "A dated note" }
  const { requestKey } = await api(x, "focus?subject=" + x.subject)
  await x.control("space", { freeBytes: 1, dbBytes: 1 })
  await send(x, path, body, 503, x.subject, requestKey)
  await x.control("space", { freeBytes: 2 ** 30, dbBytes: 1000 })
  await send(x, path, body, 200, x.subject, requestKey)
  assert.equal((await api(x, "items/" + x.subject)).corrections.length, 1)
})
test("B09 backup after expiry and restore preserves the challenger's cited object", async (t) => {
  const x = await service(t, { readings: 1 })
  model(x, ["real"], { challenge: "disproved" })
  const j = await finished(x, (await investigate(x)).jobId)
  const h = j.result.challenge.pieces[0].handle
  await x.advance(16 * day)
  await x.poll()
  const f = x.dir("retained.db")
  await x.json("backup", ["--to", f])
  await x.stop()
  await x.json("restore", ["--from", f])
  assert.ok(x.inspect((db) => db.prepare("select 1 from citations where handle=?").get(h)))
})
test("B11 restore rejects a notification for an incident that never existed", async (t) => {
  const x = await service(t)
  await restoreWith(x, "update notifications set subject='inc_missing'")
})
test("B13 an OK to Alert recurrence counts a new monitor transition", async (t) => {
  const x = await source(t, "dd", ["monitors"], { monitors: monitor("Alert") })
  for (let n = 0; n < 3; n++) await step(x, { monitors: monitor("OK") })
  const s = await step(x, { monitors: monitor("Alert") })
  assert.deepEqual([s.incidents[0].active, s.incidents[0].count], [true, 2])
})
test("B14 two Datadog sources differing only by query share a credential refusal", async (t) => {
  const x = await rig(t, { both: true })
  const sources = x.cfg.apps.shop.environments.prod.sources
  delete sources.pods
  sources.dd.readings = ["logs"]
  sources.second = { ...sources.dd, query: "service:other" }
  x.save()
  x.world({ ddFailure: 403 })
  await x.start()
  await x.poll()
  assert.deepEqual(
    (await x.status()).sources.map((s) => s.failure),
    ["signin", "signin"],
  )
  assert.equal(x.p.requests.filter((r) => r.path.includes("logs/events/search")).length, 1)
})
