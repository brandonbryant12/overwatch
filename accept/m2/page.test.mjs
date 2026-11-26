import assert from "node:assert/strict"
import test from "node:test"
import { createServer, request } from "node:http"
import { once } from "node:events"
import { browser, binary } from "./chrome.mjs"
import { rig } from "../m1/rig.mjs"
import { act, item, live, tick } from "./api.mjs"

const optional = { skip: binary ? false : "system Chrome unavailable; set CHROME_BIN to run rendered acceptance" }
const rows = "Array.from(document.querySelectorAll('[data-item-id]')).filter(e=>e.getClientRects().length).map(e=>e.dataset.itemId)"
const focused = "document.querySelector('[data-focus-id]')?.dataset.focusId"
const prompt = "document.querySelector('[data-prompt]')"
const state = "document.querySelector('[data-connection]')?.dataset.connection"
const cell = s => "document.querySelector(" + JSON.stringify('[data-env="' + s + '"]') + ")?.dataset.health"

async function open(t, x, url = x.url) {
  const response = await fetch(url + "/", { signal: AbortSignal.timeout(4000) })
  await response.body.cancel()
  assert.equal(response.status, 200, "GET / returned " + response.status)
  const b = await browser(t, x)
  await b.visit(url + "/")
  assert.match(await b.evaluate("document.contentType"), /text\/html/, "GET / must render the page")
  await b.wait(state + "==='live'", "live page after first snapshot")
  return b
}

test("Chrome CDP fixture drives an isolated document and real keyboard input", optional, async t => {
  const x = await rig(t)
  const b = await browser(t, x)
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<input autofocus>") })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => { server.closeAllConnections(); server.close() })
  await b.visit("http://127.0.0.1:" + server.address().port + "/")
  await b.evaluate("document.querySelector('input').focus()")
  await b.type("fixtur")
  await b.key("e")
  assert.equal(await b.evaluate("document.querySelector('input').value"), "fixture")
})

test("rendered inbox holds row positions, current subject and draft while new work arrives", optional, async t => {
  const x = await live(t, ["ERROR hearth", "ERROR ledger"])
  const b = await open(t, x)
  const prior = await b.evaluate(rows)
  assert.ok(prior.length >= 2)
  await b.key("j")
  const id = await b.evaluate(focused)
  assert.ok(prior.includes(id))
  await b.key("p")
  await b.type("draft with d l n u")
  const rowTop = "document.querySelector('[data-item-id=' + CSS.escape(" + JSON.stringify(id) + ") + ']').getBoundingClientRect().top"
  const priorTop = await b.evaluate(rowTop)
  await tick(x, ["ERROR fresh"])
  const fresh = (await x.status()).incidents.find(i => i.title.includes("fresh")).id
  await b.wait("Number(document.querySelector('[data-pending-count]')?.dataset.pendingCount) === 1", "queued arrival count")
  assert.deepEqual(await b.evaluate(rows), prior)
  assert.equal(await b.evaluate(focused), id)
  assert.equal(await b.evaluate(prompt + ".value"), "draft with d l n u")
  assert.equal(await b.evaluate(rowTop), priorTop)
  await b.key("Escape")
  await b.key("r")
  await b.wait(rows + ".includes(" + JSON.stringify(fresh) + ")", "explicit refresh releases new row")
})

for (const [key, action] of [["d", "done"], ["l", "later"], ["n", "never"]])
  test("keyboard " + action + " and U restore the same item", optional, async t => {
    const x = await live(t)
    const b = await open(t, x)
    await b.key("j")
    const id = await b.evaluate(focused)
    await b.key(key)
    if (key !== "d") {
      await b.wait("!!document.querySelector('[role=dialog],dialog[open]')", "confirmation sheet")
      await b.key("Enter")
    }
    await b.wait("!(" + rows + ").includes(" + JSON.stringify(id) + ")", "item leaves inbox")
    assert.equal((await item(x, id)).incident.way.kind, action)
    await b.key("u")
    await b.wait(rows + ".includes(" + JSON.stringify(id) + ")", "undo restores row")
    assert.equal((await item(x, id)).incident.way, null)
  })

