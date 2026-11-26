import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { scenario, ledger, git } from "./rig.mjs"
import { act, api, item } from "../m2/api.mjs"
import { until } from "../m3/rig.mjs"

for (const hook of ["pre-receive", "post-receive"]) {
  test("service restart inside git push at " + hook + " recovers one authorized draft", async (t) => {
    const { x, end } = await scenario(t, {
      beforeStart(x) {
        fs.writeFileSync(
          x.dir("remote.git/hooks/" + hook),
          [
            "#!/bin/sh",
            "cat >/dev/null",
            'touch "$OW_FIXTURE/host-paused"',
            'for i in $(seq 1 200); do test -f "$OW_FIXTURE/host-resume" && exit 0; sleep .05; done',
            "exit 1",
            "",
          ].join("\n"),
          { mode: 0o755 },
        )
      },
      async onHost(x, id) {
        const attempt = await api(x, "fixes/" + id)
        assert.equal(attempt.state, "publishing")
        const ref = git(
          x,
          "--git-dir",
          x.dir("remote.git"),
          "for-each-ref",
          "--format=%(objectname)",
          "refs/heads/ow/fix/" + id,
        )
        assert.equal(ref, hook === "pre-receive" ? "" : attempt.head)
        assert.deepEqual(ledger(x), [])
        await x.stop("SIGKILL")
        fs.writeFileSync(x.dir("host-resume"), "")
        await x.start()
      },
    })
    assert.ok(x.hostHandled)
    assert.equal(end.state, "draft", end.reason)
    assert.equal(ledger(x).length, 1)
    assert.equal(git(x, "--git-dir", x.dir("remote.git"), "rev-parse", "ow/fix/" + end.id), end.head)
    assert.equal(git(x, "--git-dir", x.dir("remote.git"), "rev-parse", "main"), x.tip)
  })
}

async function observeRelease(t) {
  const run = await scenario(t)
  const { x, end, read } = run
  assert.equal(end.state, "draft", end.reason)
  const prs = ledger(x)
  prs[0].state = "MERGED"
  prs[0].mergeCommit = { oid: end.head }
  fs.writeFileSync(x.dir("prs.json"), JSON.stringify(prs))
  git(x, "--git-dir", x.dir("remote.git"), "update-ref", "refs/heads/main", end.head, x.tip)
  await x.advance(60000)
  await until(x, async () => (await read()).state === "awaiting_deploy", "merge not observed")
  x.world({ revision: end.head, lines: [] })
  await x.advance(60000)
  await until(x, async () => (await read()).reason?.includes("three quiet intervals"), "release not observed")
  return run
}

for (const change of ["owner selected Never", "workload rolled back"]) {
  test("release observation preserves what happened next when " + change, async (t) => {
    const { x, read } = await observeRelease(t)
    if (change === "owner selected Never") await act(x, x.subject, { action: "never" })
    else x.world({ revision: x.tip })
    for (let n = 0; n < 4; n++) {
      await x.advance(60000)
      await x.poll()
    }
    await x.poll()
    const incident = (await item(x, x.subject)).incident
    assert.equal(
      incident.way?.kind ?? null,
      change === "owner selected Never" ? "never" : null,
      JSON.stringify({ state: (await read()).state, way: incident.way }),
    )
  })
}

test("a completed host read for a confirmed draft includes the PR's verified commit", async (t) => {
  const { x, end } = await scenario(t)
  assert.equal(end.state, "draft", end.reason)
  const commands = fs.readFileSync(x.dir("gh.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  const afterCreate = commands.slice(commands.findIndex((a) => a[0] === "pr" && a[1] === "create") + 1)
  const fields = afterCreate.filter((a) => a[0] === "pr").map((a) => a[a.indexOf("--json") + 1])
  assert.ok(
    fields.some((s) => s?.split(",").includes("headRefOid")),
    "Host PR fields requested after creation: " + fields.join(" / "),
  )
})

test("onset a millisecond before rollout in the same pass stays ineligible across a later recurrence", async (t) => {
  const { x, end } = await scenario(t, { initialRolloutLine: true, rolloutAge: 0 })
  assert.equal(end.state, "ineligible", end.reason)
  assert.deepEqual(ledger(x), [])
})

test("a retry of the owner's decline after restart preserves the original result", async (t) => {
  const { x, end, read } = await scenario(t)
  assert.equal(end.state, "draft")
  const route = "fixes/" + end.id + "/decline"
  const { requestKey: key } = await api(x, "focus?subject=" + x.subject)
  const first = await api(x, route, {}, { key })
  await x.stop()
  await x.start()
  assert.deepEqual(await api(x, route, {}, { key }), first)
  const stored = await read()
  assert.equal(stored.state, "declined")
  assert.match(stored.host, /draft #1/)
  assert.equal(ledger(x).length, 1)
})

test("a temporary policy outage followed by a protected verdict keeps the remote untouched", async (t) => {
  let observed = false
  const { x, end } = await scenario(t, {
    beforeStart(x) {
      fs.writeFileSync(x.dir("host-fault.json"), JSON.stringify({ protectionError: true }))
    },
    async onDecision(x, id) {
      if (observed) return
      const a = await api(x, "fixes/" + id)
      if (!a.reason?.includes("protection")) return
      assert.deepEqual(ledger(x), [])
      assert.equal(
        git(x, "--git-dir", x.dir("remote.git"), "for-each-ref", "--format=%(refname)", "refs/heads/ow/fix/"),
        "",
      )
      fs.writeFileSync(x.dir("host-fault.json"), JSON.stringify({ protected: true }))
      observed = true
      await x.advance(60000)
    },
  })
  assert.ok(observed)
  assert.equal(end.state, "refused", end.reason)
  assert.deepEqual(ledger(x), [])
  assert.equal(fs.existsSync(x.dir("remote.git/received-refs")), false)
})

test("an accepted create with a lost acknowledgement reconciles without opening a second draft", async (t) => {
  const { x, end } = await scenario(t, {
    beforeStart(x) {
      fs.writeFileSync(x.dir("host-fault.json"), JSON.stringify({ pause: "created", interrupt: true }))
    },
    async onHost(x) {
      assert.equal(ledger(x).length, 1)
      fs.writeFileSync(x.dir("host-resume"), "")
    },
  })
  assert.ok(x.hostHandled)
  assert.equal(end.state, "draft", end.reason)
  const commands = fs.readFileSync(x.dir("gh.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(commands.filter((c) => c[0] === "pr" && c[1] === "create").length, 1)
  assert.equal(ledger(x).length, 1)
})

test("a recurrence in the released workload needs three subsequent quiet intervals", async (t) => {
  const { x, read } = await observeRelease(t)
  const before = (await item(x, x.subject)).incident.count
  await x.advance(60000)
  x.world({ lines: [[new Date(x.now() - 1).toISOString(), "ERROR checkout latency"]] })
  await x.poll()
  assert.equal((await item(x, x.subject)).incident.count, before + 1)
  for (let n = 0; n < 2; n++) {
    await x.advance(60000)
    await x.poll()
  }
  await x.poll()
  assert.equal((await read()).state, "awaiting_deploy", "the interval with the recurrence counts as quiet")
  await x.advance(60000)
  await until(
    x,
    async () => (await read()).state === "released_quiet",
    "three quiet intervals never completed the release",
  )
})
