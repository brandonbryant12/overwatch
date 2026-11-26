/**
 * The builder's neighbour probes for the fifteen red cases of the milestone 5 assessment: one each, every one a
 * different case from the assessor's. Run with the acceptance rigs (not part of `pnpm run check`):
 *
 *   node --no-warnings --test --test-concurrency=2 test/probes/m5.probe.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { rig, T, iso, BIN } from "../../accept/m1/rig.mjs"
import { source } from "../../accept/m1/observation-rig.mjs"
import { start } from "../../accept/m4/outlook-rig.mjs"
import { scenario, ledger, git } from "../../accept/m4/rig.mjs"
import { act, api, item } from "../../accept/m2/api.mjs"
import { send, until } from "../../accept/m3/rig.mjs"

const notQuiet = async (x) => {
  const e = (await x.status()).environments[0]
  assert.notEqual(e.health, "quiet", JSON.stringify(e.readings))
}
/** The pid of a process that has exited: its scratch is an orphan. */
const deadPid = () => spawnSync(process.execPath, ["-e", "process.pid"]).pid

// 1, 2 (neighbours of Unknown and No Data beside OK): a state outside the known set, and a member with no state at all.
test("probe: a monitor in a state the product does not know (Paused) beside OK is a gap, not quiet", async (t) => {
  await notQuiet(await source(t, "dd", ["monitors"], { monitors: [{ id: 1, name: "a", overall_state: "OK" }, { id: 2, name: "b", overall_state: "Paused" }] }))
})
test("probe: a monitor that reports no state beside OK is a gap, not quiet", async (t) => {
  await notQuiet(await source(t, "dd", ["monitors"], { monitors: [{ id: 1, name: "a", overall_state: "OK" }, { id: 2, name: "b" }] }))
})

// 3 (neighbour of a point past the end): a point dated an hour before the window began.
test("probe: a metric point dated before the queried window cannot certify quiet", async (t) => {
  await notQuiet(await source(t, "dd", ["metrics"], { ddPointTime: T - 3_600_000 }))
})

// 4 (neighbour of an unavailable service manager): launchctl runs, its bootout fails and print says still loaded.
test("probe: uninstall fails and keeps the plist when the agent is still loaded after bootout", async (t) => {
  const x = await rig(t)
  x.cfg.mcpToken = "keychain:overwatch/mcp-token"
  x.save()
  const plist = x.dir("home/Library/LaunchAgents/probe.plist")
  x.env.OW_LAUNCHD_PLIST = plist
  const manager = x.dir("bin/probe-launchctl")
  fs.writeFileSync(manager, '#!/bin/sh\ncase "$1" in bootout) echo "Boot-out failed: 5: Input/output error" >&2; exit 5;; esac\nexit 0\n', { mode: 0o755 })
  x.env.OW_LAUNCHCTL = manager
  assert.equal((await x.cli("install")).code, 0)
  const removed = await x.cli("uninstall", [], { human: true })
  assert.notEqual(removed.code, 0, removed.out)
  assert.ok(fs.existsSync(plist), "the plist was removed while the agent is still loaded")
  assert.match(removed.err, /still loaded/)
})

// 5 (neighbour of seconds against units): samples with no provider unit against a limit in bytes.
test("probe: rising samples without a provider unit give no time left against a limit in bytes", async (t) => {
  const x = await rig(t, { both: true }), s = x.cfg.apps.shop.environments.prod.sources
  delete s.pods
  s.dd.readings = ["metrics"]
  s.dd.capacity = { resource: "disk", unit: "bytes", limit: 1000 }
  await start(x)
  for (let i = 1; i <= 7; ++i) {
    await x.advance(60000)
    x.world({ metricReply: { status: "ok", series: [{ metric: "disk.used", unit: [], pointlist: [[x.now(), i * 10]] }] } })
    await x.poll()
  }
  const f = (await api(x, "outlook")).forecasts.find((f) => f.source === "shop/prod/dd")
  assert.equal(f.etaMinutes, null, JSON.stringify(f))
  assert.match(f.reason ?? "", /not the limit|no time/i)
})