test("search opened from keyboard focuses archived item; one bar submits to that subject", optional, async t => {
  const x = await live(t)
  const id = (await x.status()).incidents[0].id
  const b = await open(t, x)
  await act(x, id, { action: "done" })
  await b.key("/")
  await b.wait("document.activeElement.matches('[data-search]')", "search field")
  await b.type("payments")
  await b.wait("!!document.querySelector('[data-result-id]')", "archived result")
  await b.key("Enter")
  await b.wait(focused + "===" + JSON.stringify(id), "focus matches result")
  await b.key("p")
  await b.type("explain onset")
  await b.key("Enter")
  const deadline = Date.now() + 4000
  do {
    const d = await item(x, id)
    if (d.history.some(e => e.kind === "asked" && e.data.text === "explain onset")) return
    await new Promise(resolve => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  assert.fail("no asked event for focused subject")
})

// A real same-origin forwarding server. While disconnected, SSE retries and GET /status remain unanswered.
async function link(t, x) {
  let blocked = false, hanging = 0
  const streams = new Set()
  const server = createServer((req, res) => {
    if (blocked && ["/v2/changes", "/v2/status"].includes(req.url)) {
      if (req.url === "/v2/status") { hanging++; res.on("close", () => hanging--) }
      return
    }
    if (req.url === "/v2/changes") { streams.add(res); res.on("close", () => streams.delete(res)) }
    const upstream = request(new URL(req.url, x.url), { method: req.method,
      headers: { ...req.headers, host: new URL(x.url).host, origin: x.url } }, source => {
      res.writeHead(source.statusCode, source.headers)
      source.pipe(res)
      res.on("close", () => source.destroy())
    })
    upstream.on("error", () => res.destroy())
    res.on("close", () => upstream.destroy())
    req.pipe(upstream)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => { const end = once(server, "close"); server.close(); server.closeAllConnections(); await end })
  return { url: "http://127.0.0.1:" + server.address().port, hanging: () => hanging,
    cut() { assert.ok(streams.size); blocked = true; for (const s of streams) s.destroy() },
    resume() { blocked = false; server.closeAllConnections() } }
}

test("page ages under a hanging status request and reconnects with draft and focus intact", optional, async t => {
  const x = await rig(t)
  await x.start("demo")
  const wire = await link(t, x), b = await open(t, x, wire.url)
  await b.wait(cell("staging") + "==='quiet'", "measured staging is initially quiet")
  assert.equal(await b.evaluate(cell("qa")), "signed_out")
  await b.key("j")
  const subject = await b.evaluate(focused)
  await b.key("p")
  await b.type("keep this draft")
  const connection = "document.querySelector('[data-connection]')"
  const ink = () => b.evaluate("getComputedStyle(" + connection + ").color")
  const caption = () => b.evaluate(connection + ".innerText")
  const liveInk = await ink()
  assert.match(await caption(), /live/i)
  wire.cut()
  const until = Date.now() + 5000
  while (!wire.hanging() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(wire.hanging(), "page status request is outstanding")
  // Advance the browser’s own timers even with network fetches pending.
  await b.cmd("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 16000 })
  await b.wait(state + "==='stale'", "stale after 15 seconds")
  assert.equal(await b.evaluate("document.querySelectorAll('[data-env][data-health=quiet]').length"), 0)
  assert.match(await caption(), /stale/i)
  assert.notEqual(await ink(), liveInk)
  const staleInk = await ink()
  await b.cmd("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 15000 })
  await b.wait(state + "==='down'", "service down after 30 seconds")
  assert.ok(wire.hanging())
  assert.match(await caption(), /not answering/i)
  assert.notEqual(await ink(), staleInk)
  assert.notEqual(await ink(), liveInk)
  assert.match(await b.evaluate("document.querySelector('[role=alert]').innerText"), /service not answering/i)
  assert.match(await b.evaluate("document.body.innerText"), /overwatch (restart|serve)/i)
  assert.ok(await b.evaluate("document.querySelector('[data-action=done]')?.matches(':disabled,[aria-disabled=true]')"))
  assert.equal(await b.evaluate(prompt + ".value"), "keep this draft")
  assert.equal(await b.evaluate(focused), subject)
  const before = (await x.status()).seq
  await b.key("Enter")
  assert.equal((await x.status()).seq, before)
  wire.resume()
  await b.cmd("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 6000 })
  await b.wait(state + "==='live'", "fresh snapshot restores live state", 10000)
  assert.equal(await b.evaluate(prompt + ".value"), "keep this draft")
  assert.equal(await b.evaluate(focused), subject)
})

test("unmeasured environment stays out of quiet and supplies its own prompt focus", optional, async t => {
  const x = await rig(t)
  x.cfg.apps.shop.environments.prod.sources.pods.readings = ["usage"]
  x.save()
  x.world({ emptyUsage: true })
  await x.start()
  await x.poll()
  const b = await open(t, x)
  const environment = (await x.status()).environments[0]
  assert.ok(["stale", "partial"].includes(environment.health))
  assert.equal(await b.evaluate(cell("prod")), environment.health)
  await b.evaluate("document.querySelector('[data-env=prod]').click()")
  await b.key("p")
  await b.type("check environment")
  await b.key("Enter")
  const deadline = Date.now() + 4000
  do {
    const status = await x.status()
    if (status.jobs.some(j => j.subject === environment.subject)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  assert.fail("environment prompt did not queue for its own subject")
})

test("Chrome fixture can keep status pending while the page timer crosses both deadlines", optional, async t => {
  const x = await rig(t)
  await x.start()
  const wire = await link(t, x)
  const b = await browser(t, x)
  // Exercise the transport and real browser timers independently of the future page.
  await b.visit(wire.url + "/v2/status")
  await b.evaluate(`window.first = false; window.serviceEvents = new EventSource('/v2/changes');
    serviceEvents.addEventListener('snapshot', () => { first = true });
    serviceEvents.onerror = () => { if (!window.pending) window.pending = fetch('/v2/status') };
    window.beats = 0; setInterval(() => { window.beats++ }, 1000); true`)
  await b.wait("window.first", "real initial snapshot")
  wire.cut()
  const limit = Date.now() + 4000
  while (!wire.hanging() && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(wire.hanging(), "held loopback request")
  const ticks = await b.evaluate("window.beats")
  await b.cmd("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 31000 })
  await b.wait("window.beats >= " + (ticks + 30), "page timer fires despite pending status")
  assert.ok(wire.hanging())
})

test("P11 healthy heartbeats during a hung collector must age the green strip", optional, async t => {
  const x = await rig(t, { both: true }), s = x.cfg.apps.shop.environments.prod.sources
  delete s.pods; s.dd.readings = ["logs"]; x.save(); await x.start(); await x.poll()
  const b = await open(t, x)
  await b.wait(cell("prod") + "==='quiet'")
  // Observe the same heartbeat independently, then allow the page's next one-second repaint.
  await b.evaluate("window.beatSeq=null;window.obs=new EventSource('/v2/changes');obs.addEventListener('heartbeat',e=>beatSeq=JSON.parse(e.data).atMs)")
  const started = Promise.withResolvers(), release = Promise.withResolvers()
  x.p.holdDD = { started, promise: release.promise }
  await x.advance(60000)
  const pending = x.poll()
  try {
    await started.promise; await x.advance(181000)
    assert.equal((await x.status()).environments[0].health, "stale")
    await b.wait("window.beatSeq===" + x.now(), "healthy transport still delivers heartbeat")
    await b.evaluate("new Promise(r=>setTimeout(r,1150))")
    assert.notEqual(await b.evaluate(cell("prod")), "quiet")
  } finally { release.resolve(); await pending }
})

test("P12 a double Enter while focus lookup is pending queues one page draft", optional, async t => {
  const x = await live(t), b = await open(t, x)
  await b.evaluate(`window.gate=Promise.withResolvers();window.focusCalls=0;
    const originalFetch=window.fetch;window.fetch=async(...args)=>{
      if(String(args[0]).includes('focus?')){window.focusCalls++;await window.gate.promise}
      return originalFetch(...args)
    };true`)
  await b.key("j"); await b.key("p"); await b.type("investigate twice")
  await b.key("Enter"); await b.key("Enter")
  await b.evaluate("gate.resolve();true")
  await b.wait("document.querySelector('[data-toast]').innerText.includes('Queued') || document.querySelector('[data-toast]').innerText.includes('Added')")
  await b.evaluate("new Promise(r=>setTimeout(r,250))")
  const d = await item(x, (await x.status()).incidents[0].id)
  assert.equal(d.history.filter(e => e.kind === "asked").length, 1)
})

test("P13 a delayed ask response preserves the next draft already in the bar", optional, async t => {
  const x = await live(t), b = await open(t, x)
  await b.key("j"); await b.key("p"); await b.type("first question")
  await b.evaluate(`window.gate=Promise.withResolvers();window.saved=false;const f=fetch;
    window.fetch=async(...a)=>{const r=await f(...a);if(String(a[0]).endsWith('/ask')){window.saved=true;await gate.promise}return r};true`)
  await b.key("Enter"); await b.wait("saved"); await b.evaluate("document.querySelector('[data-prompt]').select()")
  await b.type("second draft"); await b.evaluate("gate.resolve();true")
  await b.wait("document.querySelector('[data-toast]').innerText.includes('Queued')")
  assert.equal(await b.evaluate(prompt + ".value"), "second draft")
})
test("P14 literal markup, long text and a tab stay readable as text on the focused page", optional, async t => {
  const word = "ERROR <em>billing</em>\t" + "x".repeat(1500)
  const x = await live(t, [word]), b = await open(t, x)
  await b.key("j"); const heading = "document.querySelector('[data-stage] h2')"
  assert.equal(await b.evaluate(heading + ".querySelector('em')"), null)
  assert.match(await b.evaluate(heading + ".textContent"), /<em>billing<\/em>/)
  const [width, viewport] = await b.evaluate("[document.documentElement.scrollWidth,innerWidth]")
  assert.ok(width <= viewport, `focused page width ${width} at viewport ${viewport}`)
})
test("P15 a second tab can see a disposition without silently replacing it from its old sheet", optional, async t => {
  const x = await live(t), a = await open(t, x), b = await open(t, x)
  await b.key("j"); await b.key("l")
  await b.wait("!!document.querySelector('[role=dialog]')")
  await a.key("j"); await a.key("n"); await a.key("Enter")
  await a.wait("document.querySelector('[data-toast]').innerText.includes('Never')")
  await b.key("Enter")
  // A changed sheet must either dismiss or ask the owner to confirm the new context.
  await b.evaluate("new Promise(r=>setTimeout(r,250))")
  assert.equal((await item(x, (await x.status()).incidents[0].id)).incident.way.kind, "never")
})
test("P16 a failed or delayed status read cannot re-green disconnected health after a wall-clock jump", optional, async t => {
  for (const outcome of ["reject", "late"]) {
    const x = await rig(t); await x.start("demo")
    const wire = await link(t, x), b = await open(t, x, wire.url)
    await b.evaluate(`window.gate=Promise.withResolvers();window.asked=false;const f=fetch;const good=f('/v2/status');
      window.fetch=async(...args)=>{if(String(args[0]).endsWith('/status')){window.asked=true;await gate.promise;
      if(${JSON.stringify(outcome)}==='reject')throw Error('fixture unavailable');return good}return f(...args)};true`)
    wire.cut(); await b.wait("asked")
    await b.evaluate("const wall=Date.now.bind(Date);Date.now=()=>wall()+31000;gate.resolve();true")
    await b.wait(state + "==='down'", "wall sleep advances the page clock")
    assert.equal(await b.evaluate(cell("staging")), "unknown")
  }
})

test("P17 source listed in the environment can itself be focused for a question", optional, async t => {
  const x = await live(t), s = await x.status(), b = await open(t, x)
  await b.evaluate("document.querySelector('[data-env]').click()")
  const source = s.sources[0]
  await b.evaluate("Array.from(document.querySelectorAll('[data-stage] *')).find(e=>e.textContent===" + JSON.stringify(source.id) + " && !e.children.length).click()")
  assert.equal(await b.evaluate(focused), source.subject)
  await b.key("p"); await b.type("Review this source"); await b.key("Enter")
  await b.wait("document.querySelector('[data-toast]').innerText.includes('Queued')")
  assert.equal((await x.status()).jobs.at(-1).subject, source.subject)
})
test("P18 a queued question appears in the open item's history without reselecting it", optional, async t => {
  const x = await live(t), b = await open(t, x)
  await b.key("j"); await b.wait("document.querySelector('[data-route]').innerText.includes('Queues')")
  await b.key("p"); await b.type("Explain this sample"); await b.key("Enter")
  await b.wait("document.querySelector('[data-toast]').innerText.includes('Queued')")
  await b.wait("document.querySelector('[data-stage] .history')?.innerText.includes('Explain this sample')", "queued question absent from open history")
})
test("P19 a regrouping alone is not labelled as a new arrival", optional, async t => {
  const x = await live(t), b = await open(t, x)
  await tick(x); await tick(x); await tick(x)
  await b.wait("document.querySelector('[data-pending-count]').dataset.pendingCount==='1'")
  const label = await b.evaluate("document.querySelector('[data-pending-count]').innerText")
  assert.doesNotMatch(label, /1 new/i)
  assert.match(label, /chang|mov|quiet|updat/i)
})

test("P20 Enter with nothing in focus opens the finder advertised by the dock", optional, async t => {
  const x = await live(t), b = await open(t, x)
  await b.key("Enter")
  assert.equal(await b.evaluate("document.activeElement.matches('[data-search]')"), true)
})
