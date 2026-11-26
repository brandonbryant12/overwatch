// One neighbour of each assessor probe, through the real executable and (for the page) system Chrome.
// Manual, outside `pnpm run check`:  node --no-warnings --test --test-concurrency=2 test/real/neighbour-probes.mjs
import test from "node:test"
import assert from "node:assert/strict"
import { rig, iso, stamp, T } from "../../accept/m1/rig.mjs"
import { api, act, item, live, tick, inbox } from "../../accept/m2/api.mjs"
import { browser, binary } from "../../accept/m2/chrome.mjs"

const minute = 60000, hour = 3600000, day = 86400000
const optional = { skip: binary ? false : "no Chrome" }
async function dd(t, readings, patch = {}) {
  const x = await rig(t, { both: true })
  const s = x.cfg.apps.shop.environments.prod.sources
  delete s.pods; s.dd.readings = readings; x.save(); x.world(patch); await x.start(); await x.poll()
  return x
}
async function pods(t, readings, patch = {}) {
  const x = await rig(t)
  x.cfg.apps.shop.environments.prod.sources.pods.readings = readings; x.save(); x.world(patch); await x.start(); await x.poll()
  return x
}
const step = async (x, patch, ms = minute, wall = ms) => { x.world(patch); await x.advance(ms, wall); await x.poll(); return x.status() }

