import test from "node:test"
import assert from "node:assert/strict"
import { browser, binary } from "./chrome.mjs"
import { fleet } from "./fleet-rig.mjs"
import { fleetPageStates } from "./m4-page-fixture.mjs"
import { rig } from "../m1/rig.mjs"
import { scenario } from "../m4/rig.mjs"
import { item } from "./api.mjs"

for (const mode of ["demo", "fleet"])
  test("time to visible decision evidence in " + mode, { skip: !binary }, async (t) => {
    const x = await rig(t)
    if (mode === "demo") await x.start("demo")
    else {
      const hold = await fleet(x)
      t.after(() => hold.resolve())
    }
    const b = await browser(t, x)
    await b.cmd("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    })
    if (mode === "fleet") {
      await b.cmd("Page.enable")
      await b.cmd("Page.addScriptToEvaluateOnNewDocument", {
        source: "(" + fleetPageStates.toString() + ")()",
      })
      assert.equal((await x.status()).incidents.length, 200)
    }
    await b.visit(x.url + "/")
    await b.wait("document.querySelector('[data-connection=live]')")
    const tasks =
      mode === "demo"
        ? [
            ["review", "no free database connection", "[data-fix]", ["#412", "pool_size", "exit 0", "draft"]],
            ["return", "cache warm-up", "[data-focus-id]", ["not real", "since Later"]],
          ]
        : [["waiting", "worker ab", "[data-fix='fixture-14']", ["five tries", "once the host answers"]]]
    for (const [label, query, selector, facts] of tasks) {
      const start = performance.now()
      await b.key("/")
      await b.type(query)
      await b.wait(
        "Array.from(document.querySelectorAll('[data-result-id]')).some(e=>e.innerText.toLowerCase().includes(" +
          JSON.stringify(query) +
          "))",
      )
      await b.key("Enter")
      const element = "document.querySelector(" + JSON.stringify(selector) + ")"
      for (const fact of facts) {
        const quoted = JSON.stringify(fact.toLowerCase())
        await b.wait(element + "?.innerText.toLowerCase().includes(" + quoted + ")", fact)
        const visible = await b.evaluate(`(() => {
          const panel = ${element}
          const match = Array.from(panel.querySelectorAll("*")).reverse().find(e =>
            e.innerText?.toLowerCase().includes(${quoted}) && e.getClientRects().length)
          if (!match) return false
          match.scrollIntoView({block:"center", behavior:"instant"})
          const r = match.getBoundingClientRect()
          return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
        })()`)
        assert.ok(visible, "could not bring decision evidence into view: " + fact)
      }
      const text = await b.evaluate(element + ".innerText")
      t.diagnostic(
        label +
          " " +
          Math.round(performance.now() - start) +
          " ms: " +
          text.replaceAll("\n", " ").slice(0, 900),
      )
      if (mode === "fleet") {
        const next = await b.evaluate(
          "Array.from(document.querySelectorAll('[data-fix]'),e=>e.querySelector('.next')?.innerText)",
        )
        assert.equal(next.length, 15)
        assert.ok(next.every(Boolean), JSON.stringify(next))
      } else {
        assert.match(
          await b.evaluate("document.querySelector('[data-env=staging]').innerText"),
          /staging check/,
        )
      }
    }
  })

test("an actual open draft hides the proposal control on a fix-enabled app", { skip: !binary }, async (t) => {
  const { x, end } = await scenario(t)
  assert.equal(end.state, "draft")
  assert.equal((await item(x, x.subject)).fixable, true)
  const b = await browser(t, x)
  await b.visit(x.url + "/")
  await b.wait("document.querySelector('[data-connection=live]')")
  await b.key("/")
  await b.type("checkout latency")
  await b.wait("document.querySelector('[data-result-id]')")
  await b.key("Enter")
  await b.wait("document.querySelector('[data-fix]')?.innerText.includes('Draft pull request open')")
  assert.equal(await b.evaluate("document.querySelector('[data-action=fix]')===null"), true)
})
