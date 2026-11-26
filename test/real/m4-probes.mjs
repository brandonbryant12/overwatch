// One neighbour of each milestone 4 acceptance test (14), each different from the case it neighbours. Real CLI and
// SQLite, the fixture peers, a bare local Git remote and the fixture gh. Manual, outside `pnpm run check`:
//   node --no-warnings --test --test-concurrency=2 test/real/m4-probes.mjs
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { rig, iso } from "../../accept/m1/rig.mjs"
import { filing } from "../../accept/m1/peers.mjs"
import { api, item } from "../../accept/m2/api.mjs"
import { send, finished, until } from "../../accept/m3/rig.mjs"

const gh = fileURLToPath(new URL("../../accept/m4/gh.mjs", import.meta.url))
const ledger = (x) => (fs.existsSync(x.dir("prs.json")) ? JSON.parse(fs.readFileSync(x.dir("prs.json"), "utf8")) : [])
const bare = (x, ...a) => execFileSync("git", ["--git-dir", x.dir("remote.git"), ...a], { env: x.env, encoding: "utf8" }).trim()
const commit = (x, title) => x.git("-c", "user.name=Probe", "-c", "user.email=probe@localhost", "commit", "-qm", title)
const put = (x, p, t) => fs.writeFileSync(x.dir("checkout/" + p), t)

/** A repository whose deployment lowered a timeout (optionally in two commits), a remote and the fixture gh. */
async function repo(t, { verify = "process.exit(0)", twoCommits = false } = {}) {
  const x = await rig(t)
  fs.copyFileSync(gh, x.dir("bin/gh"))
  fs.chmodSync(x.dir("bin/gh"), 0o755)
  put(x, "settings.json", '{"timeout":30,"retries":2}\n')
  put(x, "verify.cjs", verify + "\n")
  x.git("add", "settings.json", "verify.cjs")
  commit(x, "stable")
  x.previous = x.git("rev-parse", "HEAD")
  x.git("branch", "-M", "main")
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", x.dir("remote.git")])
  x.git("remote", "add", "origin", x.dir("remote.git"))
  if (twoCommits) {
    put(x, "notes.txt", "unrelated\n")
    x.git("add", "notes.txt")
    commit(x, "unrelated note")
  }
  put(x, "settings.json", '{"timeout":3,"retries":2}\n')
  x.git("add", "settings.json")
  commit(x, "lower the timeout")
  x.tip = x.git("rev-parse", "HEAD")
  x.git("push", "-q", "origin", "main")
  return x
}

/** Configure, pass both trials, deploy, see the error, investigate (3 of 3, upheld, observed); returns the job. */
async function confirmed(x, { proposal = { kind: "setting", path: "settings.json", key: "timeout" }, fixes = true } = {}) {
  x.cfg.opencode.model = "fixture/glm-5.3"
  x.cfg.readings = 3
  x.cfg.apps.shop.fixes = { remote: "origin", base: "main", paths: ["settings.json"], verify: [["node", "verify.cjs"]] }
  x.cfg.apps.shop.environments.prod.sources.pods.readings = ["logs", "workloads"]
  x.save()
  x.world({ revision: x.previous, lines: [] })
  await x.start()
  await x.poll()
  x.proposals = []
  x.p.workScript = async ({ s, tool }) => {
    if (s.agent === "ow-fixer") {
      const kind = s.title.startsWith("Overwatch fix calibration") ? s.title.split(" ").at(-1) : null
      const value = kind ? (kind === "setting" ? { kind, path: "settings.json", key: "timeout" } : { kind }) : typeof proposal === "function" ? proposal(x) : proposal
      if (!kind) x.proposals.push(value)
      await tool("ow_proposal", value).catch(() => {})
      return "Done"
    }
    const p = (await tool("ow_telemetry", { source: "pods" })).pieces[0]
    if (s.agent === "ow-challenger") await tool("ow_challenge", { outcome: "upheld", evidence: [p.handle], reason: "Followed the deploy" })
    else await tool("ow_finding", filing("real", [p.handle], "Timeout lowered"))
    return "Filed"
  }
  if (fixes) assert.equal((await x.json("trial", ["--fixes"])).fixGate.passed, true)
  else await x.json("trial")
  await x.advance(60000)
  x.world({ revision: x.tip })
  await x.poll()
  await x.advance(60000)
  x.world({ lines: [[iso(x.now() - 1), "ERROR checkout latency"]] })
  await x.poll()
  x.subject = (await x.status()).incidents.find((i) => i.title.includes("checkout")).id
  const j = (await item(x, x.subject)).investigations.at(-1)
  return finished(x, j.id ?? j.jobId)
}
async function fix(x, job) {
  const { attemptId } = await send(x, "items/" + x.subject + "/fix", { jobId: job.id }, 202)
  const read = () => api(x, "fixes/" + attemptId)
  const end = await until(x, async () => { const a = await read(); return !["queued", "proposing", "verifying", "publishing"].includes(a.state) && a }, "no decision")
  return { attemptId, read, end }
}

