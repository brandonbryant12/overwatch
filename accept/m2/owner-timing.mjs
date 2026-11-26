// Run explicitly with node --test. Elapsed times cover real Chrome input and visible completion.
import test from "node:test"
import assert from "node:assert/strict"
import { rig, stamp } from "../m1/rig.mjs"
import { finished, send, model, until } from "../m3/rig.mjs"
import { browser, binary } from "./chrome.mjs"

async function fleet(x) {
  const environments = x.cfg.apps.shop.environments
  const template = structuredClone(environments.prod)
  x.cfg.watchers = []
  const namespaceLines = {}
  for (const [i, environment] of ["prod", "qa", "stage", "test", "load", "canary"].entries()) {
    const e = environments[environment] = structuredClone(template)
    e.sources.pods.namespace = environment
    e.sources.pods.readings = ["logs", "workloads"]
    x.cfg.watchers.push({ app: "shop", environment, every: "1m" })
    namespaceLines[environment] = Array.from({ length: 33 + Number(i < 2) }, (_, j) => {
      const label = String.fromCharCode(97 + Math.floor(j / 26), 97 + j % 26)
      return [stamp, "ERROR worker " + label]
    })
  }
  x.world({ namespaceLines }); x.save(); await x.start(); await x.poll()
  const ids = (await x.status()).incidents.map((i) => i.id)
  const start = (id) => send(x, "items/" + id + "/investigate", {}, 202, id)
  for (const [index, votes] of [
    ["real", "real", "real"],
    ["real", "not_real", "real"],
    ["ramble", "unsure", "not_real"],
    ["not_real", "not_real", "not_real"],
  ].entries()) {
    model(x, votes)
    await finished(x, (await start(ids[index])).jobId)
  }
  x.p.workScript = async () => ""
  const parked = await send(
    x,
    "ask",
    { subject: ids[4], text: "No response fixture", mode: "new" },
    200,
    ids[4],
  )
  assert.equal((await finished(x, parked.jobId)).state, "parked")
  const hold = Promise.withResolvers()
  x.p.workScript = async () => {
    await hold.promise
    return "Fixture complete"
  }
  await start(ids[5])
  await start(ids[6])
  await until(
    x,
    async () => {
      const states = (await x.status()).jobs.map((j) => j.state)
      return ["queued", "running", "completed", "parked"].every((s) => states.includes(s))
    },
    "did not reach all queue states",
  )
  return hold

}
const focus = "document.querySelector('[data-focus-id]')?.dataset.focusId"
const count = "document.querySelectorAll('[data-item-id]').length"
for (const kind of ["demo", "fleet"]) test("owner keyboard timings, " + kind, { skip: !binary }, async t => {
  const x = await rig(t)
  const hold=kind === "fleet" ? await fleet(x) : null
  if (!hold) await x.start("demo")
  if (hold) t.after(()=>hold.resolve())
  const b = await browser(t, x)
  await b.cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await b.visit(x.url + "/"); await b.wait("document.querySelector('[data-connection=live]')")
  const s = await x.status()
  assert.deepEqual([s.incidents.length, s.environments.length], kind === "demo" ? [5, 3] : [200, 6])
  const time = async (label, fn) => {
    const start = performance.now(); await fn()
    t.diagnostic(label + " " + Math.round(performance.now() - start) + " ms")
  }
  await b.key("Enter")
  t.diagnostic("Empty-focus Enter targets " + await b.evaluate("document.activeElement.outerHTML.slice(0,85)"))
  await b.key("Escape")
  await b.key("j"); await b.key("j")
  for (const key of ["d", "l", "n"]) {
    const id = await b.evaluate(focus)
    await time(key, async () => {
      await b.key(key)
      if (key !== "d") { await b.wait("document.querySelector('[role=dialog]')"); await b.key("Enter") }
      await b.wait("!document.querySelector('[data-item-id=" + id + "]')")
    })
    await time("undo " + key, async () => { await b.key("u"); await b.wait("document.querySelector('[data-item-id=" + id + "]') && " + focus + "===" + JSON.stringify(id)) })
  }
  const target = kind === "demo" ? "search index rebuild" : "worker ab"
  await time("find and open " + target, async () => {
    await b.key("/"); await b.type(target); await b.wait("document.querySelector('[data-result-id]')")
    const id = await b.evaluate("document.querySelector('[data-result-id]').dataset.resultId")
    await b.key("Enter"); await b.wait(focus + "===" + JSON.stringify(id))
  })
  await time("ask", async () => {
    await b.key("p"); await b.type("Explain the onset"); await b.key("Enter")
    await b.wait("document.querySelector('[data-toast]').innerText.includes('Queued')")
  })
  await b.key("Escape")
  await b.evaluate(
    "Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copied=text}});true",
  )
  await time("brief open, edit and copy", async () => {
    await b.key("b")
    await b.wait("document.querySelector('[data-brief-text]')?.value.includes('What changed')")
    await b.key("Tab")
    assert.ok(await b.evaluate("document.activeElement.matches('[data-brief-text]')"))
    await b.type("Owner edit. ")
    const expected = await b.evaluate("document.activeElement.value")
    assert.ok(expected.includes("Owner edit. "))
    await b.key("Tab")
    await b.key("Tab")
    assert.ok(await b.evaluate("document.activeElement.matches('[data-brief-copy]')"))
    await b.key("Enter")
    await b.wait("window.copied===" + JSON.stringify(expected))
  })
  await b.key("Escape")
  await b.evaluate("document.querySelector('[data-toggle=working]').click()")
  await b.visit(x.url + "/"); await b.wait("document.querySelector('[data-connection=live]')")
  t.diagnostic("Working expanded after reload: " + await b.evaluate("document.querySelector('[data-toggle=working]').getAttribute('aria-expanded')"))
  t.diagnostic("seen rows: " + (await x.status()).incidents.filter(i => i.seenSeq > 0).length)
  await b.evaluate("while(document.querySelector('[data-toggle][aria-expanded=false]')) document.querySelector('[data-toggle][aria-expanded=false]').click()")
  const n = await b.evaluate(count)
  await time("clear " + n + " rows", async () => {
    await b.key("j")
    for (let left = n; left > 0; left--) {
      await b.key("d"); await b.wait(count + "===" + (left - 1))
    }
    assert.equal(Object.values((await x.status()).inbox.groups).flat().length, 0)
  })
})
