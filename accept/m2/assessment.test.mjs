import test from "node:test"
import assert from "node:assert/strict"
import { rig } from "../m1/rig.mjs"
import { act, item, live } from "./api.mjs"
import { browser, binary } from "./chrome.mjs"

test("U01 returning to the same disposition through undo does not validate the old basis", async (t) => {
  const x = await live(t),
    id = (await x.status()).incidents[0].id
  const old = (await item(x, id)).incident.decidedSeq
  assert.equal(typeof old, "number")
  await act(x, id, { action: "later", basisSeq: old })
  const way = (await item(x, id)).incident.way
  await act(x, id, { action: "undo", actionSeq: way.seq })
  assert.equal((await item(x, id)).incident.way, null)
  await act(x, id, { action: "never", basisSeq: old }, { code: 409 })
  assert.equal((await item(x, id)).incident.way, null)
})
test(
  "U02 the rendered health cell stays uncertain when new replies only return the old point",
  { skip: !binary },
  async (t) => {
    const x = await rig(t, { both: true }),
      s = x.cfg.apps.shop.environments.prod.sources
    delete s.pods
    s.dd.readings = ["metrics"]
    x.world({ ddPointTime: x.now() })
    x.save()
    await x.start()
    await x.poll()
    const b = await browser(t, x)
    await b.visit(x.url + "/")
    await b.wait("!!document.querySelector('[data-health=quiet]')")
    await x.advance(240000)
    await x.poll()
    const status = await x.status()
    assert.equal(status.metrics[0].atMs, x.now() - 240000)
    // Reload to remove any ambiguity about stream scheduling: this is the actual post-poll picture.
    await b.visit(x.url + "/")
    await b.wait("!!document.querySelector('[data-connection=live]')")
    const health = await b.evaluate("document.querySelector('[data-env]').dataset.health")
    assert.notEqual(health, "quiet", "Chrome renders quiet for stale provider sample")
  },
)
test(
  "U03 switching brief audience cannot silently discard an edit made while its request waits",
  { skip: !binary },
  async (t) => {
    const x = await live(t),
      b = await browser(t, x)
    await b.visit(x.url + "/")
    await b.wait("!!document.querySelector('[data-connection=live]')")
    await b.evaluate(
      "window.gate=Promise.withResolvers();const oldFetch=window.fetch;window.fetch=async(...a)=>{if(String(a[0]).includes('brief?audience=team'))await gate.promise;return oldFetch(...a)};true",
    )
    await b.key("b")
    await b.wait("document.querySelector('[data-brief-text]')?.value.includes('What changed')")
    await b.evaluate(
      "const s=document.querySelector('[data-brief-audience]');s.value='team';s.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-brief-text]').focus();true",
    )
    if (await b.evaluate("document.querySelector('[data-brief-text]').matches(':disabled,[readonly]')")) {
      await b.evaluate("gate.resolve();true")
      return
    }
    await b.type("Keep this owner edit")
    await b.evaluate("gate.resolve();true")
    await new Promise((r) => setTimeout(r, 250))
    assert.match(
      await b.evaluate("document.querySelector('[data-brief-text]').value"),
      /Keep this owner edit/,
    )
  },
)
