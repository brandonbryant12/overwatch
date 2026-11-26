// One neighbour of each test the milestone 3 assessment left red (31), each different from the probes already in
// accept/ and test/real/. Through the real executable, fixture peers and (for the page) system Chrome.
// Manual, outside `pnpm run check`:  node --no-warnings --test --test-concurrency=2 test/real/assessment-probes.mjs
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { rig, iso, T } from "../../accept/m1/rig.mjs"
import { filing } from "../../accept/m1/peers.mjs"
import { api, act, item } from "../../accept/m2/api.mjs"
import { browser, binary } from "../../accept/m2/chrome.mjs"
import { service, model, send, finished, investigate, until } from "../../accept/m3/rig.mjs"

const minute = 60000, day = 86400000
const optional = { skip: binary ? false : "no Chrome" }
async function source(t, kind, readings, patch) {
  const x = await rig(t, { both: true }), s = x.cfg.apps.shop.environments.prod.sources
  delete s[kind === "dd" ? "pods" : "dd"]
  s[kind].readings = readings
  x.save(); x.world(patch); await x.start(); await x.poll()
  return x
}
async function step(x, patch = {}, elapsed = minute, wall = elapsed) {
  x.world(patch); await x.advance(elapsed, wall); await x.poll()
  return x.status()
}
async function refusedRestore(x, sql) {
  const file = x.dir("probe.sqlite"), before = await x.json("backup", ["--to", file])
  await x.stop()
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  try { assert.ok(db.prepare(sql).run().changes > 0, sql) } finally { db.close() }
  const r = await x.cli("restore", ["--from", file])
  assert.equal(r.code, 5, r.out)
  await x.start()
  assert.equal((await x.json("status")).seq, before.seq)
}
const monitor = (state, extra = {}) => [{ id: 9, name: "Queue", overall_state: state, ...extra }]
const header = (b) => b.evaluate("document.querySelector('[data-verdict] header').innerText")
async function openFocused(b, x, word = "checkout") {
  await b.visit(x.url + "/"); await b.wait("!!document.querySelector('[data-connection=live]')")
  await b.key("/"); await b.type(word); await b.wait("!!document.querySelector('[data-result-id]')"); await b.key("Enter")
}

// ---- m1: observation
test("A07' a monitor with an ID but no state makes the reading incomplete beside a valid monitor", async (t) => {
  const x = await source(t, "dd", ["monitors"], { monitors: [...monitor("OK"), { id: 10, name: "Stateless" }] })
  assert.deepEqual((await x.status()).coverage.map((c) => c.state), ["gap"])
})
test("A10' a rate refusal persisted across two restarts after a rollback still recovers on elapsed time", async (t) => {
  const x = await source(t, "dd", ["logs"], { ddRate: true, retryAfter: 40 })
  await x.advance(0, -day); await x.stop(); await x.start(); await x.stop(); await x.start()
  assert.equal((await step(x, { ddRate: false }, minute, 0)).sources[0].failure, null)
})
test("A11' restore rejects a work row naming a job that does not exist", async (t) => {
  const x = await service(t, { readings: 1 }); model(x, ["not_real"])
  await finished(x, (await investigate(x)).jobId)
  await refusedRestore(x, "update work set job_id='job_absent'")
})
test("A16' doctor names each missing role with its own repair", async (t) => {
  const x = await rig(t); await x.start()
  const cs = (await x.json("doctor", [], 4)).checks
  for (const role of ["challenger", "responder"]) {
    const c = cs.find((c) => c.id === "agent:" + role)
    assert.ok(c && !c.ok && c.fix.includes("ow-" + role), role)
  }
})
test("B01' a provider sample that keeps up with time keeps the strip quiet over the same four minutes", async (t) => {
  const x = await source(t, "dd", ["metrics"], {})
  let s
  for (let i = 0; i < 4; i++) s = await step(x, { ddPointTime: x.now() + minute })
  assert.equal(s.environments[0].health, "quiet")
})
test("B07' a log envelope whose data is not a list is a gap, not an empty window", async (t) => {
  const x = await source(t, "dd", ["logs"], { ddLogEnvelope: { data: "none", meta: {} } })
  assert.equal((await x.status()).coverage.at(-1).state, "gap")
})
test("B11' restore rejects a retained line for a problem that never existed", async (t) => {
  const x = await service(t)
  await refusedRestore(x, "update lines set incident='inc_missing'")
})
test("B13' Warn to Alert is one transition; OK then Warn is the second", async (t) => {
  const x = await source(t, "dd", ["monitors"], { monitors: monitor("Warn") })
  await step(x, { monitors: monitor("Alert") })
  assert.equal((await x.status()).incidents[0].count, 1)
  await step(x, { monitors: monitor("OK") })
  assert.equal((await step(x, { monitors: monitor("Warn") })).incidents[0].count, 2)
})

