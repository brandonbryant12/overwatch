import test from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { api, item } from "../m2/api.mjs"
import { service, model, finished, investigate, until } from "./rig.mjs"

// Increment the kill point until the request returns. This includes every traced mutation and commit
// on that request as implemented today, without a hard-coded statement count. Use a fresh peer and
// database per cut so a prior retry cannot satisfy the oracle.
for (const op of ["ask", "open", "correction"])
  test("W " + op + " recovers one intent at every request write cut", async (t) => {
    const mismatches = []
    for (let cut = 1; cut <= 40; cut++) {
      const cleanup = []
      const x = await service({ after: (cb) => cleanup.push(cb) }, { readings: 1 })
      try {
        await until(
          x,
          async () => (await api(x, "notifications")).items.every((n) => n.state === "parked"),
          "notification fixture not settled",
        )
        let path = op,
          body = { subject: x.subject }
        if (op === "ask") body = { ...body, mode: "new", text: "Receipt after restart" }
        if (op === "correction") {
          model(x, ["not_real"])
          const j = await finished(x, (await investigate(x)).jobId)
          path = "items/" + x.subject + "/corrections"
          body = { jobId: j.id, text: "Cut-point correction" }
        }
        const { requestKey: key } = await api(x, "focus?subject=" + x.subject)
        const send = () => api(x, path, body, { key })
        const closed = once(x.child, "close")
        await x.control("trace", { killAfter: cut })
        const completed = await send().then(
          () => true,
          () => false,
        )
        if (!completed) {
          assert.equal((await closed)[1], "SIGKILL", "failure must be an actual process cut")
          await x.start()
        } else await x.control("trace", { killAfter: null })
        const response = await send()
        const detail = await item(x, x.subject)
        const observed =
          op === "ask"
            ? detail.history.filter((e) => e.kind === "asked").length
            : op === "open"
              ? x.p.sessions.size
              : detail.corrections.length
        if (observed !== 1) mismatches.push({ cut, observed })
        if (op === "open") assert.ok(x.p.sessions.has(response.sessionId))
        if (completed) {
          t.diagnostic(
            op +
              " cut after each of " +
              (cut - 1) +
              " writes/commits; divergent cuts " +
              JSON.stringify(mismatches),
          )
          assert.deepEqual(mismatches, [])
          return
        }
      } finally {
        for (const cb of cleanup.reverse()) await cb()
      }
    }
    assert.fail("request exceeded the 40-cut fixture ceiling")
  })
