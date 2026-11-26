import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { capture, rig } from "../m1/rig.mjs"
import { browser, binary } from "../m2/chrome.mjs"
import { api } from "../m2/api.mjs"
import { service, until } from "./rig.mjs"

// Writes the helper's real argv and exit status beneath the rig's private directory.
function notifier(x, failures) {
  fs.writeFileSync(x.dir("bin/terminal-notifier"), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path')
const ledger=path.join(process.env.OW_FIXTURE,'notifications.jsonl')
const n=fs.existsSync(ledger)?fs.readFileSync(ledger,'utf8').trim().split('\\n').length:0
const code=n<${failures}?1:0
fs.appendFileSync(ledger,JSON.stringify({args:process.argv.slice(2),code})+'\\n')
process.exit(code)
`, { mode: 0o755 })
}
const ledger = x => fs.existsSync(x.dir("notifications.jsonl")) ? fs.readFileSync(x.dir("notifications.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : []
test("fixture local notifier returns failure then success without notifying the desktop", async t => {
  const x = await rig(t); notifier(x, 1)
  const args = ["-group", "fixture", "-title", "Example", "-message", "Local test"]
  for (const code of [1, 0]) assert.equal((await capture(x.dir("bin/terminal-notifier"), args, { env: x.env })).code, code)
  assert.deepEqual(ledger(x), [1, 0].map(code => ({ args, code })))
})
for (const failures of [1, 3]) test("local notification reconciles restart after " + failures + " refused deliveries", async t => {
  const x = await service(t, { before: x => notifier(x, failures) })
  const note = async () => (await api(x, "notifications")).items.find(n => n.subject === x.subject)
  const wait = a => until(x, async () => { const n = await note(); return n?.attempts === a && (n.nextMs || ["delivered", "parked"].includes(n.state)) && n }, "notification attempts " + a)
  const first = await wait(1); assert.ok(first.reason); assert.ok(first.nextMs)
  await x.stop("SIGKILL"); await x.start()
  await x.advance(59999); await x.poll(); assert.equal(ledger(x).length, 1)
  await x.advance(1); const next = await wait(2)
  if (failures === 1) { assert.equal(next.state, "delivered"); assert.equal(next.nextMs, null) }
  else {
    await x.advance(299999); await x.poll(); assert.equal(ledger(x).length, 2)
    await x.advance(1); const end = await wait(3); assert.equal(end.state, "parked"); assert.ok(end.reason)
  }
  await x.advance(600000); await x.poll()
  const entries = ledger(x)
  assert.equal(entries.length, failures === 1 ? 2 : 3)
  for (const e of entries) {
    const group = e.args.indexOf("-group"); assert.ok(group >= 0); assert.equal(e.args[group + 1], first.id)
    assert.ok(e.args.includes("-title") && e.args.includes("-message"))
  }
  assert.equal((await api(x, "notifications")).items.filter(n => n.subject === x.subject).length, 1)
})

test("B opens both brief audiences and Copy uses exactly the edited local text",
  { skip: binary ? false : "requires installed Chrome" }, async t => {
    const x = await service(t), b = await browser(t, x)
    await b.visit(x.url + "/"); await b.wait("document.querySelector('[data-connection=live]')")
    // Isolate the OS clipboard, capture exactly what the product hands the browser.
    await b.evaluate("window.copies=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copies.push(text)}});true")
    await b.key("b"); await b.wait("document.querySelector('[data-brief-text]')", "B did not open the brief editor")
    for (const audience of ["team", "owner"]) {
      await b.evaluate(`var el=document.querySelector('[data-brief-audience]');el.value=${JSON.stringify(audience)};el.dispatchEvent(new Event('change',{bubbles:true}));true`)
      const source = await api(x, "brief?audience=" + audience)
      await b.wait("document.querySelector('[data-brief-text]').value===" + JSON.stringify(source.text))
      await b.evaluate("document.querySelector('[data-brief-text]').select()")
      const text = audience + " edit\nSecond line ✓"; await b.type(text)
      await b.evaluate("document.querySelector('[data-brief-copy]').click()")
      await b.wait("window.copies.at(-1)===" + JSON.stringify(text), "copy preserved edited bytes")
    }
    assert.equal(x.p.deliveries.length, 0)
  })
test("O opens the peer session for the focused incident",
  { skip: binary ? false : "requires installed Chrome" }, async t => {
    const x = await service(t), b = await browser(t, x)
    await b.visit(x.url + "/"); await b.wait("document.querySelector('[data-connection=live]')")
    await b.key("j"); await b.key("o")
    let urls = []
    const end = Date.now() + 3500
    do {
      urls = (await b.cmd("Target.getTargets")).targetInfos.map(t => t.url)
      if (urls.some(u => u.startsWith(x.p.url + "/session/"))) break
      await new Promise(r => setTimeout(r, 50))
    } while (Date.now() < end)
    const url = urls.find(u => u.startsWith(x.p.url + "/session/"))
    assert.ok(url, "O did not open the focused OpenCode session")
    assert.ok(x.p.sessions.has(new URL(url).pathname.split("/").at(-1)))
  })

test("a page prompt sends clean text to the peer and shows its redacted answer after reload",
  { skip: binary ? false : "requires installed Chrome" }, async t => {
    const x = await service(t)
    const inbound = "fixture-lilac-8492", outbound = "fixture-umber-7432"
    x.p.workScript = async ({ s }) => {
      assert.equal(s.agent, "ow-responder")
      return "The queue drained. password=" + outbound
    }
    const b = await browser(t, x)
    await b.visit(x.url + "/"); await b.wait("document.querySelector('[data-connection=live]')")
    await b.key("j"); await b.key("p"); await b.type("Check queue password=" + inbound); await b.key("Enter")
    await until(x, async () => x.p.deliveries.some(d => d.text.includes("Check queue")), "page prompt never delivered")
    assert.ok(!JSON.stringify(x.p.requests).includes(inbound))
    await until(x, async () => (await api(x, "items/" + x.subject)).turns?.some(t => t.answer?.includes("The queue drained.")), "answer missing")
    await b.visit(x.url + "/"); await b.wait("document.querySelector('[data-connection=live]')")
    // Search can reach the same incident independently of its regrouping.
    await b.key("/"); await b.type("checkout"); await b.wait("document.querySelector('[data-result-id]')"); await b.key("Enter")
    await b.wait("document.querySelector('[data-stage]').innerText.includes('The queue drained.')", "answer never rendered")
    const text = await b.evaluate("document.querySelector('[data-stage]').innerText")
    assert.ok(!text.includes(inbound) && !text.includes(outbound))
  })
