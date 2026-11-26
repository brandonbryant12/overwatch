// Neighbours of the milestone 4 assessment's defects, each different from the cases in accept/ and test/real/.
// Real CLI and SQLite, fixture peers, a bare local Git remote and the fixture gh. Manual, outside `pnpm run check`:
//   node --no-warnings --test --test-concurrency=2 test/real/m5-probes.mjs
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { scenario, ledger, refs, git } from "../../accept/m4/rig.mjs"
import { source, step } from "../../accept/m1/observation-rig.mjs"
import { capacity, forecast } from "../../accept/m4/outlook-rig.mjs"
import { api, item, act } from "../../accept/m2/api.mjs"
import { send, until } from "../../accept/m3/rig.mjs"

const held = (x) => assert.deepEqual([ledger(x).length, refs(x).includes("refs/heads/ow/fix/")], [0, false])
const fault = (f) => (x) => fs.writeFileSync(x.dir("host-fault.json"), JSON.stringify(f))

// ---- the owner's stop and the gates, at publication
test("stop' a decline after the draft exists says what is on the host and stops following it", async (t) => {
  const { x, end, read } = await scenario(t)
  assert.equal(end.state, "draft")
  await send(x, "fixes/" + end.id + "/decline", {}, 200)
  const a = await read()
  assert.equal(a.state, "declined")
  assert.match(a.reason, /draft #1/)
  const prs = ledger(x)
  prs[0].state = "MERGED"
  prs[0].mergeCommit = { oid: end.head }
  fs.writeFileSync(x.dir("prs.json"), JSON.stringify(prs))
  await x.advance(60000)
  await x.poll()
  assert.equal((await read()).state, "declined")
})
test("stop' putting the problem away while the model selects publishes nothing", async (t) => {
  const { x, end } = await scenario(t, {
    automatic: true,
    proposal: async (x) => {
      await act(x, x.subject, { action: "done" })
      return { kind: "setting", path: "settings.json", key: "timeout" }
    },
  })
  assert.notEqual(end.state, "draft")
  held(x)
})
test("gate' a failing fix trial during the protection check blocks the push", async (t) => {
  const { x, end } = await scenario(t, {
    beforeStart: fault({ pause: "protection" }),
    onHost: async (x) => {
      x.p.workScript = async ({ tool }) => (await tool("ow_proposal", { kind: "abstain" }).catch(() => {}), "Filed")
      const r = await x.json("trial", ["--fixes"], 4, { timeout: 120000 })
      assert.equal(r.fixGate.passed, false)
      fs.writeFileSync(x.dir("host-resume"), "ready")
    },
  })
  assert.equal(end.state, "blocked", end.reason)
  held(x)
})
// ---- host read-back
test("read-back' an exact branch and base but a non-draft pull request is not adopted", async (t) => {
  let x
  const r = await scenario(t, {
    decisionTimeout: 4000,
    beforeStart: (r) => ((x = r), fault({ listRow: { number: 77, url: "http://127.0.0.1/pull/77", baseRefName: "main", state: "OPEN", isDraft: false, body: "<!-- overwatch-attempt: any -->" } })(r)),
  }).catch((e) => {
    if (!/no draft decision/.test(e.message)) throw e
    return null
  })
  const a = (await item(x, x.subject)).fixes.at(-1)
  assert.notEqual(a.state, "draft")
  assert.match(a.reason ?? "", /not this attempt's draft/)
  assert.equal(r, null)
})
test("cut' SIGKILL right after the push, before any host lookup, reconciles one draft on restart", async (t) => {
  const { x, end, attemptId } = await scenario(t, {
    beforeStart: fault({ pause: "list", interrupt: true }),
    onHost: async (x) => {
      assert.ok(refs(x).includes("refs/heads/ow/fix/"))
      await x.stop("SIGKILL")
      fs.writeFileSync(x.dir("host-resume"), "ready")
      await x.start()
    },
  })
  assert.equal(end.state, "draft")
  assert.equal(ledger(x).length, 1)
  assert.equal(git(x, "--git-dir", x.dir("remote.git"), "rev-parse", "refs/heads/ow/fix/" + attemptId), end.head)
})

// ---- what a measurement proves
test("K06' a log reply still running is not a complete window", async (t) => {
  const x = await source(t, "dd", ["logs"], { ddLogEnvelope: { data: [], meta: { status: "running" } } })
  assert.notEqual((await x.status()).coverage.at(-1).state, "ok")
})
test("K05' a point from before the queried window is not a measurement", async (t) => {
  const x = await source(t, "dd", ["metrics"], {})
  const s = await step(x, { ddPointTime: x.now() - 3600000 })
  assert.notEqual(s.environments[0].health, "quiet")
})
test("K01' a lower-case alert state is not understood, so not an all-clear", async (t) => {
  const x = await source(t, "dd", ["monitors"], { monitors: [{ id: 3, name: "Queue", overall_state: "alerting" }] })
  assert.notEqual((await x.status()).environments[0].health, "quiet")
})
test("F02' the same family in another unit (bytes, then kibibytes) cannot forecast", async (t) => {
  const x = await capacity(t)
  for (let i = 1; i <= 6; i++) {
    await x.advance(60000)
    x.world({ metricReply: { status: "ok", series: [{ metric: "m", unit: [{ family: "bytes", name: i % 2 ? "byte" : "kibibyte" }], pointlist: [[x.now(), 10 + i * 10]] }] } })
    await x.poll()
  }
  assert.equal((await forecast(x)).etaMinutes, null)
})

// ---- verification and calibration
test("V06' the verifier cannot list the owner's home folder", async (t) => {
  const { end } = await scenario(t, {
    setup: { stable: (x, put) => put("verify.cjs", `try{require("node:fs").readdirSync(${JSON.stringify(process.env.HOME)});process.exit(9)}catch{process.exit(0)}`) },
  })
  assert.equal(end.state, "draft", JSON.stringify(end.verification))
})
test("V09' a revert offered in the setting exercise cannot earn the setting credit", async (t) => {
  const { x } = await scenario(t, { pass: false })
  x.p.workScript = async ({ s, tool }) => {
    const kind = s.title.split(" ").at(-1)
    await tool("ow_proposal", kind === "abstain" ? { kind } : { kind: "revert" }).catch(() => {})
    return "Filed"
  }
  const r = JSON.parse((await x.cli("trial", ["--fixes"])).out)
  assert.deepEqual([r.fixGate.passed, r.fixGate.verified], [false, 1])
})
test("P01' a Windows home path and a tilde path in the evidence do not leave the laptop", async (t) => {
  const { x, end } = await scenario(t, { message: "ERROR checkout latency C:\\Users\\example-private\\svc.cs and ~/private-notes/key.txt" })
  assert.equal(end.state, "draft")
  assert.doesNotMatch(ledger(x)[0].body + ledger(x)[0].title, /example-private|private-notes/)
})

// ---- release
test("Y05' a catch-up interval between quiet intervals restarts the count", async (t) => {
  const { x, read, end } = await scenario(t)
  const prs = ledger(x)
  prs[0].state = "MERGED"
  prs[0].mergeCommit = { oid: end.head }
  fs.writeFileSync(x.dir("prs.json"), JSON.stringify(prs))
  git(x, "--git-dir", x.dir("remote.git"), "update-ref", "refs/heads/main", end.head, x.tip)
  await x.advance(60000)
  await until(x, async () => (await read()).state === "awaiting_deploy", "missed merge")
  x.world({ revision: end.head, lines: [] })
  for (const gap of [60000, 60000, 600000, 60000]) {
    await x.advance(gap)
    await x.poll()
  }
  assert.equal((await read()).state, "awaiting_deploy")
})
