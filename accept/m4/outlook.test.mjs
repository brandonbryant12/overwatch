import test from "node:test"
import assert from "node:assert/strict"
import { rig, iso } from "../m1/rig.mjs"
import { api } from "../m2/api.mjs"

import {start,capacity,forecast,point} from "./outlook-rig.mjs"
test("M4 short series cannot forecast", async (t) => {
  const x = await capacity(t)
  await point(x, 20)
  const f = await forecast(x)
  assert.deepEqual([f.state, f.samples, f.etaMinutes], ["unknown", 2, null])
  assert.ok(f.reason)
})
test("M4 six linear observations predict four minutes; a missing point invalidates the estimate", async (t) => {
  const x = await capacity(t)
  for (const value of [20, 30, 40, 50, 60]) await point(x, value)
  const f = await forecast(x)
  assert.deepEqual([f.state, f.samples, f.etaMinutes, f.limit, f.unit], ["forecast", 6, 4, 100, "units"])
  await point(x, null)
  const gap = await forecast(x)
  assert.deepEqual([gap.state, gap.etaMinutes], ["unknown", null])
  assert.ok(gap.reason)
})
test("M4 a reset or a variable slope cannot support a time-left claim", async (t) => {
  const x = await capacity(t)
  for (const value of [11, 12, 13, 44, 45, 8]) {
    await point(x, value)
    assert.equal((await forecast(x)).etaMinutes, null)
  }
})
for (const missing of [false, true])
  test(
    "M4 compare two fresh staging intervals with " +
      (missing ? "missing production coverage" : "a clean production baseline"),
    async (t) => {
      const x = await rig(t),
        app = x.cfg.apps.shop,
        prod = app.environments.prod.sources.pods
      prod.namespace = "production"
      prod.readings = ["logs", "workloads"]
      app.environments.stage = structuredClone(app.environments.prod)
      app.environments.stage.sources.pods.namespace = "staging"
      x.cfg.watchers.push({ app: "shop", environment: "stage", every: "1m" })
      app.promotion = { staging: "stage", production: "prod" }
      const production = x.w().revision,
        staging = "e".repeat(40)
      const lines = { production: [], staging: [] },
        revisions = { production, staging: production }
      x.world({ namespaceLines: lines, namespaceRevisions: revisions })
      await start(x)
      revisions.staging = staging
      await x.advance(60000)
      x.world({ namespaceRevisions: revisions })
      await x.poll()
      for (const n of [2, 1]) {
        await x.advance(60000)
        lines.staging.push(
          ...Array.from({ length: n }, () => [iso(x.now() - 1), "ERROR shipping regression"]),
        )
        x.world({ namespaceLines: lines, failedNamespace: missing ? "production" : null })
        await x.poll()
      }
      const a = (await api(x, "outlook")).comparisons.find((c) => c.app === "shop")
      assert.ok(a)
      assert.equal(a.state, missing ? "unknown" : "regression")
      assert.deepEqual([a.stagingRevision, a.productionRevision], [staging, production])
      if (missing) assert.match(a.reason, /prod/i)
      else assert.deepEqual([a.stagingCount, a.productionCount], [3, 0])
    },
  )
