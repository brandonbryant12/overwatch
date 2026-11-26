import test from "node:test"
import assert from "node:assert/strict"
import { source, step, restoreWith } from "./observation-rig.mjs"
import { service, investigate, finished, model } from "../m3/rig.mjs"
import { T } from "./rig.mjs"

test("K01 unknown monitor state cannot be a measured all-clear", async (t) => {
  const x = await source(t, "dd", ["monitors"], {
    monitors: [{ id: 14, name: "Inventory", overall_state: "UNRECOGNIZED" }],
  })
  assert.notEqual((await x.status()).environments[0].health, "quiet")
})
test("K02 restarting just before rate delay expires preserves remaining elapsed time", async (t) => {
  const x = await source(t, "dd", ["logs"], { ddRate: true, retryAfter: 37 })
  const due = (await x.status()).sources[0].nextMs
  const delay = due - x.now()
  assert.ok(delay > 0)
  await x.advance(delay - 1)
  await x.stop()
  await x.start()
  x.world({ ddRate: false })
  await x.poll()
  assert.equal((await x.status()).sources[0].failure, "rate")
  assert.equal((await step(x, {}, 1)).sources[0].failure, null)
})
test("K03 detached backup with a nonexistent provider onset subject is refused", async (t) => {
  await restoreWith(await service(t), "update onsets set incident='inc_other'")
})
test("K04 enabling drafts adds a missing fixer diagnosis distinct from missing responder", async (t) => {
  const x = await service(t, {
    configure(x) {
      x.cfg.apps.shop.fixes = {
        remote: "origin",
        base: "main",
        paths: ["settings.json"],
        verify: [["node", "verify.cjs"]],
      }
    },
  })
  const checks = (await x.json("doctor", [], 0, { timeout: 40000 })).checks
  for (const id of ["agent:fixer", "agent:responder"])
    assert.ok(
      checks.some((c) => c.id === id && !c.ok && c.fix),
      id,
    )
})
test("K05 a point dated after the query cannot certify present health", async (t) => {
  const x = await source(t, "dd", ["metrics"], { ddPointTime: T + 3600000 })
  assert.notEqual((await x.status()).environments[0].health, "quiet")
})
test("K06 partial Datadog log response with a data array and timeout status is incomplete", async (t) => {
  const x = await source(t, "dd", ["logs"], {
    ddLogEnvelope: {
      data: [],
      meta: { status: "timeout", warnings: [{ code: "timeout", detail: "Partial results" }] },
    },
  })
  assert.notEqual((await x.status()).coverage.at(-1).state, "ok")
})
test("K07 detached backup cannot relabel a missing evidence handle as observed", async (t) => {
  const x = await service(t, { readings: 1 })
  model(x, ["real"])
  await finished(x, (await investigate(x)).jobId)
  await restoreWith(x, "update origins set handle='e_absent' where rowid=(select min(rowid) from origins)")
})
test("K08 two opposite monitor transitions before and after restart stay independent", async (t) => {
  const pair = (a, b) =>
    [a, b].map((overall_state, i) => ({ overall_state, id: i + 1, name: i ? "Worker" : "Queue" }))
  const x = await source(t, "dd", ["monitors"], { monitors: pair("Warn", "OK") })
  await step(x, { monitors: pair("OK", "Alert") })
  await x.stop()
  await x.start()
  const s = await step(x, { monitors: pair("Alert", "Warn") })
  assert.deepEqual(s.incidents.map((i) => i.count).sort(), [1, 2])
})
