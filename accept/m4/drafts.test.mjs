import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { item } from "../m2/api.mjs"
import { until } from "../m3/rig.mjs"
import { repository, scenario, ledger, refs, git } from "./rig.mjs"

test("M4 control: bare remote and draft host record head, base, description and subsequent closure", async (t) => {
  const x = await repository(t)
  assert.equal(refs(x), "refs/heads/main " + x.tip)
  for (const [head, base] of [["ow/fix/demo", "main"]]) {
    execFileSync(
      x.dir("bin/gh"),
      ["pr", "create", "--draft", "--base", base, "--head", head, "--title", "Demo", "--body", "Fixture"],
      { env: x.env },
    )
  }
  assert.deepEqual([ledger(x)[0].isDraft, ledger(x)[0].headRefName], [true, "ow/fix/demo"])
  const rows = ledger(x)
  rows[0].state = "CLOSED"
  fs.writeFileSync(x.dir("prs.json"), JSON.stringify(rows))
  const v = execFileSync(x.dir("bin/gh"), ["pr", "view", "1", "--json", "state"], { env: x.env })
  assert.equal(JSON.parse(v).state, "CLOSED")
})

for (const [name, options, state] of [
  ["gate absent", { pass: false }, "blocked"],
  ["investigation trial passed but zero fixes verified", { pass: "investigationOnly" }, "blocked"],
  ["verify exits 7", { verifyExit: 7 }, "verify_failed"],
  [
    "path outside allowance",
    { proposal: { kind: "setting", path: "other.json", key: "timeout" } },
    "refused",
  ],
  [
    "planted log asks for a different file and a weak reader proposes it",
    { planted: true, proposal: { kind: "setting", path: "other.json", key: "timeout" } },
    "refused",
  ],
  [
    "model supplies bytes instead of selecting a known inverse",
    { proposal: { kind: "revert", patch: "replace the file" } },
    "refused",
  ],
])
  test("M4 draft withheld when " + name, async (t) => {
    const { x, end, proposals } = await scenario(t, options)
    assert.equal(end.state, state)
    assert.ok(end.reason)
    assert.equal(refs(x), "refs/heads/main " + x.tip)
    assert.deepEqual(ledger(x), [])
    assert.equal(
      fs.existsSync(x.dir("remote.git/received-refs")),
      false,
      "attempted a remote write before verification",
    )
    if (state === "blocked") assert.equal(proposals.length, 0)
    else assert.ok(proposals.length >= 1)
    if (state === "verify_failed") assert.equal(end.verification.at(-1).exitCode, 7)
    assert.equal(x.git("rev-parse", "HEAD"), x.tip)
  })
for (const merged of [false, true])
  test(
    "M4 verified draft lifecycle " +
      (merged ? "after external merge and observed release" : "after close without merge"),
    async (t) => {
      const { x, end, read, attemptId, finding } = await scenario(
        t,
        merged ? { proposal: { kind: "revert" } } : {},
      )
      assert.equal(end.state, "draft")
      assert.equal(end.verification.at(-1).exitCode, 0)
      const rows = ledger(x)
      assert.equal(rows.length, 1)
      const [pr] = rows
      assert.ok(pr.isDraft)
      assert.equal(pr.headRefName, "ow/fix/" + attemptId)
      assert.equal(pr.baseRefName, "main")
      assert.equal(git(x, "--git-dir", x.dir("remote.git"), "rev-parse", "main"), x.tip)
      const head = git(x, "--git-dir", x.dir("remote.git"), "rev-parse", pr.headRefName)
      assert.equal(head, end.head)
      assert.equal(
        git(x, "--git-dir", x.dir("remote.git"), "diff", "--name-only", x.tip, head),
        "settings.json",
      )
      assert.equal(
        JSON.parse(git(x, "--git-dir", x.dir("remote.git"), "show", head + ":settings.json")).timeout,
        30,
      )
      for (const fact of [attemptId, finding.id, x.tip, head, "checkout", "verify.cjs"])
        assert.ok(pr.body.includes(fact), fact)
      assert.match(pr.body, /e_[a-f0-9]+/)
      assert.ok(!pr.body.includes(x.root))
      pr.state = merged ? "MERGED" : "CLOSED"
      pr.mergeCommit = merged ? { oid: head } : null
      if (merged) git(x, "--git-dir", x.dir("remote.git"), "update-ref", "refs/heads/main", head, x.tip)
      fs.writeFileSync(x.dir("prs.json"), JSON.stringify(rows))
      await x.stop("SIGKILL")
      await x.start()
      await until(
        x,
        async () => (await read()).state === (merged ? "awaiting_deploy" : "closed_unmerged"),
        "host state not reconciled",
      )
      assert.equal((await item(x, x.subject)).incident.way, null)
      if (merged) {
        x.world({ revision: head })
        for (let n = 0; n < 4; n++) {
          await x.advance(60000)
          await x.poll()
        }
        assert.equal((await read()).state, "released_quiet")
        assert.equal((await item(x, x.subject)).incident.way.kind, "done")
      }
      assert.equal(ledger(x).length, 1)
      assert.ok(fs.existsSync(x.dir("checkout/owner-only")))
    },
  )
