import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { api, item, act } from "../m2/api.mjs"
import { browser, binary } from "../m2/chrome.mjs"
import { filing } from "../m1/peers.mjs"
import { service, model, investigate, finished, until, send } from "./rig.mjs"

const one = (t) => service(t, { readings: 1 })
const key = async (x) => (await api(x, "focus?subject=" + x.subject)).requestKey
const ask = (x, text, mode = "auto") => send(x, "ask", { subject: x.subject, text, mode })
async function save(x) {
  const f = x.dir("review.db")
  await x.json("backup", ["--to", f])
  return f
}
async function load(x, f) {
  await x.stop("SIGKILL")
  await x.json("restore", ["--from", f])
  await x.start()
}
async function decision(x, v = "real", opts = {}) {
  model(x, [v], opts)
  return finished(x, (await investigate(x)).jobId)
}
async function open(t, x) {
  const b = await browser(t, x)
  await b.visit(x.url + "/")
  await b.wait("document.querySelector('[data-connection=live]')")
  await b.key("/")
  await b.type("checkout")
  await b.wait("document.querySelector('[data-result-id]')")
  await b.key("Enter")
  return b
}
for (const role of ["investigator", "challenger"])
  test("J " + role + " committed filing in restored in-flight backup stays final", async (t) => {
    const x = await one(t),
      release = Promise.withResolvers()
    model(x, ["real"], { challenge: "disproved" })
    const initial = x.p.workScript
    let waiting = false
    x.p.workScript = async (args) => {
      const result = await initial(args)
      if (args.s.agent === "ow-" + role) {
        waiting = true
        await release.promise
      }
      return result
    }
    const { jobId } = await investigate(x)
    try {
      await until(x, () => waiting, "no committed filing")
      const f = await save(x)
      await x.stop("SIGKILL")
      release.resolve()
      model(x, ["not_real"], { challenge: "upheld" })
      await x.json("restore", ["--from", f])
      await x.start()
      const j = await finished(x, jobId)
      assert.equal(j.result.readings[0].verdict, "real")
      if (role === "challenger") assert.equal(j.result.challenge.outcome, "disproved")
    } finally {
      release.resolve()
    }
  })
