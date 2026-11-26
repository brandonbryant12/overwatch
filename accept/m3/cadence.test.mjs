import test from "node:test"
import assert from "node:assert/strict"
import { service, model, send, job, until } from "./rig.mjs"

test("24 simulated hourly arrivals drain behind owner questions across a restart", async (t) => {
  const x = await service(t, {
    readings: 1,
    configure(x) {
      x.cfg.watchers[0].every = "60m"
    },
  })
  assert.ok((await x.json("trial")).automation)
  model(x, ["not_real"])
  for (let hour = 0; hour < 24; hour++) {
    if (hour === 12) {
      await x.stop("SIGKILL")
      await x.start()
    }
    const label = String.fromCharCode(97 + hour)
    const newLines = ["one", "two", "three"].map((s) => [
      new Date(x.now() + 3600000 - 1).toISOString(),
      "ERROR batch " + label + " " + s,
    ])
    x.world({ lines: [...x.w().lines, ...newLines] })
    await x.advance(3600000)
    await x.poll()
    const question = await send(x, "ask", { subject: x.subject, text: "Question one", mode: "new" })
    const ids = new Set(
      (await x.status()).incidents.filter((i) => i.title.includes("batch " + label + " ")).map((i) => i.id),
    )
    assert.equal(ids.size, 3)
    await until(
      x,
      async () => {
        const s = await x.status(),
          work = s.jobs.filter((j) => j.kind === "investigation" && ids.has(j.subject))
        return (
          work.length === 3 &&
          work.every((j) => j.state === "completed") &&
          (await job(x, question.jobId)).turns[0].state === "answered"
        )
      },
      "work did not drain in simulated hour " + (hour + 1),
    )
  }
  assert.ok(x.p.peak <= 2)
  assert.deepEqual(x.p.errors, [])
  t.diagnostic("24 simulated hours, 72 new investigations, 24 owner questions, one restart")
})
