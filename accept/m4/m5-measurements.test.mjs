import assert from "node:assert/strict"
import test from "node:test"
import { capacity, forecast } from "./outlook-rig.mjs"

test("a consistent series in seconds cannot forecast a quota expressed in units", async (t) => {
  const x = await capacity(t)
  for (let i = 1; i <= 6; ++i) {
    await x.advance(60000)
    x.world({
      metricReply: {
        status: "ok",
        series: [
          {
            metric: "shop.errors",
            unit: [{ family: "time", name: "second" }],
            pointlist: [[x.now(), i * 10]],
          },
        ],
      },
    })
    await x.poll()
  }
  const f = await forecast(x)
  assert.equal(f.etaMinutes, null, JSON.stringify(f))
})