test("control' the fixture gh lists a draft by its head after creation", async (t) => {
  const x = await repo(t)
  execFileSync(x.dir("bin/gh"), ["pr", "create", "--draft", "--base", "main", "--head", "ow/fix/p", "--title", "P", "--body", "B"], { env: x.env })
  const listed = JSON.parse(execFileSync(x.dir("bin/gh"), ["pr", "list", "--head", "ow/fix/p", "--json", "number"], { env: x.env, encoding: "utf8" }))
  assert.equal(listed[0].headRefName, "ow/fix/p")
})
test("gate absent' a fix gate from another model does not carry over", async (t) => {
  const x = await repo(t)
  const job = await confirmed(x)
  await x.stop()
  x.cfg.opencode.model = "fixture/other"
  x.save()
  await x.start()
  const { end } = await fix(x, job)
  assert.equal(end.state, "blocked")
})
test("investigation only' a real verify failure revokes the fix gate for the next attempt", async (t) => {
  const x = await repo(t, { verify: "process.exit(5)" })
  const job = await confirmed(x)
  assert.equal((await fix(x, job)).end.state, "verify_failed")
  const again = await finished(x, (await send(x, "items/" + x.subject + "/investigate", {}, 202)).jobId)
  const { end } = await fix(x, again)
  assert.equal(end.state, "blocked")
  assert.match(end.reason, /fix trial/)
})
test("verify exits 7' a verify command that reaches for the network fails closed", async (t) => {
  const x = await repo(t, { verify: "require('net').connect(80,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(4))" })
  const { end } = await fix(x, await confirmed(x))
  assert.equal(end.state, "verify_failed")
  assert.equal(ledger(x).length, 0)
})
test("path outside allowance' a key that was not offered is refused", async (t) => {
  const x = await repo(t)
  const { end } = await fix(x, await confirmed(x, { proposal: { kind: "setting", path: "settings.json", key: "retries" } }))
  assert.equal(end.state, "refused")
})
test("planted' a revert of a commit outside the rollout is refused", async (t) => {
  const x = await repo(t)
  const { end } = await fix(x, await confirmed(x, { proposal: (x) => ({ kind: "revert", commit: x.previous }) }))
  assert.equal(end.state, "refused")
  assert.equal(bare(x, "for-each-ref", "--format=%(refname)"), "refs/heads/main")
})
test("model bytes' a setting proposal carrying a value is refused", async (t) => {
  const x = await repo(t)
  const { end } = await fix(x, await confirmed(x, { proposal: { kind: "setting", path: "settings.json", key: "timeout", value: 30 } }))
  assert.equal(end.state, "refused")
})
test("close' a closed draft is not proposed again for the same finding after a restart", async (t) => {
  const x = await repo(t)
  const job = await confirmed(x)
  const { read } = await fix(x, job)
  const rows = ledger(x)
  rows[0].state = "CLOSED"
  fs.writeFileSync(x.dir("prs.json"), JSON.stringify(rows))
  await x.stop("SIGKILL")
  await x.start()
  await until(x, async () => (await read()).state === "closed_unmerged", "not reconciled")
  await x.poll()
  assert.equal((await item(x, x.subject)).fixes.length, 1)
  assert.equal((await item(x, x.subject)).incident.way, null)
})
test("merge' a release that does not contain the merge leaves the problem open", async (t) => {
  const x = await repo(t)
  const { read, end } = await fix(x, await confirmed(x))
  const rows = ledger(x)
  rows[0].state = "MERGED"
  rows[0].mergeCommit = { oid: end.head }
  fs.writeFileSync(x.dir("prs.json"), JSON.stringify(rows))
  await until(x, async () => (await read()).state === "awaiting_deploy", "merge not seen")
  x.world({ revision: x.previous })
  for (let n = 0; n < 4; n++) {
    await x.advance(60000)
    await x.poll()
  }
  assert.equal((await read()).state, "awaiting_deploy")
  assert.equal((await item(x, x.subject)).incident.way, null)
})
test("decision 1' a commit landing on main after the deployment does not stop the fix; it is built on the new tip", async (t) => {
  const x = await repo(t)
  put(x, "notes.txt", "landed later\n")
  x.git("add", "notes.txt")
  commit(x, "later work")
  x.git("push", "-q", "origin", "main")
  const tip = x.git("rev-parse", "HEAD")
  const { end } = await fix(x, await confirmed(x))
  assert.equal(end.state, "draft", end.reason)
  assert.equal(end.base, tip)
  assert.equal(bare(x, "rev-parse", end.head + "^1"), tip)
})
test("decision 1' with two commits in the rollout, the model must name the one to revert", async (t) => {
  const x = await repo(t, { twoCommits: true })
  const { end } = await fix(x, await confirmed(x, { proposal: (x) => ({ kind: "revert", commit: x.tip }) }))
  assert.equal(end.state, "draft", end.reason)
  assert.equal(bare(x, "diff", "--name-only", x.tip, end.head), "settings.json")
})

