import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { rig, iso, stamp, total, T } from "./rig.mjs"
import { filing, expected } from "./peers.mjs"

const minute = 60000, day = 86400000
async function source(t, kind, readings, patch = {}) {
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
async function sample(x, patch, elapsed = minute, wall = elapsed) {
  x.world(patch)
  await x.advance(elapsed, wall)
  await x.poll()
  return x.status()
}
test("N01 an overflowing numeric string is not a measured Datadog sample", async t => {
  const x = await source(t, "dd", ["metrics"], { ddValue: "1e999" })
  const s = await x.status()
  assert.deepEqual([s.metrics.length, s.environments[0].health === "quiet"], [0, false])
})
test("N02 a failed retrial of the approved model revokes approval across restart", async t => {
  const x = await rig(t)
  await x.start()
  assert.ok((await x.json("trial")).automation)
  x.p.mode = "wrong"
  assert.equal((await x.json("trial", [], 4)).automation, false)
  await x.stop(); await x.start()
  assert.equal((await x.status()).automation, false)
})
test("N03 a fresh record on the same stream survives saturated overlap and SIGKILL", { skip: !process.env.M1_LONG }, async t => {
  const x = await source(t, "pods", ["logs"], { burst: { count: 50001, stamp } })
  await x.stop("SIGKILL"); await x.start()
  const s = await sample(x, { burst: null, lines: [[iso(T + 1000), "ERROR fresh"]] })
  assert.deepEqual([total(s, "storm"), total(s, "fresh")], [50000, 1])
})
test("N04 a failed canary interrupts two otherwise good recovery samples", async t => {
  const x = await source(t, "pods", ["usage"], { memory: "500Mi" })
  assert.ok((await sample(x, {})).metrics[0].breach)
  await sample(x, { memory: "100Mi" })
  await sample(x, { kubeFailure: "unreachable" })
  assert.equal((await sample(x, { kubeFailure: null })).metrics[0].breach, true)
})
test("N05 deprecatedCount survives lower legacy values and repeats", async t => {
  const event = n => ({ metadata: { uid: "migrating" }, type: "Warning", reason: "Mount", deprecatedCount: n, count: 1, eventTime: stamp })
  const x = await source(t, "pods", ["events"], { events: [event(4)] })
  await sample(x, { events: [event(2)] })
  assert.equal(total(await sample(x, { events: [event(8)] }), "mount"), 8)
})
test("N06 missing previous identity leaves current logs countable at a lower bound", async t => {
  const x = await source(t, "pods", ["logs"], { restart: 2, lostPrevious: true, lines: [[stamp, "ERROR current"]] })
  const s = await x.status()
  assert.deepEqual([s.coverage.at(-1).state, s.incidents[0].count, s.incidents[0].exact], ["gap", 1, false])
})
test("N07 identifiable partial Datadog page makes the active total a lower bound", async t => {
  const good = { id: "known", time: stamp, text: "ERROR checkout" }
  const x = await source(t, "dd", ["logs"], { ddLogs: [good] })
  const s = await sample(x, { ddLogs: [good, { time: iso(T + 1), text: good.text }] })
  assert.deepEqual([s.coverage.at(-1).state, s.incidents[0].exact], ["gap", false])
})
test("N08 a failed pending read also honors the disk floor before its failure commit", async t => {
  const x = await source(t, "dd", ["logs"])
  const before = (await x.status()).seq
  await x.advance(minute)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  x.p.holdDD = { started: entered, promise: release.promise }
  x.world({ ddRate: true, retryAfter: 31 })
  const poll = x.poll()
  try { await entered.promise; await x.control("space", { freeBytes: 1, dbBytes: 1000 }) }
  finally { release.resolve(); await poll }
  const s = await x.status()
  assert.deepEqual([s.paused, s.seq - before, s.sources[0].checkpointMs], ["disk", 0, T])
})
test("N09 old trial collection retains every previously cited evidence handle under pressure", async t => {
  const x = await rig(t); await x.start(); await x.json("trial")
  const handles = (await x.status()).trial.findings.flatMap(f => f.claims.flatMap(c => c.pieces.map(p => p.handle)))
  assert.ok(handles.length >= 5)
  await x.advance(8 * day)
  await x.control("space", { freeBytes: 2 ** 30, dbBytes: 2 ** 30 + 1 })
  await x.poll(); await x.stop()
  const kept = x.inspect(db => new Set(db.prepare("SELECT handle FROM evidence").all().map(r => r.handle)))
  assert.equal(handles.filter(h => kept.has(h)).length, handles.length)
})
test("N10 Datadog confirmed sign-in suspension probes on elapsed time after restart", async t => {
  const x = await source(t, "dd", ["logs"], { ddFailure: 401 })
  assert.equal((await sample(x, {})).sources[0].suspended, true)
  await x.advance(0, -day); await x.stop(); await x.start(); await x.poll()
  assert.equal((await sample(x, { ddFailure: null }, 5 * minute, 0)).sources[0].failure, null)
})
test("N11 restore checks hourly rows against existing incidents", async t => {
  const x = await source(t, "pods", ["logs"], { lines: [[stamp, "ERROR saved"]] })
  const file = x.dir("copy.db"), before = await x.json("backup", ["--to", file])
  await x.stop()
  const db = new DatabaseSync(file)
  try { db.prepare("update hourly set incident=?").run("inc_orphan") } finally { db.close() }
  const r = await x.cli("restore", ["--from", file])
  assert.equal(r.code, 5, r.out)
  assert.equal((await x.json("status")).seq, before.seq)
})
test("N12 replacement attempts finish while both expired peer sessions remain busy", async t => {
  const x = await rig(t); await x.start()
  const release = Promise.withResolvers(), entered = Promise.withResolvers()
  let n = 0
  x.p.script = async ({ id, tool }) => {
    if (++n <= 2) { if (n === 2) entered.resolve(); await release.promise; return "late" }
    const data = await tool("ow_telemetry", { source: "pods" })
    await tool("ow_finding", filing(expected[id], [data.pieces[0].handle]))
    return "filed"
  }
  const trial = x.cli("trial")
  try {
    await Promise.race([entered.promise, trial.then(() => assert.fail("early termination"))])
    await x.advance(300000, 0)
    const r = await trial
    assert.equal(r.code, 0, r.err + r.out)
    assert.equal(JSON.parse(r.out).valid, 5)
    assert.equal(x.p.sessions.size, 7)
  } finally { release.resolve() }
})
test("N13 a monitor currently warning after alert no longer keeps error health active", async t => {
  const monitor = state => ({ id: 17, name: "latency", overall_state: state })
  const x = await source(t, "dd", ["monitors"], { monitors: [monitor("Alert")] })
  const s = await sample(x, { monitors: [monitor("Warn")] })
  assert.deepEqual([s.incidents.length, s.incidents[0].severity, s.environments[0].health], [1, "warn", "quiet"])
})
test("N14 shared Datadog site and api key with different application credentials recover independently", async t => {
  const x = await rig(t, { both: true })
  const sources = x.cfg.apps.shop.environments.prod.sources
  delete sources.pods
  sources.dd.readings = ["logs"]
  sources.other = { ...sources.dd, appKey: "env:OTHER_APP_KEY" }
  x.env.OTHER_APP_KEY = "valid-fixture"
  x.world({ refusedAppKey: x.env.DD_APP_KEY }); x.save(); await x.start(); await x.poll()
  const s = await x.status()
  assert.deepEqual(s.sources.map(r => r.failure), ["signin", null])
})
test("N15 registry server error fails its own check with the status", async t => {
  const x = await rig(t); x.world({ registryStatus: 503 }); await x.start()
  const d = (await x.json("doctor", [], 4)).checks.find(c => c.id === "proxy")
  assert.equal(d.ok, false); assert.match(d.detail, /503/)
})
test("N16 doctor notices a final denial of just the filing tool", async t => {
  const x = await rig(t)
  const rules = [{ action: "*", resource: "*", effect: "deny" }, { action: "ow_ow_*", resource: "*", effect: "allow" }, { action: "ow_ow_finding", resource: "*", effect: "deny" }]
  x.world({ agentRules: rules }); await x.start()
  const d = (await x.json("doctor", [], 4)).checks.find(c => c.id === "agent")
  assert.equal(d.ok, false); assert.match(d.detail, /finding/)
})
test("N17 Datadog catch-up clips its wider overlap at the fourteen-day floor", async t => {
  const x = await source(t, "dd", ["logs"])
  const s = await sample(x, { ddLogs: [{ id: "old", text: "ERROR old", time: iso(T + minute - 1) }, { id: "due", text: "ERROR due", time: iso(T + minute) }] }, 14 * day + minute)
  assert.deepEqual([total(s, "old"), total(s, "due")], [0, 1])
})
test("N18 Datadog inclusive vendor end is deferred exactly once across restart", async t => {
  const x = await source(t, "dd", ["logs"], { ddLogs: [{ id: "edge", time: iso(T), text: "ERROR exact" }] })
  assert.equal(total(await x.status(), "exact"), 0); await x.stop(); await x.start()
  assert.equal(total(await sample(x, {}), "exact"), 1)
  assert.equal(total(await sample(x, {}), "exact"), 1)
})
test("N19 Datadog repair survives restart and clears upon recovery", async t => {
  const x = await source(t, "dd", ["logs"], { ddFailure: 401 })
  await x.stop(); await x.start()
  assert.match((await x.status()).sources[0].fix, /DD_APP_KEY/)
  assert.equal((await sample(x, { ddFailure: null })).sources[0].fix, null)
})
test("N21 demo renewal after backward wall jump leaves history ordered and QA signed out", async t => {
  const x = await rig(t); await x.start("demo"); await x.poll()
  const before = await x.status(); await x.advance(minute, -day); await x.poll()
  const after = await x.status()
  assert.ok(after.seq > before.seq)
  assert.equal(after.environments.find(e => e.environment === "qa").health, "signed_out")
  assert.equal(x.calls().length + x.p.requests.length, 0)
})

test("shared provider IDs remain independent for both apps across SIGKILL and replay", async t => {
  const x = await rig(t, { both: true }), sources = x.cfg.apps.shop.environments.prod.sources
  sources.dd.readings = ["logs"]; sources.pods.readings = ["logs", "events"]
  x.cfg.apps.other = structuredClone(x.cfg.apps.shop)
  x.cfg.watchers.push({ ...x.cfg.watchers[0], app: "other" }); x.save()
  x.world({
    lines: [[stamp, "ERROR ledger"]], ddLogs: [{ id: "same", time: stamp, text: "ERROR checkout" }],
    events: [{ metadata: { uid: "common" }, count: 4, type: "Warning", reason: "Mount", message: "mounting", lastTimestamp: stamp }]
  })
  await x.start(); await x.poll(); await x.stop("SIGKILL"); await x.start(); await x.advance(minute); await x.poll()
  const s = await x.status()
  for (const app of ["shop", "other"]) {
    assert.deepEqual(s.incidents.filter(i => i.app === app).map(i => i.count).sort(), [1, 1, 4])
    assert.ok(s.coverage.filter(c => c.source.startsWith(app + "/")).every(c => c.state === "ok"))
  }
})
