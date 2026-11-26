import assert from "node:assert/strict"
import test from "node:test"
test("local clock thresholds include the boundary and either clock can age health", async () => {
  const { freshness } = await import("../../web/freshness.mjs")
  const last = { wallMs: 100000, monoMs: 200000 }
  assert.equal(freshness(null, last), "unknown")
  for (const [age, state] of [[0, "live"], [14999, "live"], [15000, "stale"], [29999, "stale"], [30000, "down"]]) {
    for (const key of ["wallMs", "monoMs"]) assert.equal(freshness(last, { ...last, [key]: last[key] + age }), state)
  }
  assert.equal(freshness(last, { wallMs: 1, monoMs: last.monoMs + 30001 }), "down")
})
