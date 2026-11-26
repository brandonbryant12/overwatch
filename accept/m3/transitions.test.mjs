import test from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { item } from "../m2/api.mjs"
import { filing } from "../m1/peers.mjs"
import { service, finished, investigate } from "./rig.mjs"

// Stop on externally distinguishable transitions. SQL cuts for collector transactions live in m1.
// Each restarted job must retain its original inputs, one vote per slot, one terminal decision,
// and any filing that committed before the crash. Do not count model thinking as a filing.
for (const cut of [
  "queued",
  "reading prompt",
  "reading evidence",
  "reading nudge",
  "reading filed",
  "challenge queued",
  "challenge prompt",
  "challenge evidence",
  "challenge filed",
  "adjudicated",
]) {
  test("C " + cut + " survives service loss", async (t) => {
    const x = await service(t, { readings: 1 }),
      release = Promise.withResolvers()
    let reached = false,
      restarted = false,
      readerFiled = false,
      challengerFiled = false
    const halt = async (stage) => {
      if (stage === cut && !reached) {
        reached = true
        await release.promise
        return true
      }
      return false
    }
    let readerTurns = 0
    x.p.workScript = async ({ s, tool }) => {
      const role = s.agent === "ow-challenger" ? "challenge" : "reading"
      if (await halt(role + " prompt")) return "Interrupted"
      if (role === "reading" && cut === "reading nudge" && !restarted) {
        if (++readerTurns === 1) return "Still comparing"
        if (await halt("reading nudge")) return "Interrupted"
      }
      let p
      try {
        p = (await tool("ow_telemetry", { source: "pods" })).pieces[0]
      } catch (e) {
        if (restarted) return "Old session ended"
        throw e
      }
      if (await halt(role + " evidence")) return "Interrupted"
      if (role === "reading") {
        await tool(
          "ow_finding",
          filing("real", [p.handle], restarted ? "Replacement reading" : "Original reading"),
        )
        readerFiled = true
      } else {
        await tool("ow_challenge", {
          outcome: "upheld",
          reason: restarted ? "Replacement challenge" : "Original challenge",
          evidence: [p.handle],
        })
        challengerFiled = true
      }
      if (await halt(role + " filed")) return "Interrupted"
      return "Filed"
    }
    const { jobId } = await investigate(x)
    if (cut !== "queued") {
      if (cut === "adjudicated") await finished(x, jobId)
      else if (cut === "challenge queued") {
        await x.poll()
        for (let i = 0; i < 150 && !readerFiled; i++) await delay(20)
        assert.ok(readerFiled)
        await delay(120)
      } else {
        await x.poll()
        for (let i = 0; i < 100 && !reached; i++) {
          if (cut.startsWith("challenge")) await x.poll()
          await delay(25)
        }
        assert.ok(reached, "did not reach " + cut)
      }
    }
    const priorReader = readerFiled,
      priorChallenge = challengerFiled
    try {
      await x.stop("SIGKILL")
    } finally {
      restarted = true
      release.resolve()
    }
    if (cut === "challenge queued")
      assert.equal(
        x.inspect(
          (db) => db.prepare("select state from work where job_id=? and kind='challenge'").get(jobId)?.state,
        ),
        "queued",
        "cut missed the durable transition",
      )
    await x.start()
    const j = await finished(x, jobId)
    assert.equal(j.result.planned, 1)
    assert.equal(j.result.verdict, "real")
    const d = await item(x, x.subject)
    assert.equal(d.history.filter((h) => h.kind === "adjudicated").length, 1)
    if (priorReader) {
      const read = d.findings.find((f) => f.id === j.result.readings[0].findingId)
      assert.equal(read.body.cause, "Original reading", "replaced a committed reader filing")
    }
    if (priorChallenge)
      assert.equal(
        j.result.challenge.reason,
        "Original challenge",
        "replaced a committed disproof assessment",
      )
  })
}
