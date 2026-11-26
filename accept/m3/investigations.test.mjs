import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { api, item, act } from "../m2/api.mjs"
import { service, model, send, finished, investigate, until } from "./rig.mjs"

const cases = [
  ["minority dissents", ["real", "not_real", "real"], "upheld", "real", true],
  ["challenger overturns", ["real", "real", "unsure"], "disproved", "not_real", false],
  ["challenger uncertain", ["real", "real", "unsure"], "unsure", "unsure", false],
  ["a compliant reader remains one visible vote", ["obey", "not_real", "not_real"], null, "not_real", false],
  ["two readers tie", ["real", "not_real"], null, "unsure", false],
  ["single reader still needs challenger", ["real"], "upheld", "real", true],
  ["missing slot stays in the denominator", ["ramble", "real", "unsure"], null, "unsure", false],
  ["real supported only by code", ["real", "real", "real"], "upheld", "real", false],
]
for (const [label, votes, challenge, verdict, observed] of cases) test("adjudication: " + label, async t => {
  const x = await service(t, { readings: votes.length, configure(x) {
    if (label === "minority dissents") delete x.cfg.readings
  } })
  const trace = model(x, votes, { challenge, codeOnly: label.endsWith("by code") })
  const { jobId } = await investigate(x)
  const j = await finished(x, jobId), r = j.result
  assert.equal(j.state, "completed")
  assert.deepEqual([r.planned, r.verdict, r.observed], [votes.length, verdict, observed])
  const counts = { real: 0, not_real: 0, unsure: 0, missing: 0 }
  for (const v of votes) counts[v === "obey" ? "real" : v === "ramble" ? "missing" : v]++
  assert.deepEqual(r.counts, counts)
  assert.deepEqual(r.readings.map(i => i.slot), votes.map((_, i) => i + 1))
  for (const [i, v] of votes.entries()) {
    assert.equal(r.readings[i].verdict, v === "obey" ? "real" : v === "ramble" ? null : v)
    if (v === "ramble") assert.ok(r.readings[i].reason)
  }
  assert.equal(trace.readers.size, votes.length + votes.filter(v => v === "ramble").length)
  assert.equal(new Set(trace.rambling).size, votes.includes("ramble") ? 2 : 0)
  if (votes.includes("ramble")) assert.equal(trace.rambling.length, 4, "initial, nudge, retry, nudge")
  assert.equal(new Set(trace.citations.values()).size, trace.citations.size)
  for (const text of trace.readers.values()) assert.doesNotMatch(text, /Private reader rationale/)
  assert.ok(x.p.peak <= 2)
  assert.equal(trace.challenges.length, challenge ? 1 : 0)
  if (challenge) {
    assert.equal(r.challenge.outcome, challenge)
    assert.ok(r.challenge.pieces.length && r.challenge.pieces.every(p => p.handle && p.text))
  } else assert.equal(r.challenge, null)
  const detail = await item(x, x.subject)
  assert.equal(detail.history.filter(e => e.kind === "adjudicated").length, 1)
  if (verdict === "unsure") assert.equal(detail.incident.group, "needsYou")
  assert.deepEqual(x.p.errors, [])
})
test("a manual investigation returns deferred work only after one adjudication", async t => {
  const x = await service(t)
  model(x, ["not_real", "not_real", "not_real"])
  await act(x, x.subject, { action: "later" })
  const { requestKey: key } = await api(x, "focus?subject=" + x.subject)
  const start = () => send(x, "items/" + x.subject + "/investigate", {}, 202, x.subject, key)
  const first = await start(); await finished(x, first.jobId)
  const d = await item(x, x.subject), a = d.history.filter(e => e.kind === "adjudicated")
  assert.equal(a.length, 1)
  assert.equal(d.incident.returned.causeSeq, a[0].seq)
  assert.equal(d.history.filter(e => e.kind === "returned").length, 1)
  await x.stop(); await x.start(); assert.deepEqual(await start(), first)
  assert.equal(x.p.sessions.size, 3)
})
test("automatic investigation begins only for new admissions after model approval", async t => {
  const x = await service(t); model(x, ["not_real", "not_real", "not_real"])
  await x.poll(); assert.equal(x.p.sessions.size, 0)
  assert.equal((await x.json("trial")).automation, true)
  await x.advance(60000)
  x.world({ lines: [...x.w().lines, [new Date(x.now() - 1).toISOString(), "ERROR billing"]] })
  await x.poll()
  const s = await x.status(), id = s.incidents.find(i => i.title.includes("billing")).id
  const j = await until(x, async () => (await x.status()).jobs.find(j => j.kind === "investigation" && j.subject === id), "approved new incident never investigated")
  await finished(x, j.id)
  assert.equal((await x.status()).jobs.filter(j => j.kind === "investigation").length, 1)
})
test("a per-app correction changes the next readers' actual inputs after restart", async t => {
  const x = await service(t, {
    configure(x) {
      x.cfg.apps.other = structuredClone(x.cfg.apps.shop)
      x.cfg.watchers.push({ ...x.cfg.watchers[0], app: "other" })
    }
  })
  const id = x.subject, trace = model(x, ["not_real", "not_real", "not_real"])
  const prior = await investigate(x); await finished(x, prior.jobId)
  const ids = new Set(trace.readers.keys()), guidance = "Compare against the regional maintenance window"
  assert.ok([...trace.readers.values()].every(text => !text.includes(guidance)))
  const { requestKey: key } = await api(x, "focus?subject=" + id)
  const correct = () => send(x, "items/" + id + "/corrections", { jobId: prior.jobId, text: guidance }, 200, id, key)
  const line = await correct()
  await x.stop()
  await x.start()
  assert.deepEqual(await correct(), line)
  const lines = fs.readFileSync(x.dir("store/playbooks/shop.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse)
  assert.equal(lines.length, 1); assert.deepEqual([lines[0].app, lines[0].subject, lines[0].text, lines[0].seq], ["shop", id, guidance, line.seq])
  assert.match(lines[0].date, /^\d{4}-\d\d-\d\d$/)
  const next = await investigate(x); await finished(x, next.jobId)
  const newPrompts = [...trace.readers].filter(([sid]) => !ids.has(sid))
  assert.equal(newPrompts.length, 3); assert.ok(newPrompts.every(([, text]) => text.includes(guidance)))
  const covered = new Set(trace.readers.keys())
  x.subject = (await x.status()).incidents.find(i => i.app === "other").id
  const other = await investigate(x); await finished(x, other.jobId)
  const outsiders = [...trace.readers].filter(([sid]) => !covered.has(sid))
  assert.equal(outsiders.length, 3); assert.ok(outsiders.every(([, text]) => !text.includes(guidance)))
})

test("an exhausted challenger cannot turn a real majority into observed fact", async t => {
  const x = await service(t)
  model(x, ["real", "real", "real"])
  const reader = x.p.workScript, challengers = []
  x.p.workScript = async input => {
    if (input.s.agent !== "ow-challenger") return reader(input)
    challengers.push(input.s.id)
    return "No filing yet"
  }
  const j = await finished(x, (await investigate(x)).jobId)
  assert.equal(challengers.length, 4)
  assert.equal(new Set(challengers).size, 2)
  assert.deepEqual([j.result.verdict, j.result.observed, j.result.challenge.outcome], ["unsure", false, null])
  assert.ok(j.result.challenge.reason)
})
test("a challenger cannot overturn with a reader's handle; its own filing may still succeed", async t => {
  const x = await service(t)
  const trace = model(x, ["real", "real", "real"], { challenge: "upheld" })
  const script = x.p.workScript
  let checked = false
  x.p.workScript = async input => {
    if (input.s.agent === "ow-challenger") {
      const foreign = [...trace.citations.values()][0]
      assert.ok(foreign)
      await assert.rejects(input.tool("ow_challenge", { outcome: "disproved", reason: "A different session saw it", evidence: [foreign] }))
      checked = true
    }
    return script(input)
  }
  const j = await finished(x, (await investigate(x)).jobId)
  assert.ok(checked)
  assert.equal(j.result.verdict, "real")
  assert.equal(j.result.challenge.outcome, "upheld")
})
