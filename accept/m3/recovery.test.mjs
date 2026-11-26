import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { rig } from "../m1/rig.mjs"
import { mcp, filing } from "../m1/peers.mjs"
import { api, act, item } from "../m2/api.mjs"
import { service, send, model, investigate, finished, until } from "./rig.mjs"

async function waitFor(read, description) {
  const end = Date.now() + 4000
  while (Date.now() < end) {
    if (await read()) return
    await delay(20)
  }
  assert.fail(description)
}
function helper(x, wait = false) {
  fs.writeFileSync(
    x.dir("bin/terminal-notifier"),
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$OW_FIXTURE/notice"\n' +
      (wait ? 'while test ! -f "$OW_FIXTURE/release"; do sleep 0.02; done\n' : "") +
      "exit 0\n",
    { mode: 0o755 },
  )
}
test("R17 an uncertain notification delivery after SIGKILL reuses the same group", async (t) => {
  const x = await service(t, { before: (x) => helper(x, true) })
  const path = x.dir("notice"),
    notice = async () => (await api(x, "notifications")).items.find((n) => n.subject === x.subject)
  await waitFor(() => fs.existsSync(path), "helper not invoked")
  const first = await notice()
  assert.equal(first.state, "sending")
  try {
    await x.stop("SIGKILL")
  } finally {
    fs.writeFileSync(x.dir("release"), "ok")
  }
  await x.start()
  await until(x, async () => (await notice()).state === "delivered", "uncertain notice never acknowledged")
  const groups = fs
    .readFileSync(path, "utf8")
    .split("\n")
    .filter((s) => s === first.id)
  assert.equal(groups.length, 2)
  assert.equal((await notice()).attempts, 2)
})
test("R18 missing notifier repair followed literally recovers a parked delivery", async (t) => {
  const x = await service(t)
  const notice = async () => (await api(x, "notifications")).items.find((n) => n.subject === x.subject)
  await until(x, async () => (await notice())?.state === "parked", "missing helper should park")
  assert.match((await notice()).reason, /restart/i)
  await x.stop()
  helper(x)
  await x.start()
  await x.poll()
  await delay(100)
  assert.equal((await notice()).state, "delivered")
})
test("R19 a completed disproof appears as disagreement in the team brief", async (t) => {
  const x = await service(t)
  model(x, ["real", "real", "real"], { challenge: "disproved" })
  await finished(x, (await investigate(x)).jobId)
  const team = await api(x, "brief?audience=team")
  assert.doesNotMatch(team.text, /ow_|ses_|e_[0-9a-f]{12}|PURPLE_MUG|kubectl/)
  assert.match(team.text, /disagreed|overturned|disproved|challenged/i)
})
test("R20 the owner brief identifies evidence for an adjudicated real finding", async (t) => {
  const x = await service(t, { readings: 1 })
  model(x, ["real"])
  const j = await finished(x, (await investigate(x)).jobId)
  const evidence = (await item(x, x.subject)).findings.flatMap((f) =>
    f.claims.flatMap((c) => c.pieces.map((p) => p.handle)),
  )
  assert.ok(evidence.length >= 2)
  const brief = await api(x, "brief?audience=owner&throughSeq=" + j.result.seq)
  assert.ok(
    evidence.some((h) => brief.text.includes(h)),
    "no canonical evidence reference",
  )
})
test("R21 two valid filings from one reader keep the first, and a challenger cannot file a reader result", async (t) => {
  const x = await service(t, { readings: 1 })
  x.p.workScript = async ({ s, tool }) => {
    const h = (await tool("ow_telemetry", { source: "pods" })).pieces[0].handle
    if (s.agent === "ow-challenger") {
      await assert.rejects(tool("ow_finding", filing("not_real", [h])), /cannot file/)
      await tool("ow_challenge", { reason: "Checked independently", outcome: "upheld", evidence: [h] })
    } else {
      await tool("ow_finding", filing("real", [h]))
      await assert.rejects(tool("ow_finding", filing("not_real", [h])))
    }
    return "Finished"
  }
  const j = await finished(x, (await investigate(x)).jobId)
  assert.equal(j.result.readings[0].verdict, "real")
  assert.equal(j.result.challenge.outcome, "upheld")
})
test("R22 a retired reader after restart has neither late filing nor owner capabilities", async (t) => {
  const x = await service(t, { readings: 1 }),
    trace = model(x, ["real"])
  const j = await finished(x, (await investigate(x)).jobId),
    sid = j.result.readings[0].sessionId
  const h = trace.citations.get(sid)
  assert.ok(h)
  await x.stop()
  await x.start()
  const call = await mcp(x.url, x.token)
  await assert.rejects(call(sid, "ow_finding", filing("not_real", [h])))
  await assert.rejects(call(sid, "ow_inbox", {}))
  assert.equal((await item(x, x.subject)).history.filter((e) => e.kind === "adjudicated").length, 1)
})
test("R23 a third source kind fails closed at config admission before any collection", async (t) => {
  const x = await rig(t)
  x.cfg.apps.shop.environments.prod.sources.unknown = { type: "fixture-other", readings: ["usage"] }
  x.save()
  const r = await x.cli("check")
  assert.equal(r.code, 2)
  assert.equal(x.calls().length + x.p.requests.length, 0)
})
test("R24 redaction survives notice argv, answer, correction, briefs, peer and backup bytes", async (t) => {
  const x = await service(t, { readings: 1, before: (x) => helper(x) })
  const marker = "fixture-sienna-3147",
    text = "password=" + marker
  await x.advance(60000)
  x.world({ lines: [...x.w().lines, [new Date(x.now() - 1).toISOString(), "ERROR carts " + text]] })
  await x.poll()
  x.subject = (await x.status()).incidents.find((i) => i.title.includes("carts")).id
  model(x, ["not_real"])
  const j = await finished(x, (await investigate(x)).jobId)
  await send(x, "items/" + x.subject + "/corrections", { jobId: j.id, text: "Check region " + text })
  x.p.workScript = async () => "Check receipt " + text
  const q = await send(x, "ask", { subject: x.subject, text: "Queue " + text, mode: "new" })
  const a = await finished(x, q.jobId)
  assert.match(a.turns[0].answer, /Check receipt/)
  const paths = [x.dir("store/playbooks/shop.jsonl"), x.dir("notice"), x.dir("backup.db")]
  await x.json("backup", ["--to", paths[2]])
  for (const f of paths) assert.equal(fs.readFileSync(f).includes(Buffer.from(marker)), false)
  assert.ok(fs.readFileSync(paths[1], "utf8").includes("carts"), "tested the new notification")
  for (const b of [
    await api(x, "brief?audience=owner"),
    await api(x, "brief?audience=team"),
    await item(x, x.subject),
    x.p.deliveries,
  ]) {
    assert.equal(JSON.stringify(b).includes(marker), false)
  }
})
test("R25 undoing Done into Needs you creates one new notification for that cause", async (t) => {
  const x = await service(t)
  const notices = async () => (await api(x, "notifications")).items.filter((n) => n.subject === x.subject)
  const first = await notices()
  assert.equal(first.length, 1)
  await act(x, x.subject, { action: "done" })
  const way = (await item(x, x.subject)).incident.way
  await act(x, x.subject, { action: "undo", actionSeq: way.seq })
  assert.equal((await item(x, x.subject)).incident.group, "needsYou")
  assert.equal((await notices()).length, 2)
})
