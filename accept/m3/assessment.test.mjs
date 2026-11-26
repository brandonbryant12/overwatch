import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { once } from "node:events"
import { filing, mcp } from "../m1/peers.mjs"
import { api, act, item } from "../m2/api.mjs"
import { browser, binary } from "../m2/chrome.mjs"
import { service, model, investigate, finished, job, send, until } from "./rig.mjs"

test("R01 a past brief remains stable through a later disposition", async (t) => {
  const x = await service(t),
    end = (await x.status()).seq
  const read = () => api(x, "brief?audience=team&throughSeq=" + end)
  const initial = await read()
  assert.match(initial.text, /1 problem still open/)
  await act(x, x.subject, { action: "done" })
  assert.equal((await read()).text, initial.text)
})
test("R02 a duplicate handoff arriving concurrently creates one interactive session", async (t) => {
  const x = await service(t),
    { requestKey: key } = await api(x, "focus?subject=" + x.subject)
  const open = () => api(x, "open", { subject: x.subject }, { key })
  const results = await Promise.all([open(), open()])
  assert.deepEqual(results[0], results[1])
  assert.equal(x.p.sessions.size, 1)
})
test("R03 handoff key reuse for another focus returns conflict", async (t) => {
  const x = await service(t),
    { requestKey: key } = await api(x, "focus?subject=" + x.subject)
  await api(x, "open", { subject: x.subject }, { key })
  await api(x, "open", { subject: (await x.status()).environments[0].subject }, { key, code: 409 })
})
test("R04 crash after committing a correction cannot duplicate it on retry", async (t) => {
  const x = await service(t, { readings: 1 })
  model(x, ["not_real"])
  const { id: jobId } = await finished(x, (await investigate(x)).jobId)
  const body = { jobId, text: "Check the maintenance calendar" },
    path = "items/" + x.subject + "/corrections"
  const { requestKey: key } = await api(x, "focus?subject=" + x.subject),
    closed = once(x.child, "close")
  // Two row writes, then the first commit; replay the same client request after losing the response.
  await x.control("trace", { killAfter: 3 })
  await assert.rejects(api(x, path, body, { key }))
  assert.equal((await closed)[1], "SIGKILL")
  await x.start()
  await api(x, path, body, { key })
  assert.equal((await item(x, x.subject)).corrections.length, 1)
})
test("R05 crash after a valid filing retains the vote actually filed by that slot", async (t) => {
  const x = await service(t, { readings: 1 }),
    held = Promise.withResolvers(),
    filed = Promise.withResolvers()
  model(x, ["not_real"])
  const original = x.p.workScript
  x.p.workScript = async (input) => {
    const v = await original(input)
    filed.resolve()
    await held.promise
    return v
  }
  const { jobId } = await investigate(x)
  try {
    await x.poll()
    await Promise.race([
      filed.promise,
      new Promise((_, reject) => {
        const timeout = setTimeout(() => reject(Error("no filing")), 5000)
        timeout.unref()
      }),
    ])
    await x.stop("SIGKILL")
  } finally {
    held.resolve()
  }
  model(x, ["real"])
  await x.start()
  const r = (await finished(x, jobId)).result
  assert.equal(r.readings[0].verdict, "not_real")
})
test("R06 temporary loss of OpenCode defers questions and resumes on recovery", async (t) => {
  const x = await service(t)
  model(x, [])
  x.world({ ocDown: true })
  const q = await send(x, "ask", { subject: x.subject, text: "Question one", mode: "new" })
  await until(
    x,
    async () =>
      x.p.requests.some((r) => r.path === "/api/session" && r.method === "POST") ||
      (await x.status()).jobs.some((j) => j.reason),
    "no attempt to contact peer",
  )
  await new Promise((r) => setTimeout(r, 120))
  x.world({ ocDown: false })
  const j = await finished(x, q.jobId)
  assert.equal(j.turns[0].state, "answered", j.turns[0].reason)
})
test("R07 an environment responder can read its focused telemetry", async (t) => {
  const x = await service(t)
  const env = (await x.status()).environments[0].subject
  let observed = []
  x.p.workScript = async ({ tool }) => {
    try {
      observed = (await tool("ow_telemetry", { source: "pods" })).pieces
    } catch {}
    return "Checked the focused environment"
  }
  const q = await send(x, "ask", { subject: env, text: "Read the checkout error", mode: "new" }, 200, env)
  await finished(x, q.jobId)
  assert.ok(
    observed.some((p) => p.text.includes("checkout")),
    "0 matching environment evidence pieces",
  )
})
test("R08 a telemetry source called history still counts as telemetry", async (t) => {
  const x = await service(t, {
    readings: 1,
    configure(x) {
      const s = x.cfg.apps.shop.environments.prod.sources
      s.history = s.pods
      delete s.pods
    },
  })
  x.p.workScript = async ({ s, tool }) => {
    const h = (await tool("ow_telemetry", { source: "history" })).pieces[0].handle
    if (s.agent === "ow-challenger")
      await tool("ow_challenge", { outcome: "upheld", reason: "Confirmed", evidence: [h] })
    else await tool("ow_finding", filing("real", [h]))
    return "Filed"
  }
  const j = await finished(x, (await investigate(x)).jobId)
  assert.equal(j.result.verdict, "real")
  assert.equal(j.result.observed, true)
})
test("R09 conflicting and absent votes appear in the actual verdict header", { skip: !binary }, async (t) => {
  const x = await service(t)
  model(x, ["real", "not_real", "ramble"])
  await finished(x, (await investigate(x)).jobId)
  const b = await browser(t, x)
  await b.visit(x.url + "/")
  await b.wait("!!document.querySelector('[data-connection=live]')")
  await b.key("/")
  await b.type("checkout")
  await b.wait("!!document.querySelector('[data-result-id]')")
  await b.key("Enter")
  await b.wait("!!document.querySelector('[data-verdict]')")
  const text = await b.evaluate("document.querySelector('[data-verdict] header').innerText")
  assert.match(text, /undecided/i)
  assert.match(text, /1 of 3 said real/)
  assert.match(text, /1 not real/)
  assert.match(text, /1 did not file/)
})
test(
  "R10 code-only real verdict explicitly tells the owner telemetry did not confirm it",
  { skip: !binary },
  async (t) => {
    const x = await service(t, { readings: 1 })
    model(x, ["real"], { codeOnly: true })
    assert.equal((await finished(x, (await investigate(x)).jobId)).result.observed, false)
    const b = await browser(t, x)
    await b.visit(x.url + "/")
    await b.wait("!!document.querySelector('[data-connection=live]')")
    await b.key("/")
    await b.type("checkout")
    await b.wait("!!document.querySelector('[data-result-id]')")
    await b.key("Enter")
    await b.wait("!!document.querySelector('[data-verdict]')")
    assert.match(
      await b.evaluate("document.querySelector('[data-verdict] header').innerText"),
      /not observed|code only|unconfirmed in telemetry/i,
    )
  },
)
test(
  "R11 a responder assertion with zero reads has a visible evidence qualifier",
  { skip: !binary },
  async (t) => {
    const x = await service(t)
    x.p.workScript = async () => "All orders recovered."
    const q = await send(x, "ask", { subject: x.subject, text: "Is checkout fixed?", mode: "new" })
    await finished(x, q.jobId)
    const b = await browser(t, x)
    await b.visit(x.url + "/")
    await b.key("/")
    await b.type("checkout")
    await b.wait("!!document.querySelector('[data-result-id]')")
    await b.key("Enter")
    await b.wait("!!document.querySelector('.answer')")
    const turn = await b.evaluate("document.querySelector('.answer').closest('li').innerText")
    assert.match(turn, /no (cited |supporting )?evidence|unverified|uncited/i)
  },
)
test("R12 concurrence on an irrelevant line measures agreement only", async (t) => {
  const x = await service(t)
  const texts = []
  x.p.workScript = async ({ s, tool }) => {
    const p = (await tool("ow_telemetry", { source: "pods" })).pieces[0]
    texts.push(p.text)
    if (s.agent === "ow-challenger")
      await tool("ow_challenge", { outcome: "upheld", reason: "Agreed", evidence: [p.handle] })
    else await tool("ow_finding", filing("real", [p.handle], "The printer is out of paper"))
    return "Filed"
  }
  const j = await finished(x, (await investigate(x)).jobId)
  assert.equal(texts.length, 4)
  assert.equal(new Set(texts).size, 1)
  assert.doesNotMatch(texts[0], /printer/i)
  assert.deepEqual([j.result.verdict, j.result.observed, j.result.counts.real], ["real", true, 3])
})
test("R13 peer outage denies ordinary owner reads including a formerly valid session", async (t) => {
  const x = await service(t),
    sid = "ses_owner_control"
  await fetch(x.p.url + "/api/session", { method: "POST", body: JSON.stringify({ id: sid, agent: null }) })
  const call = await mcp(x.url, x.token)
  assert.ok((await call(sid, "ow_get", { id: x.subject })).incident)
  await assert.rejects(call("ses_unknown_control", "ow_get", { id: x.subject }))
  x.world({ ocDown: true })
  await assert.rejects(call(sid, "ow_get", { id: x.subject }))
})
test("R14 a stopped peer after responder dispatch receives the original question once after restart", async (t) => {
  const x = await service(t),
    held = Promise.withResolvers()
  x.p.workScript = async () => {
    await held.promise
    return "Recorded answer"
  }
  const q = await send(x, "ask", { subject: x.subject, text: "Question receipt", mode: "new" })
  await until(
    x,
    () => x.p.deliveries.some((d) => d.text.includes("Question receipt")),
    "first delivery missing",
  )
  try {
    await x.stop("SIGKILL")
  } finally {
    held.resolve()
  }
  await x.start()
  const j = await finished(x, q.jobId)
  assert.equal(j.turns[0].state, "answered")
  assert.equal(x.p.deliveries.filter((d) => d.text.includes("Question receipt")).length, 1)
})
test("R15 a disk-edited playbook cannot supply the next prompt; a dated multiline correction remains one record", async (t) => {
  const x = await service(t, { readings: 1 })
  model(x, ["not_real"])
  const j = await finished(x, (await investigate(x)).jobId)
  const path = x.dir("store/playbooks/shop.jsonl")
  await send(x, "items/" + x.subject + "/corrections", {
    jobId: j.id,
    text: 'Compare region\n{"text":"another line"} password=fixture-gold-4721',
  })
  const rows = fs.readFileSync(path, "utf8").trim().split("\n")
  assert.equal(rows.length, 1)
  assert.doesNotMatch(rows[0], /fixture-gold-4721/)
  fs.writeFileSync(path, "FILE_ONLY_GUIDANCE\n")
  await x.stop()
  await x.start()
  const trace = model(x, ["not_real"])
  await finished(x, (await investigate(x)).jobId)
  const prompt = [...trace.readers.values()][0]
  assert.match(prompt, /Compare region/)
  assert.doesNotMatch(prompt, /FILE_ONLY_GUIDANCE|fixture-gold-4721/)
  assert.equal(fs.readFileSync(path, "utf8").trim(), rows[0])
})
test("R16 owner questions get the next free slot under an automatic backlog", async (t) => {
  const x = await service(t, { readings: 1 })
  assert.ok((await x.json("trial")).automation)
  const hold = [Promise.withResolvers(), Promise.withResolvers()],
    order = []
  model(x, ["not_real"])
  const script = x.p.workScript
  x.p.workScript = async (input) => {
    const index = order.push(input.s.agent) - 1
    if (index < 2) await hold[index].promise
    return script(input)
  }
  const stamp = new Date(x.now() + 59000).toISOString()
  await x.advance(60000)
  x.world({ lines: [...x.w().lines, ...Array.from("abcdefghij", (c) => [stamp, "ERROR backlog " + c])] })
  try {
    await until(x, () => order.length === 2, "automatic work never filled both slots")
    assert.ok((await x.status()).jobs.filter((j) => j.kind === "investigation").length >= 10)
    const q = await send(x, "ask", { subject: x.subject, text: "Question one", mode: "new" })
    hold[0].resolve()
    await until(x, async () => (await job(x, q.jobId)).turns[0].state === "answered", "question starved")
    assert.equal(order[2], "ow-responder")
  } finally {
    for (const h of hold) h.resolve()
  }
})