// ---- m2: page
test("U02' a point already ten minutes old at the first poll never renders quiet", optional, async (t) => {
  const x = await rig(t, { both: true }), s = x.cfg.apps.shop.environments.prod.sources
  delete s.pods; s.dd.readings = ["metrics"]
  x.world({ ddPointTime: x.now() - 10 * minute }); x.save(); await x.start(); await x.poll()
  const b = await browser(t, x)
  await b.visit(x.url + "/"); await b.wait("!!document.querySelector('[data-connection=live]')")
  assert.notEqual(await b.evaluate("document.querySelector('[data-env]').dataset.health"), "quiet")
})
test("U03' an edit typed while the first brief is still loading is kept when it arrives", optional, async (t) => {
  const x = await service(t), b = await browser(t, x)
  await b.visit(x.url + "/"); await b.wait("!!document.querySelector('[data-connection=live]')")
  await b.evaluate("window.gate=Promise.withResolvers();const f=window.fetch;window.fetch=async(...a)=>{if(String(a[0]).includes('brief?audience=owner'))await gate.promise;return f(...a)};true")
  await b.key("b"); await b.wait("!!document.querySelector('[data-brief-text]')")
  await b.evaluate("document.querySelector('[data-brief-text]').focus();true")
  await b.type("Owner note")
  await b.evaluate("gate.resolve();true"); await delay(250)
  assert.match(await b.evaluate("document.querySelector('[data-brief-text]').value"), /Owner note/)
})

// ---- m3: transitions
test("C reading filed' with two readers, the one that filed keeps its vote; the other is read again", async (t) => {
  const x = await service(t, { readings: 2 }), release = Promise.withResolvers(), filed = Promise.withResolvers()
  let n = 0, restarted = false
  x.p.workScript = async ({ s, tool }) => {
    const p = (await tool("ow_telemetry", { source: "pods" })).pieces[0]
    if (s.agent === "ow-challenger") { await tool("ow_challenge", { outcome: "upheld", reason: "Seen", evidence: [p.handle] }); return "Filed" }
    if (!restarted && ++n === 2) { await release.promise; return "Interrupted" }
    await tool("ow_finding", filing("real", [p.handle], restarted ? "Replacement" : "Original"))
    if (!restarted) filed.resolve()
    return "Filed"
  }
  const { jobId } = await investigate(x)
  await x.poll(); await filed.promise
  try { await x.stop("SIGKILL") } finally { restarted = true; release.resolve() }
  await x.start()
  const j = await finished(x, jobId), d = await item(x, x.subject)
  const causes = j.result.readings.map((r) => d.findings.find((f) => f.id === r.findingId)?.body.cause).sort()
  assert.deepEqual(causes, ["Original", "Replacement"])
})
test("C challenge filed' a committed disproof survives the cut and overturns the majority", async (t) => {
  const x = await service(t, { readings: 1 }), release = Promise.withResolvers(), filed = Promise.withResolvers()
  let restarted = false
  x.p.workScript = async ({ s, tool }) => {
    const p = (await tool("ow_telemetry", { source: "pods" })).pieces[0]
    if (s.agent !== "ow-challenger") { await tool("ow_finding", filing("real", [p.handle])); return "Filed" }
    await tool("ow_challenge", { outcome: "disproved", reason: restarted ? "Replacement disproof" : "Original disproof", evidence: [p.handle] })
    if (!restarted) { filed.resolve(); await release.promise }
    return "Filed"
  }
  const { jobId } = await investigate(x)
  for (let i = 0; i < 100; i++) { await x.poll(); if (await Promise.race([filed.promise.then(() => true), delay(25).then(() => false)])) break }
  try { await x.stop("SIGKILL") } finally { restarted = true; release.resolve() }
  await x.start()
  const r = (await finished(x, jobId)).result
  assert.deepEqual([r.verdict, r.challenge.reason], ["not_real", "Original disproof"])
})