// 6 (neighbour of a third production revision): after "same release", staging moves on and production stays.
test("probe: a comparison that said same release does not keep saying it after staging moves to a new revision", async (t) => {
  const x = await rig(t), app = x.cfg.apps.shop, prod = app.environments.prod.sources.pods
  prod.readings = ["logs", "workloads"]
  prod.namespace = "production"
  const old = x.w().revision, revisions = { production: old, staging: old }, lines = { production: [], staging: [] }
  x.world({ namespaceLines: lines, namespaceRevisions: revisions })
  app.environments.stage = structuredClone(app.environments.prod)
  app.environments.stage.sources.pods.namespace = "staging"
  x.cfg.watchers.push({ app: "shop", environment: "stage", every: "1m" })
  app.promotion = { staging: "stage", production: "prod" }
  await start(x)
  const tick = async (f) => {
    await x.advance(60000)
    f()
    x.world({ namespaceLines: lines, namespaceRevisions: revisions })
    await x.poll()
  }
  await tick(() => (revisions.staging = "e".repeat(40)))
  await tick(() => (revisions.production = revisions.staging))
  assert.equal((await api(x, "outlook")).comparisons[0].state, "same_release")
  await tick(() => (revisions.staging = "f".repeat(40)))
  await tick(() => undefined)
  const c = (await api(x, "outlook")).comparisons[0]
  assert.notEqual(c.state, "same_release", JSON.stringify(c))
})

// 7 (neighbour of the documented npm command): a verifier that needs the network says so, with a working pattern.
test("probe: a verify that tries the network fails closed and names a pattern that works", async (t) => {
  const { x, end } = await scenario(t, {
    beforeStart(x) {
      x.cfg.apps.shop.fixes.verify = [["node", "-e", "require('dns').lookup('registry.npmjs.org', (e) => { console.error(String(e)); process.exit(e ? 1 : 0) })"]]
    },
  })
  assert.equal(end.state, "verify_failed", end.reason)
  assert.deepEqual(ledger(x), [])
  assert.match(end.reason, /exited 1: .*(ENOTFOUND|EAI_AGAIN|getaddrinfo)/)
  assert.match(end.reason, /no network: use a standalone verifier, or prepare dependencies offline/)
})

// 8 (neighbour of the next action after a failed verify): f before a new passing trial is a new attempt that is
// blocked, with no proposal; the failed attempt stays as it was.
test("probe: after a failed verify, f without a new passing trial is a new, blocked attempt that asks no model", async (t) => {
  const { x, end, finding, proposals } = await scenario(t, { verifyExit: 7 })
  assert.equal(end.state, "verify_failed")
  const before = proposals.length
  const { attemptId } = await send(x, "items/" + x.subject + "/fix", { jobId: finding.id }, 202)
  assert.notEqual(attemptId, end.id)
  await x.advance(60000)
  await x.poll()
  assert.equal(proposals.length, before)
  assert.equal((await api(x, "fixes/" + attemptId)).state, "blocked")
  assert.match((await api(x, "fixes/" + attemptId)).reason, /trial --fixes/)
  assert.equal((await api(x, "fixes/" + end.id)).state, "verify_failed")
})

// 9, 10, 11 (neighbours of scratch kept after demos, trials and an interrupted verify): orphans of a killed process
// are removed at the next start, and scratch of a live process is kept.
test("probe: a demo killed with SIGKILL leaves its data, and the next demo removes it", async (t) => {
  const x = await rig(t)
  x.save()
  const demo = async () => {
    const p = spawn(BIN, ["demo", "--config", x.dir("config.json"), "--json"], { env: { ...x.env, OW_TEST_FD: "" }, stdio: ["ignore", "pipe", "ignore"] })
    await once(p.stdout, "data")
    return p
  }
  const demos = () => fs.readdirSync(x.dir("tmp")).filter((n) => n.startsWith("overwatch-demo-"))
  const first = await demo()
  first.kill("SIGKILL")
  await once(first, "exit")
  assert.equal(demos().length, 1, "a killed demo cannot clean up after itself")
  const second = await demo()
  assert.equal(demos().length, 1, "the orphan was not removed: " + demos().join(", "))
  second.kill("SIGTERM")
  await once(second, "exit")
  assert.deepEqual(demos(), [])
})
test("probe: at start, a dead process's trial and verify scratch is removed and a live process's is kept", async (t) => {
  const x = await rig(t)
  const dead = deadPid()
  for (const n of [`overwatch-trial-${dead}-a`, `ow-verify-${dead}-b`, `ow-fix-${dead}-c`, `ow-verify-${process.pid}-live`, "ow-verify-unrelated"]) fs.mkdirSync(x.dir("tmp/" + n), { recursive: true })
  await x.start()
  assert.deepEqual(fs.readdirSync(x.dir("tmp")).filter((n) => /^(overwatch-trial|ow-(verify|fix))-/.test(n)).sort(), [`ow-verify-${process.pid}-live`, "ow-verify-unrelated"])
})
test("probe: an orphaned verify checkout is removed at start even when no fix ever runs again", async (t) => {
  const x = await rig(t)
  const orphan = x.dir(`tmp/ow-verify-${deadPid()}-x/checkout`)
  fs.mkdirSync(orphan, { recursive: true })
  fs.writeFileSync(path.join(orphan, "settings.json"), "{}")
  await x.start()
  assert.equal(fs.existsSync(path.dirname(orphan)), false)
})

