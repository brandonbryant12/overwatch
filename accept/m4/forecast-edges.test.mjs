import test from "node:test"
import assert from "node:assert/strict"
import { rig, iso } from "../m1/rig.mjs"
import { api } from "../m2/api.mjs"
import { start, capacity, forecast, point } from "./outlook-rig.mjs"

test("F01 replayed provider point after restart cannot supply the sixth distinct sample", async (t) => {
  const x = await capacity(t)
  for (const v of [20, 30, 40, 50]) await point(x, v)
  await x.stop()
  await x.start()
  x.world({ ddPointTime: x.now() })
  await point(x, 60)
  const f = await forecast(x)
  assert.equal(f.etaMinutes, null)
  assert.equal(f.samples, 5)
})
test("F02 six numbers spanning two provider units cannot forecast one capacity", async (t) => {
  const x = await capacity(t)
  for (let i = 1; i <= 6; i++) {
    await x.advance(60000)
    x.world({
      metricReply: {
        status: "ok",
        series: [
          {
            metric: "shop.errors",
            unit: [{ family: i < 4 ? "bytes" : "time", name: i < 4 ? "byte" : "second" }],
            pointlist: [[x.now(), 10 + i * 10]],
          },
        ],
      },
    })
    await x.poll()
  }
  assert.equal((await forecast(x)).etaMinutes, null)
})
test("F03 recovery from reset requires six rising points even after a plateau drops out", async (t) => {
  const x = await capacity(t)
  for (const v of [20, 30, 30, 5, 10, 15, 20, 25]) await point(x, v)
  assert.equal((await forecast(x)).etaMinutes, null)
  await point(x, 30)
  assert.equal((await forecast(x)).etaMinutes, 14)
})
test("F04 a missed three-interval span ages out only after six contiguous samples", async (t) => {
  const x = await capacity(t)
  await point(x, 15)
  await x.advance(120000)
  for (const v of [30, 35, 40, 45, 50]) await point(x, v)
  assert.equal((await forecast(x)).etaMinutes, null)
  await point(x, 55)
  assert.equal((await forecast(x)).etaMinutes, 9)
})
async function promotion(t, skew) {
  const x = await rig(t),
    app = x.cfg.apps.shop,
    prod = app.environments.prod.sources.pods
  prod.readings = ["logs", "workloads"]
  prod.namespace = "production"
  const old = x.w().revision,
    revisions = { production: old, staging: old },
    lines = { production: [], staging: [] }
  x.world({ namespaceLines: lines, namespaceRevisions: revisions })
  if (skew) {
    await start(x)
    await x.advance(30000)
    await x.stop()
  }
  app.environments.stage = structuredClone(app.environments.prod)
  app.environments.stage.sources.pods.namespace = "staging"
  x.cfg.watchers.push({ app: "shop", environment: "stage", every: "1m" })
  app.promotion = { staging: "stage", production: "prod" }
  await start(x)
  const tick = async (callback) => {
    if (skew) {
      await x.advance(30000)
      await x.poll()
    }
    await x.advance(skew ? 30000 : 60000)
    callback()
    x.world({ namespaceLines: lines, namespaceRevisions: revisions })
    await x.poll()
  }
  await tick(() => {
    revisions.staging = "e".repeat(40)
  })
  return { x, tick, lines, revisions }
}
test("S01 both environments fully measured on clocks offset by half a poll cannot claim an aligned regression", async (t) => {
  const { x, tick, lines } = await promotion(t, true)
  for (const n of [2, 1])
    await tick(() => {
      for (let i = 0; i < n; i++) lines.staging.push([iso(x.now() - 1), "ERROR shipment failed"])
    })
  const c = (await api(x, "outlook")).comparisons[0]
  assert.notEqual(c.state, "regression", JSON.stringify(c))
})
test("S02 production rollout after a completed comparison invalidates the old staging signal", async (t) => {
  const { x, tick, lines, revisions } = await promotion(t, false)
  for (const n of [2, 1])
    await tick(() => {
      for (let i = 0; i < n; i++) lines.staging.push([iso(x.now() - 1), "ERROR shipment failed"])
    })
  assert.equal((await api(x, "outlook")).comparisons[0].state, "regression")
  await tick(() => {
    revisions.production = revisions.staging
  })
  assert.equal((await api(x, "outlook")).comparisons[0].state, "same_release")
})
test("S03 production partial reading just in the second interval prevents staging signal", async (t) => {
  const { x, tick, lines } = await promotion(t, false)
  for (const n of [1, 2])
    await tick(() => {
      if (n === 2) x.world({ failedNamespace: "production" })
      for (let i = 0; i < n; i++) lines.staging.push([iso(x.now() - 1), "ERROR shipment failed"])
    })
  const c = (await api(x, "outlook")).comparisons[0]
  assert.equal(c.state, "unknown")
  assert.match(c.reason, /production.*interval 2/)
})

test("a third production revision invalidates the staging comparison across restart", async t => {
  const { x, tick, lines, revisions } = await promotion(t, false)
  for (const count of [1, 2]) await tick(() => {
    for (let i=0;i<count;i++) lines.staging.push([iso(x.now()-1),"ERROR carrier label"])
  })
  assert.equal((await api(x,"outlook")).comparisons[0].state,"regression")
  await tick(() => { revisions.production = revisions.staging })
  assert.equal((await api(x,"outlook")).comparisons[0].state,"same_release")
  await x.stop()
  await x.start()
  await tick(() => { revisions.production = "d".repeat(40) })
  const comparison = (await api(x,"outlook")).comparisons[0]
  assert.notEqual(comparison.state,"same_release",JSON.stringify(comparison))
  assert.notEqual(comparison.state,"regression",JSON.stringify(comparison))
})