test("J E01 a challenger's telemetry cannot promote the winning readers' code", async (t) => {
  const x = await one(t)
  model(x, ["real"], { codeOnly: true })
  const j = await finished(x, (await investigate(x)).jobId)
  assert.ok(j.result.challenge.pieces.some((p) => p.text.includes("checkout")))
  assert.equal(j.result.observed, false)
})
test("J E02 answer after service and peer session loss links a fresh session", async (t) => {
  const x = await one(t)
  model(x, [])
  const a = await finished(x, (await ask(x, "First")).jobId)
  await x.stop()
  x.p.sessions.delete(a.turns[0].sessionId)
  await x.start()
  const b = await finished(x, (await ask(x, "Next")).jobId)
  assert.equal(b.turns.at(-1).state, "answered")
  assert.notEqual(b.turns.at(-1).sessionId, a.turns[0].sessionId)
})
test("J R01 an adjudication arriving after a brief fence cannot appear in its text", async (t) => {
  const x = await one(t),
    read = "brief?audience=owner&throughSeq=" + (await x.status()).seq
  const before = await api(x, read)
  await decision(x)
  assert.equal((await api(x, read)).text, before.text)
})
test("J R02 concurrent duplicate handoffs for an environment reuse a session after restore", async (t) => {
  const x = await one(t),
    subject = (await x.status()).environments[0].subject,
    k = await key(x)
  const go = () => api(x, "open", { subject }, { key: k })
  const first = await go()
  await load(x, await save(x))
  for (const r of await Promise.all([go(), go()])) assert.deepEqual(r, first)
  assert.equal(x.p.sessions.size, 1)
})
test("J R03 fix and handoff cannot share a receipt", async (t) => {
  const x = await one(t),
    j = await decision(x),
    k = await key(x)
  await api(x, "items/" + x.subject + "/fix", { jobId: j.id }, { key: k, code: 202 })
  await api(x, "open", { subject: x.subject }, { key: k, code: 409 })
})
test("J R04 replay after restoring a committed correction keeps file and row in sync", async (t) => {
  const x = await one(t),
    j = await decision(x),
    k = await key(x)
  const put = () =>
    api(x, "items/" + x.subject + "/corrections", { jobId: j.id, text: "Read inventory" }, { key: k })
  await put()
  const file = x.dir("store/playbooks/shop.jsonl"),
    expected = fs.readFileSync(file, "utf8")
  await load(x, await save(x))
  await put()
  assert.equal(fs.readFileSync(file, "utf8"), expected)
  assert.equal((await item(x, x.subject)).corrections.length, 1)
})
test("J R05 already committed unsure vote and handle survive repeated restart", async (t) => {
  const x = await one(t),
    j = await decision(x, "unsure")
  await x.stop("SIGKILL")
  await x.start()
  await x.poll()
  await x.stop("SIGKILL")
  await x.start()
  assert.deepEqual((await finished(x, j.id)).result, j.result)
})
test("J R06 two queued owner questions survive a peer outage and service restart", async (t) => {
  const x = await one(t)
  model(x, [])
  x.world({ ocDown: true })
  const a = await ask(x, "Question one", "new"),
    b = await ask(x, "Question two", "new")
  await x.poll()
  await x.stop()
  await x.start()
  x.world({ ocDown: false })
  for (const j of [a, b]) assert.equal((await finished(x, j.jobId)).turns.at(-1).state, "answered")
})
test("J R07 source prompt must not include a sister environment's line", async (t) => {
  const x = await service(t, {
    configure(x) {
      const env = x.cfg.apps.shop.environments
      env.stage = structuredClone(env.prod)
      env.stage.sources.pods.namespace = "stage"
      x.cfg.watchers.push({ app: "shop", environment: "stage", every: "1m" })
    },
    before(x) {
      const ts = new Date(x.now() - 1).toISOString()
      x.world({
        namespaceLines: {
          shop: [[ts, "ERROR checkout production"]],
          stage: [[ts, "ERROR checkout staging-private"]],
        },
      })
    },
  })
  let seen
  x.p.workScript = async ({ tool }) => {
    seen = await tool("ow_telemetry", { source: "pods" })
    return "Seen"
  }
  const subject = "src:shop/prod/pods"
  await finished(
    x,
    (await send(x, "ask", { subject, text: "Describe this source", mode: "new" }, 200, subject)).jobId,
  )
  assert.match(JSON.stringify(seen), /production/)
  assert.doesNotMatch(JSON.stringify(seen), /staging-private/)
})
test("J R08 a telemetry source called problem can prove an observed reading", async (t) => {
  const x = await service(t, {
    readings: 1,
    configure(x) {
      const s = x.cfg.apps.shop.environments.prod.sources
      s.problem = s.pods
      delete s.pods
    },
  })
  x.p.workScript = async ({ s, tool }) => {
    const h = (await tool("ow_telemetry", { source: "problem" })).pieces[0].handle
    if (s.agent === "ow-challenger")
      await tool("ow_challenge", { outcome: "upheld", reason: "Checked", evidence: [h] })
    else await tool("ow_finding", filing("real", [h]))
    return "Filed"
  }
  assert.equal((await finished(x, (await investigate(x)).jobId)).result.observed, true)
})
test(
  "J R10 a restored code-only verdict still names the lack of telemetry in Chrome",
  { skip: !binary },
  async (t) => {
    const x = await one(t)
    await decision(x, "real", { codeOnly: true })
    await load(x, await save(x))
    const b = await open(t, x)
    await b.wait("document.querySelector('[data-verdict]')")
    assert.match(
      await b.evaluate("document.querySelector('[data-verdict] header').innerText"),
      /not observed|unconfirmed in telemetry|code only/i,
    )
  },
)
test(
  "J R11 zero-read follow-up cannot inherit another turn's evidence qualifier",
  { skip: !binary },
  async (t) => {
    const x = await one(t)
    x.p.workScript = async ({ tool }) => {
      await tool("ow_telemetry", { source: "pods" })
      return "Earlier checked"
    }
    await finished(x, (await ask(x, "First question")).jobId)
    x.p.workScript = async () => "Subsequent assertion"
    await finished(x, (await ask(x, "Follow up", "continue")).jobId)
    const b = await open(t, x)
    await b.wait("document.body.innerText.includes('Subsequent assertion')")
    assert.match(
      await b.evaluate(
        "Array.from(document.querySelectorAll('.answer')).find(a=>a.innerText.includes('Subsequent assertion')).closest('li').innerText",
      ),
      /no (cited |supporting )?evidence|unverified|uncited/i,
    )
  },
)
test("J R14 a completed answer restored from backup sends no second prompt", async (t) => {
  const x = await one(t)
  model(x, [])
  const j = await finished(x, (await ask(x, "Unrepeatable question")).jobId)
  await load(x, await save(x))
  assert.deepEqual((await finished(x, j.id)).turns, j.turns)
  assert.equal(x.p.deliveries.filter((d) => d.text.includes("Unrepeatable question")).length, 1)
})
test("J R18 two keyed retries of one parked notice preserve one intent", async (t) => {
  const x = await one(t),
    notices = async () => (await api(x, "notifications")).items
  const n = await until(
      x,
      async () => (await notices()).find((n) => n.state === "parked"),
      "no parked notice",
    ),
    k = await key(x)
  const go = () => api(x, "notifications/" + n.id + "/retry", {}, { key: k })
  const a = await go()
  assert.deepEqual(await go(), a)
  assert.equal((await notices()).filter((r) => r.subject === x.subject).length, 1)
})
test("J R19 fenced team disproof survives a newer unanimous result", async (t) => {
  const x = await one(t),
    j = await decision(x, "real", { challenge: "disproved" })
  const url = "brief?audience=team&throughSeq=" + j.result.seq,
    text = (await api(x, url)).text
  await decision(x)
  assert.match(text, /disagreed|overturned|disproved|challenged/i)
  assert.equal((await api(x, url)).text, text)
})
test("J R20 an owner brief with a code-only real result retains its code evidence after restore", async (t) => {
  const x = await one(t),
    j = await decision(x, "real", { codeOnly: true })
  await load(x, await save(x))
  const h = (await item(x, x.subject)).findings
    .flatMap((f) => f.claims.flatMap((c) => c.pieces))
    .filter((p) => p.source === "code")
    .map((p) => p.handle)
  assert.ok(h.length)
  const b = await api(x, "brief?audience=owner&throughSeq=" + j.result.seq)
  assert.ok(h.some((i) => b.text.includes(i)))
})
test("J R25 stale undo after restart leaves one return notification", async (t) => {
  const x = await one(t)
  await act(x, x.subject, { action: "done" })
  const k = await key(x),
    actionSeq = (await item(x, x.subject)).incident.way.seq
  const go = () => act(x, x.subject, { action: "undo", actionSeq }, { key: k })
  await go()
  await x.stop()
  await x.start()
  await act(x, x.subject, { action: "undo", actionSeq }, { key: k, code: 409 })
  assert.equal((await api(x, "notifications")).items.filter((n) => n.subject === x.subject).length, 2)
})
test("J Wopen replay after post-response peer outage reuses the completed receipt", async (t) => {
  const x = await one(t),
    k = await key(x),
    go = () => api(x, "open", { subject: x.subject }, { key: k })
  const first = await go()
  x.world({ ocDown: true })
  assert.deepEqual(await go(), first)
  assert.equal(x.p.sessions.size, 1)
})
test("J Wcorrection two different keys legitimately create two identical owner corrections", async (t) => {
  const x = await one(t),
    j = await decision(x),
    path = "items/" + x.subject + "/corrections",
    body = { jobId: j.id, text: "Double-check source" }
  const keys = [await key(x), await key(x)]
  for (const k of keys) await api(x, path, body, { key: k })
  for (const k of keys.reverse()) await api(x, path, body, { key: k })
  assert.equal((await item(x, x.subject)).corrections.length, 2)
})
