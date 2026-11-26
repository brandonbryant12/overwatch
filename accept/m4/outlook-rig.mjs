import assert from "node:assert/strict"
import { rig } from "../m1/rig.mjs"
import { api } from "../m2/api.mjs"
async function start(x) {
  x.save()
  const c = await x.cli("check")
  assert.equal(c.code, 0, c.out + c.err)
  await x.start()
  await x.poll()
}
async function capacity(t) {
  const x = await rig(t, { both: true }),
    s = x.cfg.apps.shop.environments.prod.sources
  delete s.pods
  s.dd.readings = ["metrics"]
  s.dd.capacity = { resource: "quota", unit: "units", limit: 100 }
  x.world({ ddValue: 10 })
  await start(x)
  return x
}
const forecast = async (x) => {
  const { forecasts } = await api(x, "outlook")
  const f = forecasts.find((f) => f.source === "shop/prod/dd")
  assert.ok(f)
  return f
}
async function point(x, ddValue) {
  await x.advance(60000)
  x.world({ ddValue })
  await x.poll()
}
export { start, capacity, forecast, point }
