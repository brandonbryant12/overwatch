import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { scenario, ledger, refs, git } from "./rig.mjs"
import { api } from "../m2/api.mjs"

test("a host that starts enforcing protection at receive time never yields a draft", async t => {
  let sawRefusal = false
  const { x, end } = await scenario(t, {
    beforeStart(x) {
      // The host accepts the policy query, then enforces its new rule at the point of write.
      fs.writeFileSync(x.dir("remote.git/hooks/pre-receive"), [
        "#!/bin/sh",
        "cat >/dev/null",
        'echo protected >&2',
        "exit 1",
        "",
      ].join("\n"), { mode: 0o755 })
    },
    async onDecision(x, id) {
      const attempt = await api(x, "fixes/" + id)
      if (!attempt.reason?.includes("host refused")) return
      sawRefusal = true
      assert.equal(ledger(x).length, 0)
      // Stop after the owner has seen the first rejection.
      const { requestKey } = await api(x, "focus?subject=" + x.subject)
      await api(x, "fixes/" + id + "/decline", {}, { key: requestKey })
    },
  })
  assert.ok(sawRefusal, end.reason)
  assert.equal(end.state, "declined")
  assert.doesNotMatch(refs(x), /refs\/heads\/ow\/fix\//)
  assert.deepEqual(ledger(x), [])
})

for (const [change, expected] of [
  ["owner decline", "declined"],
  ["investigation trial withdrawal", "blocked"],
  ["replacement deployment", "stale"],
  ["new base", "stale"],
]) test("after a recorded policy outage the next admission observes " + change, async t => {
  let interrupted = false
  const { x, end } = await scenario(t, {
    beforeStart(x) {
      fs.writeFileSync(x.dir("host-fault.json"), JSON.stringify({ protectionError: true }))
    },
    async onDecision(x, id) {
      if (interrupted) return
      const attempt = await api(x, "fixes/" + id)
      if (!attempt.reason?.includes("protection")) return
      interrupted = true
      assert.equal(ledger(x).length, 0)
      if (change === "owner decline") {
        const { requestKey } = await api(x, "focus?subject=" + x.subject)
        await api(x, "fixes/" + id + "/decline", {}, { key: requestKey })
      } else if (change === "investigation trial withdrawal") {
        x.p.mode = "wrong"
        assert.equal((await x.json("trial", [], 4)).automation, false)
      } else if (change === "new base") {
        // A host maintainer advances the fake remote while its policy API is down.
        const remote = x.dir("remote.git")
        const newTip = git(x, "--git-dir", remote, "-c", "user.name=Host", "-c", "user.email=host@localhost",
          "commit-tree", x.tip + "^{tree}", "-p", x.tip, "-m", "Host maintenance")
        git(x, "--git-dir", remote, "update-ref", "refs/heads/main", newTip, x.tip)
      } else {
        x.world({ revision: x.previous, lines: [] })
        await x.advance(60000)
        await x.poll()
      }
      fs.writeFileSync(x.dir("host-fault.json"), "{}")
      await x.advance(60000)
    },
    decisionTimeout: 20000,
  })
  assert.ok(interrupted)
  assert.equal(end.state, expected, end.reason)
  assert.deepEqual(ledger(x), [])
  assert.doesNotMatch(refs(x), /refs\/heads\/ow\/fix\//)
})