async function capacity(t, values, limit = 100) {
  const x = await rig(t, { both: true }), s = x.cfg.apps.shop.environments.prod.sources
  delete s.pods
  s.dd.readings = ["metrics"]
  s.dd.capacity = { resource: "memory", unit: "bytes", limit }
  x.world({ ddValue: values[0] })
  x.save()
  await x.start()
  await x.poll()
  for (const v of values.slice(1)) {
    await x.advance(60000)
    x.world({ ddValue: v })
    await x.poll()
  }
  return (await api(x, "outlook")).forecasts[0]
}
test("short series' slow growth gives no time inside the horizon", async (t) => {
  const f = await capacity(t, [10, 10.01, 10.02, 10.03, 10.04, 10.05])
  assert.deepEqual([f.state, f.etaMinutes], ["outside_horizon", null])
})
test("six linear' usage at the limit is reached, not forecast", async (t) => {
  const f = await capacity(t, [50, 60, 70, 80, 90, 100])
  assert.equal(f.state, "reached")
})
test("reset' a flat series cannot forecast", async (t) => {
  const f = await capacity(t, [40, 40, 40, 40, 40, 40])
  assert.deepEqual([f.state, f.etaMinutes], ["unknown", null])
})
test("compare' staging released to production's own revision is the same release", async (t) => {
  const x = await rig(t), app = x.cfg.apps.shop
  app.environments.prod.sources.pods.namespace = "production"
  app.environments.prod.sources.pods.readings = ["logs", "workloads"]
  app.environments.stage = structuredClone(app.environments.prod)
  app.environments.stage.sources.pods.namespace = "staging"
  x.cfg.watchers.push({ app: "shop", environment: "stage", every: "1m" })
  app.promotion = { staging: "stage", production: "prod" }
  x.save()
  const prod = x.w().revision
  x.world({ namespaceRevisions: { production: prod, staging: "f".repeat(40) } })
  await x.start()
  await x.poll()
  await x.advance(60000)
  x.world({ namespaceRevisions: { production: prod, staging: prod } })
  await x.poll()
  const c = (await api(x, "outlook")).comparisons[0]
  assert.equal(c.state, "same_release")
})
test("decision 1' a void candidate can be asked for again by the owner, and is built on the moved base", async (t) => {
  const x = await repo(t)
  const job = await confirmed(x, { proposal: (x) => { if (!x.moved) { x.moved = true; put(x, "notes.txt", "moved\\n"); x.git("add", "notes.txt"); commit(x, "moved"); x.git("push", "-q", "origin", "main") } return { kind: "setting", path: "settings.json", key: "timeout" } } })
  const first = await fix(x, job)
  if (first.end.state === "stale") {
    const again = await fix(x, job)
    assert.equal(again.end.state, "draft", again.end.reason)
    assert.equal(again.end.base, x.git("rev-parse", "HEAD"))
  } else assert.equal(first.end.state, "draft")
})