// ---- m3: evidence
test("E01' three readers agreeing on the generated title alone still make nothing observed", async (t) => {
  const x = await rig(t, { both: true }), s = x.cfg.apps.shop.environments.prod.sources
  delete s.pods; s.dd.readings = ["monitors"]; x.cfg.readings = 3; x.save()
  x.world({ monitors: monitor("Alert") }); await x.start(); await x.poll()
  const inc = (await x.status()).incidents[0]; x.subject = inc.id
  x.p.workScript = async ({ s, tool }) => {
    const piece = (await tool("ow_telemetry", { source: "problem" })).pieces[0]
    if (s.agent === "ow-challenger") await tool("ow_challenge", { outcome: "upheld", evidence: [piece.handle], reason: "Agreed" })
    else await tool("ow_finding", filing("real", [piece.handle]))
    return "Filed"
  }
  const r = (await finished(x, (await investigate(x)).jobId)).result
  assert.deepEqual([r.verdict, r.observed], ["real", false])
})
test("E02' an explicit continue after the peer lost the session is answered in a new session", async (t) => {
  const x = await service(t); model(x, [])
  const first = await finished(x, (await send(x, "ask", { subject: x.subject, text: "Question one", mode: "new" })).jobId)
  x.p.sessions.delete(first.turns[0].sessionId)
  const second = await finished(x, (await send(x, "ask", { subject: x.subject, text: "Question two", mode: "continue" })).jobId)
  assert.equal(second.turns.at(-1).state, "answered", second.turns.at(-1).reason)
  assert.notEqual(second.turns.at(-1).sessionId, first.turns[0].sessionId)
})

