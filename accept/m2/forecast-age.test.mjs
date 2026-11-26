import test from "node:test"
import assert from "node:assert/strict"
import { binary, browser } from "./chrome.mjs"
import { capacity, point, forecast } from "../m4/outlook-rig.mjs"

test(
  "a live heartbeat cannot keep an expired forecast on the environment strip",
  { skip: !binary },
  async (t) => {
    const x = await capacity(t)
    for (const n of [20, 30, 40, 50, 60]) await point(x, n)
    assert.equal((await forecast(x)).etaMinutes, 4)
    const b = await browser(t, x)
    await b.visit(x.url + "/")
    await b.wait("document.querySelector('[data-env]')?.innerText.includes('full in')")
    await x.advance(120001) // keep SSE open; no new collection or business change
    assert.equal((await forecast(x)).state, "unknown")
    // Observe that the browser consumed the heartbeat, by its revised countdown or withdrawal.
    await b.wait("!document.querySelector('[data-env]').innerText.includes('~4 min')")
    assert.equal(await b.evaluate("document.querySelector('[data-connection]').dataset.connection"), "live")
    assert.doesNotMatch(await b.evaluate("document.querySelector('[data-env]').innerText"), /full in/)
  },
)

test("a nearly expired estimate disappears on the next page tick with the service clock held", { skip: !binary }, async t => {
  const x = await capacity(t)
  for (const value of [20, 30, 40, 50, 60]) await point(x, value)
  await x.advance(59400)
  assert.equal((await forecast(x)).state, "forecast")
  const b = await browser(t, x)
  await b.visit(x.url + "/")
  await b.wait("document.querySelector('[data-env]')?.innerText.includes('full in')")
  await b.wait("document.querySelector('[data-connection=live]') && !document.querySelector('[data-env]').innerText.includes('full in')",
    "local elapsed time must expire the estimate before the next successful measurement", 4500)
  assert.equal((await forecast(x)).state, "forecast", "the descriptor clock stayed fixed")
})
