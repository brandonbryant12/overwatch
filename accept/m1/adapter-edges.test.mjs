import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { rig, trialRows } from "./rig.mjs"

for (const mode of ["registered", "configured"]) test("2.4.1 trial through " + mode + " Basic auth and location-scoped catalogs", async t => {
  const x = await rig(t)
  const password = "test-only-password"
  if (mode === "registered") {
    delete x.cfg.opencode.url
    fs.mkdirSync(x.dir("state/opencode"))
    fs.writeFileSync(x.dir("state/opencode/service.json"), JSON.stringify({ url: x.p.url, password }), { mode: 0o600 })
  } else {
    x.cfg.opencode.password = "env:FIXTURE_OC_PASS"
    x.env.FIXTURE_OC_PASS = password
  }
  x.save()
  x.world({ ocPassword: password })
  await x.start()
  const trial = await x.json("trial")
  assert.deepEqual([trial.valid, trial.correct, trial.peakSessions], [5, 5, 2])
  await x.json("doctor", [], 4) // no deployment has been collected
  for (const path of ["/api/agent", "/api/skill", "/api/mcp"])
    assert.ok(x.p.requests.some(r => r.path === path && r.query["location[directory]"] === x.dir("store/empty")), path)
  for (const s of x.p.sessions.values()) assert.deepEqual(s.model, { providerID: "fixture", id: "glm" })
  assert.ok(x.p.requests.some(r => r.path.endsWith("/message") && r.query.order === "desc"))
})

test("a passing trial for one model cannot enable another model after restart", async t => {
  const x = await rig(t)
  await x.start()
  assert.equal((await x.json("trial")).automation, true)
  await x.stop()
  x.cfg.opencode.model = "fixture/new-model"
  x.save()
  await x.start()
  assert.equal((await x.status()).automation, false)
})

for (const [label, change, id] of [
  ["registry refuses credentials", { registryStatus: 401 }, "proxy"],
  ["investigator has no enabled tools", { noAgentTools: true }, "agent"],
]) test("doctor reports failure when " + label, async t => {
  const x = await rig(t)
  x.world(change)
  await x.start()
  const report = await x.json("doctor", [], 4)
  const check = report.checks.find(c => c.id === id)
  assert.equal(check.ok, false, check.detail)
})

test("the five-minute deadline releases a non-filing, non-idle peer without waiting for it to answer", async t => {
  const x = await rig(t)
  const hold = Promise.withResolvers(), entered = Promise.withResolvers()
  let held = 0
  x.p.script = async () => {
    if (++held <= 2) { if (held === 2) entered.resolve(); await hold.promise }
    return "no filing"
  }
  await x.start()
  const trial = x.cli("trial")
  try {
    await Promise.race([entered.promise, trial.then(r => { throw Error("early exit " + r.code) })])
    await x.advance(300001, 0)
    for (let i = 0; i < 40 && !x.p.requests.some(r => r.path.endsWith("/interrupt")); i++) await delay(50)
    assert.ok(x.p.requests.some(r => r.path.endsWith("/interrupt")) || x.p.sessions.size > 2,
      "expired sessions still occupy both slots")
  } finally {
    hold.resolve()
    await trial
  }
})

test("demo reading renewal is fresh, isolated and has an explaining sequence", async t => {
  const x = await rig(t)
  await x.start("demo")
  const now = Date.now() + 3_600_000
  await x.control("clock", { nowMs: now, monoMs: 3_600_000 })
  const before = await x.status()
  await x.poll()
  const after = await x.status()
  assert.equal(after.environments.find(e => e.environment === "staging").health, "quiet")
  assert.equal(after.environments.find(e => e.environment === "qa").health, "signed_out")
  assert.equal(x.p.requests.length + x.calls().length, 0)
  assert.ok(after.seq > before.seq, "renewal changed health at the same sequence " + after.seq)
})

test("reconciliation and a concurrent trial request leave the two live drivers and queued jobs alone", async t => {
  const x = await rig(t)
  await x.start()
  const release = Promise.withResolvers(), entered = Promise.withResolvers()
  let started = 0
  const { expected, filing } = await import("./peers.mjs")
  x.p.script = async ({ id, tool }) => {
    if (++started === 2) entered.resolve()
    await release.promise
    const data = await tool("ow_telemetry", { source: "pods" })
    await tool("ow_finding", filing(expected[id], [data.pieces[0].handle]))
    return "filed"
  }
  const request = () => fetch(x.url + "/v2/trial", { method: "POST" }).then(r => r.json())
  const first = request()
  let second
  try {
    await Promise.race([entered.promise, first.then(() => { throw Error("trial ended before two sessions opened") })])
    second = request()
    await x.poll()
    const jobs = trialRows(await x.status()).jobs
    assert.deepEqual(jobs.map(j => j.state).sort(), ["queued", "queued", "queued", "running", "running"])
  } finally {
    release.resolve()
    await first
  }
  assert.deepEqual(await second, await first)
  assert.equal(x.p.sessions.size, 5)
  assert.equal(x.p.deliveries.length, 5)
})