// ---- m3: recovery and receipts
test("R01' a past owner brief is unchanged by a later Done", async (t) => {
  const x = await service(t), end = (await x.status()).seq
  const read = () => api(x, "brief?audience=owner&throughSeq=" + end), before = await read()
  assert.match(before.text, /Still open\n- shop prod: error/)
  await act(x, x.subject, { action: "done" })
  assert.equal((await read()).text, before.text)
})
test("R02' three concurrent handoffs with one key open one session", async (t) => {
  const x = await service(t), { requestKey: key } = await api(x, "focus?subject=" + x.subject)
  const all = await Promise.all([1, 2, 3].map(() => api(x, "open", { subject: x.subject }, { key })))
  assert.ok(all.every((r) => JSON.stringify(r) === JSON.stringify(all[0])))
  assert.equal(x.p.sessions.size, 1)
})
test("R03' a handoff key reused for a question is refused", async (t) => {
  const x = await service(t), { requestKey: key } = await api(x, "focus?subject=" + x.subject)
  await api(x, "open", { subject: x.subject }, { key })
  await api(x, "ask", { subject: x.subject, text: "Same key", mode: "new" }, { key, code: 409 })
})
test("R04' a correction cut after its first write is applied once on retry", async (t) => {
  const x = await service(t, { readings: 1 }); model(x, ["not_real"])
  const { id: jobId } = await finished(x, (await investigate(x)).jobId)
  const path = "items/" + x.subject + "/corrections", body = { jobId, text: "Check the queue depth" }
  const { requestKey: key } = await api(x, "focus?subject=" + x.subject), closed = once(x.child, "close")
  await x.control("trace", { killAfter: 1 })
  await assert.rejects(api(x, path, body, { key })); assert.equal((await closed)[1], "SIGKILL")
  await x.start(); await api(x, path, body, { key })
  assert.equal((await item(x, x.subject)).corrections.length, 1)
})
test("R05' with two readers, both filings committed before the kill keep their votes", async (t) => {
  const x = await service(t, { readings: 2 }), held = Promise.withResolvers(), filed = Promise.withResolvers()
  model(x, ["not_real", "not_real"]); const original = x.p.workScript
  let n = 0
  x.p.workScript = async (input) => { const v = await original(input); if (++n === 2) filed.resolve(); await held.promise; return v }
  const { jobId } = await investigate(x)
  try { await x.poll(); await filed.promise; await x.stop("SIGKILL") } finally { held.resolve() }
  model(x, ["real", "real"]); await x.start()
  const r = (await finished(x, jobId)).result
  assert.deepEqual(r.readings.map((x) => x.verdict), ["not_real", "not_real"])
})
test("R06' an OpenCode outage defers an investigation instead of failing it", async (t) => {
  const x = await service(t, { readings: 1 }); model(x, ["not_real"])
  x.world({ ocDown: true })
  const { jobId } = await investigate(x)
  await until(x, async () => (await api(x, "jobs/" + jobId)).reason?.includes("waiting for OpenCode"), "no visible pause")
  x.world({ ocDown: false })
  assert.equal((await finished(x, jobId)).result.verdict, "not_real")
})
test("R07' a source responder reads its own source's telemetry", async (t) => {
  const x = await service(t), src = (await x.status()).sources.find((s) => s.id.endsWith("/pods")).subject
  let pieces = []
  x.p.workScript = async ({ tool }) => { pieces = (await tool("ow_telemetry", { source: "pods" })).pieces; return "Read it" }
  await finished(x, (await send(x, "ask", { subject: src, text: "What does the source say?", mode: "new" }, 200, src)).jobId)
  assert.ok(pieces.some((p) => p.text.includes("checkout")))
})
test("R08' a telemetry source called code still counts as observed telemetry", async (t) => {
  const x = await service(t, { readings: 1, configure(x) { const s = x.cfg.apps.shop.environments.prod.sources; s.code = s.pods; delete s.pods } })
  x.p.workScript = async ({ s, tool }) => {
    const h = (await tool("ow_telemetry", { source: "code" })).pieces[0].handle
    if (s.agent === "ow-challenger") await tool("ow_challenge", { outcome: "upheld", reason: "Seen", evidence: [h] })
    else await tool("ow_finding", filing("real", [h]))
    return "Filed"
  }
  assert.equal((await finished(x, (await investigate(x)).jobId)).result.observed, true)
})
test("R10' an observed verdict says how many distinct observations stand behind it", optional, async (t) => {
  const x = await service(t, { readings: 1 }); model(x, ["real"])
  await finished(x, (await investigate(x)).jobId)
  const b = await browser(t, x); await openFocused(b, x); await b.wait("!!document.querySelector('[data-verdict]')")
  assert.match(await header(b), /observed in telemetry · 1 distinct observation/)
})
test("R11' an answer after reading evidence says it read some and cited none", optional, async (t) => {
  const x = await service(t)
  x.p.workScript = async ({ tool }) => { await tool("ow_telemetry", { source: "pods" }); return "It is the checkout error." }
  await finished(x, (await send(x, "ask", { subject: x.subject, text: "What is it?", mode: "new" })).jobId)
  const b = await browser(t, x); await openFocused(b, x); await b.wait("!!document.querySelector('.answer')")
  assert.match(await b.evaluate("document.querySelector('.answer').closest('li').innerText"), /Read \d+ piece.*no evidence cited/s)
})
test("R14' a graceful stop after responder dispatch still delivers the question once", async (t) => {
  const x = await service(t), held = Promise.withResolvers()
  x.p.workScript = async () => { await held.promise; return "Recorded" }
  const q = await send(x, "ask", { subject: x.subject, text: "Graceful receipt", mode: "new" })
  await until(x, () => x.p.deliveries.some((d) => d.text.includes("Graceful receipt")), "not delivered")
  await delay(100)
  try { await x.stop("SIGTERM") } finally { held.resolve() }
  await x.start()
  assert.equal((await finished(x, q.jobId)).turns[0].state, "answered")
  assert.equal(x.p.deliveries.filter((d) => d.text.includes("Graceful receipt")).length, 1)
})
test("R18' a helper installed while the service runs delivers the parked notice without a restart", async (t) => {
  const x = await service(t)
  const notice = async () => (await api(x, "notifications")).items.find((n) => n.subject === x.subject)
  await until(x, async () => (await notice())?.state === "parked", "should park")
  fs.writeFileSync(x.dir("bin/terminal-notifier"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  await until(x, async () => (await notice()).state === "delivered", "repair not noticed")
})
test("R19' the owner brief names an overturned majority", async (t) => {
  const x = await service(t); model(x, ["real", "real", "real"], { challenge: "disproved" })
  await finished(x, (await investigate(x)).jobId)
  assert.match((await api(x, "brief?audience=owner")).text, /majority overturned/)
})
test("R20' the owner brief names the evidence behind a not-real decision too", async (t) => {
  const x = await service(t, { readings: 1 }); model(x, ["not_real"])
  const j = await finished(x, (await investigate(x)).jobId)
  const handles = (await item(x, x.subject)).findings.flatMap((f) => f.claims.flatMap((c) => c.pieces.map((p) => p.handle)))
  const brief = await api(x, "brief?audience=owner&throughSeq=" + j.result.seq)
  assert.ok(handles.some((h) => brief.text.includes(h)))
})
test("R25' undoing Later into Needs you creates one new notification", async (t) => {
  const x = await service(t)
  const notices = async () => (await api(x, "notifications")).items.filter((n) => n.subject === x.subject)
  await act(x, x.subject, { action: "later", when: "worse" })
  const way = (await item(x, x.subject)).incident.way
  await act(x, x.subject, { action: "undo", actionSeq: way.seq })
  assert.equal((await notices()).length, 2)
})
test("W correction' a key replayed after a cut with different text is refused, and nothing doubles", async (t) => {
  const x = await service(t, { readings: 1 }); model(x, ["not_real"])
  const { id: jobId } = await finished(x, (await investigate(x)).jobId)
  const path = "items/" + x.subject + "/corrections", { requestKey: key } = await api(x, "focus?subject=" + x.subject)
  await api(x, path, { jobId, text: "First" }, { key })
  await x.stop("SIGKILL"); await x.start()
  await api(x, path, { jobId, text: "Second" }, { key, code: 409 })
  assert.equal((await item(x, x.subject)).corrections.length, 1)
})
test("W open' a handoff cut after its intent resumes the same session on retry", async (t) => {
  const x = await service(t), { requestKey: key } = await api(x, "focus?subject=" + x.subject), closed = once(x.child, "close")
  await x.control("trace", { killAfter: 2 })
  await assert.rejects(api(x, "open", { subject: x.subject }, { key })); assert.equal((await closed)[1], "SIGKILL")
  await x.start()
  const r = await api(x, "open", { subject: x.subject }, { key })
  assert.equal(x.p.sessions.size, 1); assert.ok(x.p.sessions.has(r.sessionId))
})
