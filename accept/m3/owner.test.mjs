import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { mcp } from "../m1/peers.mjs"
import { api, item } from "../m2/api.mjs"
import { service, send, until, model, job } from "./rig.mjs"

test("the shipped owner skill teaches an ordinary OpenCode session the tools and undo", () => {
  const text = fs.readFileSync(new URL("../../skills/overwatch/SKILL.md", import.meta.url), "utf8")
  assert.match(text, /name:\s*overwatch/)
  for (const word of ["ow_inbox", "ow_get", "ow_search", "ow_act", "undo"]) assert.ok(text.includes(word), word)
})
test("an independently opened owner session reads and acts through OpenCode MCP", async t => {
  const x = await service(t), sid = "ses_owner_fixture"
  await fetch(x.p.url + "/api/session", { method: "POST", body: JSON.stringify({ id: sid, agent: null, title: "Personal session" }) })
  const call = await mcp(x.url, x.token), tool = (name, args) => call(sid, name, args)
  assert.deepEqual(await tool("ow_inbox", {}), await api(x, "inbox"))
  assert.deepEqual(await tool("ow_get", { id: x.subject }), await item(x, x.subject))
  assert.deepEqual(await tool("ow_search", { text: "checkout" }), await api(x, "search?q=checkout"))
  await tool("ow_act", { id: x.subject, action: "later", until: x.now() + 60000 })
  const way = (await item(x, x.subject)).incident.way
  assert.equal(way.untilMs, x.now() + 60000)
  await tool("ow_act", { id: x.subject, action: "undo", actionSeq: way.seq })
  assert.equal((await item(x, x.subject)).incident.way, null)
})
test("open handoff resolves to a peer-confirmed interactive session, idempotently", async t => {
  const x = await service(t)
  const { requestKey: key } = await api(x, "focus?subject=" + x.subject)
  const open = () => send(x, "open", { subject: x.subject }, 200, x.subject, key)
  const a = await open(), s = x.p.sessions.get(a.sessionId)
  assert.ok(s); assert.ok(!["ow-investigator", "ow-responder", "ow-challenger"].includes(s.agent))
  assert.equal(a.subject, x.subject)
  const u = new URL(a.url); assert.equal(u.origin, x.p.url); assert.equal(u.pathname, "/session/" + s.id)
  await x.stop(); await x.start(); assert.deepEqual(await open(), a)
  assert.equal(x.p.sessions.size, 1)
  assert.equal(x.p.deliveries.filter(d => d.sid === s.id && d.text.includes(x.subject)).length, 1)
})
test("page answers continue after reload, split on explicit new, deploy and subject change", async t => {
  const x = await service(t); model(x, [])
  const ask = async (subject, text, mode = "auto") => {
    const body = { subject, text, mode }, focus = await api(x, "focus?subject=" + encodeURIComponent(subject))
    const key = focus.requestKey
    const intent = await api(x, "ask", body, { key })
    assert.deepEqual(await api(x, "ask", body, { key }), intent)
    const j = await until(x, async () => {
      const j = await job(x, intent.jobId)
      return j.turns?.at(-1)?.answer?.includes(text) && j
    }, "outstanding question never answered")
    return j.turns.at(-1)
  }
  const one = await ask(x.subject, "Question one")
  await x.stop(); await x.start()
  assert.equal((await ask(x.subject, "Question two")).sessionId, one.sessionId)
  const three = await ask(x.subject, "Question three", "new")
  assert.notEqual(three.sessionId, one.sessionId)
  x.world({ revision: "d".repeat(40) }); await x.advance(60000); await x.poll()
  await send(x, "ask", { subject: x.subject, text: "Outdated follow-up", mode: "continue" }, 409)
  assert.notEqual((await ask(x.subject, "Question four")).sessionId, three.sessionId)
  const env = (await x.status()).environments[0].subject
  await ask(env, "Environment question")
  assert.equal(new Set(x.p.deliveries.filter(d => /Question|Environment question/.test(d.text)).map(d => d.sid)).size, 4)
  assert.equal((await item(x, x.subject)).history.filter(e => e.kind === "answered").length, 4)
})
test("briefs freeze the interval, communicate gaps and omit internal evidence in team text", async t => {
  const x = await service(t)
  const one = (await x.status()).seq
  x.world({ kubeFailure: "network unreachable" }); await x.advance(60000); await x.poll()
  const end = (await x.status()).seq
  const brief = (audience, through = end) => api(x, "brief?audience=" + audience + "&afterSeq=0&throughSeq=" + through)
  const owner = await brief("owner"), team = await brief("team")
  for (const b of [owner, team]) {
    assert.deepEqual([b.afterSeq, b.throughSeq], [0, end])
    for (const section of ["What changed", "Impact", "Still open", "Next check"]) assert.ok(b.text.includes(section))
    assert.match(b.text, /shop/i); assert.match(b.text, /prod/i)
    assert.match(b.text, /unknown|unavailable|could(n't| not) check|could(n't| not) be checked/i)
  }
  assert.notEqual(team.text, owner.text)
  assert.doesNotMatch(team.text, /ow_telemetry|kubectl|PURPLE_MUG|ses_|e_[a-f0-9]{12}/)
  assert.notEqual((await brief("owner", one)).text, owner.text)
  await x.stop(); await x.start(); assert.deepEqual(await brief("team"), team)
  assert.equal(x.p.deliveries.length, 0)
})
