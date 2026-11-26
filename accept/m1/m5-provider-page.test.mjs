import test from "node:test"
import assert from "node:assert/strict"
import { source, step } from "./observation-rig.mjs"

test("a completed log page with a provider warning withdraws quiet until the next complete poll", async t => {
  const complete = { data: [], meta: { status: "done" } }
  const x = await source(t, "dd", ["logs"], { ddLogEnvelope: complete })
  assert.equal((await x.status()).environments[0].health, "quiet")

  const warned = await step(x, {
    ddLogEnvelope: { data: [], meta: { status: "done", warnings: [{ code: "unknown_index" }] } },
  })
  assert.notEqual(warned.coverage.at(-1).state, "ok")
  assert.notEqual(warned.environments[0].health, "quiet")
  await x.stop()
  await x.start()
  const recovered = await step(x, { ddLogEnvelope: complete })
  assert.equal(recovered.coverage.at(-1).state, "ok")
  assert.equal(recovered.environments[0].health, "quiet")
})
