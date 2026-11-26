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
  wire.cut()
  const until = Date.now() + 5000
  while (!wire.hanging() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(wire.hanging(), "page status request is outstanding")
  // Advance the browser’s own timers even with network fetches pending.
  await b.cmd("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 16000 })
  await b.wait(state + "==='stale'", "stale after 15 seconds")
  assert.equal(await b.evaluate("document.querySelectorAll('[data-env][data-health=quiet]').length"), 0)
  assert.match(await b.evaluate("document.body.innerText"), /stale/i)
  await b.cmd("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 15000 })
  await b.wait(state + "==='down'", "service down after 30 seconds")
  assert.ok(wire.hanging())
  assert.match(await b.evaluate("document.body.innerText"), /service not answering/i)
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