// 12 (neighbour of the builder's launchd homes): the unit tests' private root is removed even when a test fails.
test("probe: a failing unit test still removes the private test root", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probe-root-"))
  try {
    const file = path.join(tmp, "fails.test.ts")
    fs.writeFileSync(file, `import { scratch } from ${JSON.stringify(new URL("../scratch.ts", import.meta.url).pathname)};\nimport test from "node:test";\ntest("fails", () => { scratch("ow-launchd-"); throw new Error("on purpose"); });\n`)
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", file], { env: Object.fromEntries(Object.entries({ ...process.env, TMPDIR: tmp }).filter(([k]) => k !== "NODE_TEST_CONTEXT")), encoding: "utf8" })
    assert.notEqual(r.status, 0)
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith("ow-")), [])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// 13 (neighbour of the default data directory): a data directory written with ~ is found by the runbook's line.
test("probe: the runbook's discovery line finds a service whose dataDir starts with ~", async (t) => {
  const x = await rig(t)
  x.cfg.dataDir = "~/ow-data"
  x.save()
  await x.start()
  const line = fs.readFileSync(new URL("../../docs/owner-runbook.md", import.meta.url), "utf8").split("\n").find((l) => l.startsWith("OWURL=$("))
  const r = spawnSync("/bin/zsh", ["-f", "-c", line + ' && print -r -- "$OWURL"'], { cwd: x.root, env: { ...x.env, OWCFG: x.dir("config.json") }, encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), x.url)
})

// 14 (neighbour of a rollback before the quiet streak ended): a roll forward that still contains the fix reaches
// "ready to close", and nothing closes the item until the owner does.
test("probe: a newer deployment that contains the fix is ready to close, and the item stays open until Done", async (t) => {
  const { x, end, read } = await scenario(t)
  assert.equal(end.state, "draft", end.reason)
  const prs = ledger(x)
  prs[0].state = "MERGED"
  prs[0].mergeCommit = { oid: end.head }
  fs.writeFileSync(x.dir("prs.json"), JSON.stringify(prs))
  const remote = x.dir("remote.git")
  git(x, "--git-dir", remote, "update-ref", "refs/heads/main", end.head, x.tip)
  await x.advance(60000)
  await until(x, async () => (await read()).state === "awaiting_deploy", "merge not observed")
  const next = git(x, "--git-dir", remote, "commit-tree", "-p", end.head, "-m", "after the fix", end.head + "^{tree}")
  git(x, "--git-dir", remote, "update-ref", "refs/heads/main", next, end.head)
  x.world({ revision: next, lines: [] })
  for (let n = 0; n < 6 && (await read()).state !== "released_quiet"; n++) {
    await x.advance(60000)
    await x.poll()
  }
  const a = await read()
  assert.equal(a.state, "released_quiet", a.reason)
  assert.match(a.reason, /ready to close.*Done/)
  assert.equal((await item(x, x.subject)).incident.way, null, "the item closed by itself")
  await act(x, x.subject, { action: "done" })
  assert.equal((await item(x, x.subject)).incident.way.kind, "done")
})

// 15 (neighbour of the fields read after create): the minute-by-minute follow read asks for the head commit and repository.
test("probe: following a draft asks the host for its head commit and head repository, on the configured repository", async (t) => {
  const { x, end } = await scenario(t)
  assert.equal(end.state, "draft", end.reason)
  await x.advance(61000)
  await x.poll()
  await until(x, async () => fs.readFileSync(x.dir("gh.jsonl"), "utf8").includes('"view"'), "the draft was not followed")
  const views = fs.readFileSync(x.dir("gh.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((a) => a[0] === "pr" && a[1] === "view")
  for (const v of views) {
    assert.ok(v[v.indexOf("--json") + 1].split(",").includes("headRefOid"), v.join(" "))
    assert.ok(v[v.indexOf("--json") + 1].split(",").includes("headRepository"), v.join(" "))
    assert.ok(v.includes("--repo"), "the follow read let gh choose the repository: " + v.join(" "))
  }
})