test("N01' an overflowing event counter is not a measured count", async t => {
  const event = n => ({ metadata: { uid: "u" }, type: "Warning", reason: "Mount", message: "m", count: n, eventTime: stamp })
  const x = await pods(t, ["events"], { events: [event("1e999")] })
  assert.equal((await x.status()).incidents[0].count, 1)
})
test("N04' a refused usage reading between low samples keeps the breach", async t => {
  const x = await pods(t, ["usage"], { memory: "500Mi" })
  await step(x, {})
  await step(x, { memory: "100Mi" })
  await step(x, { usageFailure: "Forbidden: cannot list resource pods.metrics.k8s.io" })
  assert.equal((await step(x, { usageFailure: null })).metrics[0].breach, true)
})
// N07' (a Kubernetes line without a readable time) is in test/kubernetes.test.ts: this rig's fake drops such lines.
test("N08' an owner action during a disk pause is refused and writes nothing", async t => {
  const x = await live(t), id = (await inbox(x)).groups.needsYou[0]
  await x.control("space", { freeBytes: 1, dbBytes: 1000 })
  const before = (await x.status()).seq
  await act(x, id, { action: "done" }, { code: 503 })
  assert.equal((await x.status()).seq, before)
})
test("N09' a cited real finding older than the evidence horizon keeps its evidence without pressure", async t => {
  const x = await rig(t); await x.start("demo")
  await x.advance(40 * day); await x.poll()
  assert.equal((await api(x, "search?q=logged%20daily")).items.length, 1)
})
test("N11' restore refuses a question whose job is gone", async t => {
  const { DatabaseSync } = await import("node:sqlite")
  const x = await live(t), id = (await inbox(x)).groups.needsYou[0]
  const { requestKey } = await api(x, "focus?subject=" + id)
  await api(x, "ask", { subject: id, text: "why", mode: "auto" }, { key: requestKey })
  const file = x.dir("q.db"); await x.json("backup", ["--to", file]); await x.stop()
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  db.prepare("update asks set job_id='job_gone'").run(); db.close()
  assert.equal((await x.cli("restore", ["--from", file])).code, 5)
})
test("N13' a monitor that recovers goes quiet after three measured intervals", async t => {
  const x = await dd(t, ["monitors"], { monitors: [{ id: 17, name: "latency", overall_state: "Alert" }] })
  assert.equal((await x.status()).environments[0].health, "attention")
  let s
  for (let i = 0; i < 3; i++) s = await step(x, { monitors: [] })
  assert.deepEqual([s.incidents[0].active, s.environments[0].health], [false, "quiet"])
})
test("N14' two Kubernetes sources on one context share one refused sign-in, on different namespaces", async t => {
  const x = await rig(t), s = x.cfg.apps.shop.environments.prod.sources
  s.other = { ...s.pods, namespace: "other" }; x.save(); x.world({ kubeFailure: "Unauthorized" }); await x.start(); await x.poll()
  assert.deepEqual([(await x.status()).sources.map(r => r.failure), x.calls().filter(c => c.name === "kubectl").length], [["signin", "signin"], 1])
})
test("P01' a wall clock moving backwards between polls never completes an interval", async t => {
  const x = await live(t), id = (await x.status()).incidents[0].id
  for (let i = 0; i < 4; i++) await tick(x, [], minute, -minute)
  assert.equal((await item(x, id)).incident.active, true)
})
test("P02' a failed pass between ordinary ones restarts the count toward Quiet", async t => {
  const x = await live(t), id = (await x.status()).incidents[0].id
  await tick(x); await tick(x); x.world({ kubeFailure: "network unreachable" }); await tick(x); x.world({ kubeFailure: null }); await tick(x)
  assert.equal((await item(x, id)).incident.active, true)
})
test("P03' Later with a time after a restart with the wall a day behind comes back on elapsed time", async t => {
  const x = await live(t), id = (await x.status()).incidents[0].id
  await act(x, id, { action: "later", untilMs: x.now() + 2 * hour })
  await x.advance(0, -day); await x.stop(); await x.start()
  await x.advance(2 * hour + 1, 0); await x.poll()
  assert.equal((await item(x, id)).incident.returned?.code, "deadline")
})
test("P05' a return's stored position is its event's position, after the deadline event", async t => {
  const x = await live(t), id = (await x.status()).incidents[0].id
  await act(x, id, { action: "later", untilMs: x.now() + minute }); await tick(x, [], minute)
  const d = await item(x, id), e = d.history.find(e => e.kind === "returned"), dl = d.history.find(e => e.kind === "deadline")
  assert.deepEqual([d.incident.returned.seq, d.incident.returned.causeSeq, d.incident.decidedSeq], [e.seq, dl.seq, e.seq])
})
test("P06' Never with an unknown baseline does not come back on rate", async t => {
  const x = await live(t, ["ERROR payments", "ERROR payments"]), id = (await x.status()).incidents[0].id
  x.world({ lines: x.w().lines.slice(1) }); await tick(x)
  await act(x, id, { action: "never" })
  await tick(x, Array(12).fill("ERROR payments"))
  assert.equal((await item(x, id)).incident.way?.kind, "never")
})
test("P07' coverage older than thirty days leaves without pressure", async t => {
  const x = await dd(t, ["logs"])
  await x.advance(31 * day); await x.poll(); await x.advance(minute); await x.poll(); await x.stop()
  const old = x.inspect(db => db.prepare("select count(*) n from coverage where to_ms < ?").get(x.now() - 30 * day).n)
  assert.equal(old, 0)
})
test("P08' search folds case beyond lower-casing: straße finds STRASSE", async t => {
  const x = await live(t, ["ERROR STRASSE closed"])
  assert.equal((await api(x, "search?q=" + encodeURIComponent("straße"))).items.length, 1)
})
test("P09' uncited trial evidence leaves by age after seven days, cited trial evidence stays", async t => {
  const x = await rig(t); await x.start(); await x.json("trial")
  const before = x.inspect ? null : null
  await x.advance(8 * day); await x.poll(); await x.stop()
  const [all, cited] = x.inspect(db => [db.prepare("select count(*) n from evidence").get().n, db.prepare("select count(*) n from citations").get().n])
  assert.ok(cited >= 5 && all === cited, `${all} pieces, ${cited} cited`)
  void before
})
test("P21' a cursor from one query is refused for another", async t => {
  const word = n => String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26))
  const x = await live(t, Array.from({ length: 55 }, (_, n) => "ERROR retry " + word(n)))
  const first = await api(x, "search?q=retry")
  assert.ok(first.nextCursor)
  await api(x, "search?q=other&cursor=" + encodeURIComponent(first.nextCursor), undefined, { code: 400 })
})

