import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import { scenario, ledger } from "./rig.mjs"
import { job, send, until } from "../m3/rig.mjs"
import { browser, binary } from "../m2/chrome.mjs"

test("passing both positive operations cannot compensate for a refused negative control", async (t) => {
  const { x } = await scenario(t, { pass: false })
  x.p.workScript = async ({ s, tool }) => {
    const kind = s.title.split(" ").at(-1)
    await tool(
      "ow_proposal",
      kind === "revert" ? { kind: "revert" } : { kind: "setting", path: "settings.json", key: "timeout" },
    ).catch(() => {})
    return "Finished"
  }
  const result = await x.json("trial", ["--fixes"], 4, { timeout: 120000 })
  assert.deepEqual(result.fixGate, { passed: false, attempted: 2, verified: 2 })
})

test("the final draft keeps the reviewable relative filename and removes the synthetic mounted volume", async (t) => {
  const { x, end } = await scenario(t, {
    message: "ERROR checkout latency in /Volumes/fixtureVolume/source and settings.json",
  })
  assert.equal(end.state, "draft", end.reason)
  assert.equal(ledger(x).length, 1)
  const pr = ledger(x)[0]
  assert.match(pr.body, /settings\.json/)
  assert.doesNotMatch(pr.title + "\n" + pr.body, /fixtureVolume/)
})

test("normal verified draft cleans all fix, calibration and publication scratch directories", async (t) => {
  const { x, end } = await scenario(t)
  assert.equal(end.state, "draft", end.reason)
  await x.stop()
  const paths = fs.readdirSync(x.dir("tmp"))
  t.diagnostic("After successful fix and stop: " + JSON.stringify(paths))
  assert.deepEqual(
    paths.filter((p) => /^ow-(?:pr|fix|calibration(?:-work)?|verify)-/.test(p)),
    [],
  )
})

test(
  "the next action shown for failed verification matches what the owner can do",
  { skip: !binary },
  async (t) => {
    const { x, end, finding, proposals } = await scenario(t, { verifyExit: 7 })
    assert.equal(end.state, "verify_failed")
    const b = await browser(t, x)
    await b.visit(x.url + "/")
    await b.wait("document.querySelector('[data-connection=live]')")
    await b.key("/")
    await b.type("checkout latency")
    await b.wait("document.querySelector('[data-result-id]')")
    await b.key("Enter")
    const selector = "document.querySelector('[data-fix=" + JSON.stringify(end.id) + "] .next')"
    await b.wait(selector + "?.innerText.length")
    const guidance = await b.evaluate(selector + ".innerText")
    if (!/then f|press f|try again/i.test(guidance)) {
      assert.match(
        guidance,
        /new (investigation|finding|attempt)|nothing further|terminal|closed|policy|inspect|review/i,
        guidance,
      )
      return
    }
    const result = await x.json("trial", ["--fixes"], 0, { timeout: 120000 })
    assert.equal(result.fixGate.passed, true)
    const receipt = await send(x, "items/" + x.subject + "/fix", { jobId: finding.id }, 202)
    assert.ok(receipt.attemptId)
    await until(
      x,
      async () => proposals.length >= 2,
      guidance + " acknowledged the old failed attempt without a new proposal",
    )
    assert.deepEqual(ledger(x), [])
  },
)

test("a focused owner question can finish while the fixer has the other session slot", async (t) => {
  const { x, end } = await scenario(t, {
    async proposal(x) {
      const previous = x.p.workScript
      x.p.workScript = (turn) =>
        turn.s.agent === "ow-responder" ? "Waiting for verification." : previous(turn)
      const queued = await send(x, "ask", { subject: x.subject, text: "What is next?", mode: "new" }, 200)
      await until(
        x,
        async () => (await job(x, queued.jobId)).turns[0]?.state === "answered",
        "answer during selection",
      )
      return { kind: "setting", path: "settings.json", key: "timeout" }
    },
  })
  assert.equal(end.state, "draft", end.reason)
  assert.ok(x.p.peak <= 2, "peak sessions " + x.p.peak)
})
