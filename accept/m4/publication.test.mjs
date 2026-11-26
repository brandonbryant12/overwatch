import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { scenario, git, ledger, refs, commit } from "./rig.mjs"
import { api, item } from "../m2/api.mjs"
import { until, send } from "../m3/rig.mjs"

const put = (x, p, v) => fs.writeFileSync(x.dir("checkout/" + p), v)
const add = (x, file, title) => {
  x.git("add", file)
  commit(x, title)
  return x.git("rev-parse", "HEAD")
}
const tip = (x) => git(x, "--git-dir", x.dir("remote.git"), "rev-parse", "main")
const selected = (x) => ({ kind: "revert", commit: x.selected ?? x.tip })
const held = (x) => assert.deepEqual([ledger(x).length, refs(x).includes("refs/heads/ow/fix/")], [0, false])

test("D01 selected non-tip commit in rollout, landed on a later clean base", async (t) => {
  const { x, end } = await scenario(t, {
    proposal: selected,
    setup: {
      afterChange(x) {
        x.selected = x.git("rev-parse", "HEAD")
        put(x, "notes", "kept\n")
        add(x, "notes", "Later in the rollout")
      },
      afterDeploy(x) {
        put(x, "metadata", "next\n")
        add(x, "metadata", "Post-rollout")
        x.git("push", "-q", "origin", "main")
      },
    },
  })
  assert.equal(end.state, "draft", end.reason)
  assert.equal(git(x, "--git-dir", x.dir("remote.git"), "rev-parse", end.head + "^"), tip(x))
  assert.equal(
    git(x, "--git-dir", x.dir("remote.git"), "diff", "--name-only", end.base, end.head),
    "settings.json",
  )
})
test("D02 merge inverse keeps first-parent changes and reverts merged setting", async (t) => {
  const { x, end } = await scenario(t, {
    proposal: selected,
    setup: {
      beforeChange(x) {
        x.git("switch", "-qc", "topic")
      },
      afterChange(x) {
        x.git("switch", "-q", "main")
        put(x, "note", "first parent")
        add(x, "note", "First parent")
        x.git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=f@localhost",
          "merge",
          "-q",
          "--no-ff",
          "topic",
          "-m",
          "Merge timeout",
        )
      },
    },
  })
  assert.equal(end.state, "draft", end.reason)
  assert.equal(
    git(x, "--git-dir", x.dir("remote.git"), "rev-parse", end.head + "^{tree}"),
    x.git("rev-parse", x.tip + "^1^{tree}"),
  )
})
test("D03 conflicting base is void; automatic polls stay void; explicit request after repair succeeds", async (t) => {
  const { x, end, read, finding, attemptId } = await scenario(t, {
    automatic: true,
    proposal: selected,
    setup: {
      afterDeploy(x) {
        put(x, "settings.json", '{"timeout":9}\n')
        add(x, "settings.json", "Concurrent setting")
        x.git("push", "-q", "origin", "main")
      },
    },
  })
  assert.equal(end.state, "stale", end.reason)
  assert.match(end.reason, /cleanly/)
  held(x)
  // Make the repair object available directly in the disposable host; only its owner advances main.
  const bare = x.dir("remote.git")
  put(x, "settings.json", '{"timeout":3}\n')
  const fixed = add(x, "settings.json", "Resolve conflict")
  git(x, "--git-dir", bare, "fetch", "-q", x.dir("checkout"), "main")
  git(x, "--git-dir", bare, "update-ref", "refs/heads/main", fixed)
  await x.stop()
  await x.start()
  await x.poll()
  assert.equal((await read()).state, "stale")
  held(x)
  const replay = await send(x, "items/" + x.subject + "/fix", { jobId: finding.id }, 202)
  assert.equal(replay.attemptId, attemptId)
  await until(x, async () => (await read()).state === "draft", "request did not publish")
  assert.equal((await read()).base, fixed)
})
for (const [code, rolloutAge, lineAge, state] of [
  ["D04", 30000, 75000, "draft"],
  ["D05", undefined, 75000, "ineligible"],
  ["D06", 30000, 90000, "ineligible"],
])
  test(code + " first line inside discovery window; compare actual provider bound", async (t) => {
    const { x, end } = await scenario(t, { rolloutAge, lineAge })
    assert.equal(end.state, state, end.reason)
    if (state === "ineligible") {
      assert.match(end.reason, /strictly after/)
      held(x)
    }
  })