// ---------------------------------------------------------------- page neighbours
const state = "document.querySelector('[data-connection]')?.dataset.connection"
async function page(t, x) {
  const b = await browser(t, x); await b.visit(x.url + "/"); await b.wait(state + "==='live'"); return b
}
test("P12' Enter then Shift+Enter while the first is in flight queues one request", optional, async t => {
  const x = await live(t), b = await page(t, x)
  await b.evaluate(`window.gate=Promise.withResolvers();const f=fetch;window.fetch=async(...a)=>{if(String(a[0]).endsWith('/ask'))await gate.promise;return f(...a)};true`)
  await b.key("j"); await b.key("p"); await b.type("once")
  await b.key("Enter")
  await b.cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", modifiers: 8 })
  await b.evaluate("gate.resolve();new Promise(r=>setTimeout(r,400))")
  const id = (await x.status()).incidents[0].id
  assert.equal((await item(x, id)).history.filter(e => e.kind === "asked").length, 1)
})
test("P13' a refused ask keeps the draft", optional, async t => {
  const x = await live(t), b = await page(t, x)
  await b.key("j"); await b.key("p"); await b.type("keep me")
  await b.evaluate(`const f=fetch;window.fetch=async(...a)=>String(a[0]).endsWith('/ask')?new Response('{"error":{"message":"no"}}',{status:500}):f(...a);true`)
  await b.key("Enter"); await b.evaluate("new Promise(r=>setTimeout(r,300))")
  assert.equal(await b.evaluate("document.querySelector('[data-prompt]').value"), "keep me")
})
test("P14' a hostile title stays inside a phone-width viewport", optional, async t => {
  const x = await live(t, ["ERROR <script>x</script>" + "y".repeat(2000)]), b = await page(t, x)
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await b.key("j"); await b.evaluate("new Promise(r=>setTimeout(r,300))")
  const [w, v, scripts] = await b.evaluate("[document.documentElement.scrollWidth, innerWidth, document.querySelectorAll('[data-stage] script').length]")
  assert.ok(w <= v, `${w} > ${v}`); assert.equal(scripts, 0)
})
test("P17' a source found by search can be focused and asked about", optional, async t => {
  const x = await live(t), s = await x.status(), src = s.sources[0].subject
  const { requestKey } = await api(x, "focus?subject=" + encodeURIComponent(src))
  await api(x, "ask", { subject: src, text: "unusual-source-question", mode: "auto" }, { key: requestKey })
  const b = await page(t, x)
  await b.key("/"); await b.type("unusual-source-question")
  await b.wait("!!document.querySelector('[data-result-id]')"); await b.key("Enter")
  await b.wait("document.querySelector('[data-focus-id]')?.dataset.focusId===" + JSON.stringify(src))
})
test("P18' a question asked in another tab appears in this tab's open item", optional, async t => {
  const x = await live(t), id = (await x.status()).incidents[0].id, b = await page(t, x)
  await b.key("j"); await b.wait("!!document.querySelector('[data-stage] .history')")
  const { requestKey } = await api(x, "focus?subject=" + id)
  await api(x, "ask", { subject: id, text: "from-the-other-tab", mode: "auto" }, { key: requestKey })
  await b.wait("document.querySelector('[data-stage]').innerText.includes('from-the-other-tab')")
})
test("P19' a returned item counts as new, not as moved", optional, async t => {
  const x = await live(t), id = (await x.status()).incidents[0].id
  await act(x, id, { action: "later", untilMs: x.now() + minute })
  const b = await page(t, x)
  await tick(x, [], minute)
  await b.wait("document.querySelector('[data-pending-count]').dataset.pendingCount==='1'")
  assert.match(await b.evaluate("document.querySelector('[data-pending-count]').innerText"), /1 new/)
})
test("P20' Enter with an environment in focus goes to the bar, not the finder", optional, async t => {
  const x = await live(t), b = await page(t, x)
  await b.evaluate("document.querySelector('[data-env]').click()"); await b.key("Enter")
  assert.equal(await b.evaluate("document.activeElement.matches('[data-prompt]')"), true)
})