for (const [label, stable, changed, allow] of [
  ["outside allowlist", (x, put) => put("other", "old"), (x, put) => put("other", "new")],
  ["file mode", undefined, (x) => fs.chmodSync(x.dir("checkout/settings.json"), 0o755)],
  ["addition", undefined, (x, put) => put("extra", "new"), "extra"],
  ["deletion", (x, put) => put("extra", "old"), (x) => fs.unlinkSync(x.dir("checkout/extra")), "extra"],
  ["verify input", undefined, (x, put) => put("verify.cjs", "process.exit(0)\n")],
  ["symlink", undefined, (x) => fs.symlinkSync("settings.json", x.dir("checkout/link")), "link"],
])
  test("T " + label + " in selected inverse prevents verification and publication", async (t) => {
    const { x, end } = await scenario(t, {
      proposal: selected,
      setup: { stable, changed },
      beforeStart(x) {
        if (allow) x.cfg.apps.shop.fixes.paths.push(allow)
      },
    })
    assert.equal(end.state, "refused", end.reason)
    assert.deepEqual(end.verification, [])
    held(x)
  })
const foreign = {
  number: 419,
  url: "http://127.0.0.1/pull/419",
  headRefName: "another",
  baseRefName: "release",
  state: "OPEN",
  isDraft: false,
  body: "unrelated",
}
for (const [code, fault] of [
  ["H01", { protectionError: true }],
  ["H02", { listError: true }],
  ["H03", { listRow: foreign }],
  ["H04", { createOutput: "operation complete" }],
])
  test(code + " uncertain host reply never becomes a confirmed draft", async (t) => {
    // The API may leave the attempt pending indefinitely. Observe the host boundary, then read without driving it.
    let x, doc
    const done = scenario(t, {
      beforeStart(r) {
        x = r
        fs.writeFileSync(r.dir("host-fault.json"), JSON.stringify(fault))
      },
    }).then(
      (v) => ({ end: v.end }),
      (error) => ({ error }),
    )
    const result = await done
    if (result.error && !/no draft decision/.test(result.error.message)) throw result.error
    doc = (await item(x, x.subject)).fixes.at(-1)
    if (code === "H01")
      assert.equal(
        refs(x).includes("refs/heads/ow/fix/"),
        false,
        "pushed while branch protection was unknown",
      )
    if (code === "H02") assert.equal(ledger(x).length, 0, "created after a failed search")
    assert.notEqual(doc.state, "draft", JSON.stringify(doc.pr))
  })
test("P01 evidence in the draft excludes a synthetic private checkout path and recognized secret", async (t) => {
  const { x, end } = await scenario(t, {
    message:
      "ERROR checkout latency in /Users/example-private/src/finance/service.ts password=fixture-printed-123",
  })
  assert.equal(end.state, "draft")
  assert.doesNotMatch(ledger(x)[0].body, /example-private|fixture-printed-123/)
})
test("P02 owner declines a proposing attempt before the model files", async (t) => {
  const { x, end } = await scenario(t, {
    automatic: true,
    proposal: async (x) => {
      const f = (await item(x, x.subject)).fixes.at(-1)
      await send(x, "fixes/" + f.id + "/decline", {}, 200)
      return { kind: "setting", path: "settings.json", key: "timeout" }
    },
  })
  await until(x, async () => ledger(x).length > 0, "observation finished").catch((e) => {
    if (!/observation finished/.test(e.message)) throw e
  })
  assert.equal((await api(x, "fixes/" + end.id)).state, "declined")
  held(x)
})

test("H05 explicit candidate protection refuses every product ref change", async (t) => {
  const { x, end } = await scenario(t, {
    beforeStart(x) {
      fs.writeFileSync(x.dir("host-fault.json"), JSON.stringify({ protected: true }))
    },
  })
  assert.equal(end.state, "refused")
  assert.match(end.reason, /protected/)
  held(x)
  assert.ok(!fs.existsSync(x.dir("remote.git/received-refs")))
})
