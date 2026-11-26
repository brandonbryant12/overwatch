import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { scenario, git, ledger, commit } from "./rig.mjs"
import { api, item } from "../m2/api.mjs"
import { until } from "../m3/rig.mjs"

const host =
  (pause, interrupt = false) =>
  (x) =>
    fs.writeFileSync(x.dir("host-fault.json"), JSON.stringify({ pause, interrupt }))
const resume = (x) => fs.writeFileSync(x.dir("host-resume"), "ready")
const ref = (x, r) => git(x, "--git-dir", x.dir("remote.git"), "rev-parse", r)
for (const stage of ["protection", "list", "create", "created"])
  test("L " + stage + " process cut reconciles the verified head with one draft", async (t) => {
    const { x, end, attemptId } = await scenario(t, {
      beforeStart: host(stage, true),
      onHost: async (x, id) => {
        const intent = await api(x, "fixes/" + id)
        assert.equal(intent.state, "publishing")
        assert.ok(intent.head)
        await x.stop("SIGKILL")
        resume(x)
        await x.start()
      },
    })
    assert.ok(x.hostHandled)
    assert.equal(end.state, "draft")
    assert.equal(ledger(x).length, 1)
    assert.equal(ref(x, "refs/heads/ow/fix/" + attemptId), end.head)
    assert.equal(ref(x, "main"), x.tip)
  })
test("L conflicting candidate branch pre-exists with a different head", async (t) => {
  const { x, end } = await scenario(t, {
    proposal: async (x) => {
      const f = (await item(x, x.subject)).fixes.at(-1)
      git(x, "--git-dir", x.dir("remote.git"), "update-ref", "refs/heads/ow/fix/" + f.id, x.previous)
      return { kind: "setting", path: "settings.json", key: "timeout" }
    },
  })
  assert.equal(end.state, "refused", end.reason)
  assert.equal(ref(x, "ow/fix/" + end.id), x.previous)
  assert.deepEqual(ledger(x), [])
})
test("L base changes after verified branch was pushed but before draft lookup completes", async (t) => {
  const { x, end } = await scenario(t, {
    beforeStart: host("list"),
    onHost: async (x) => {
      fs.writeFileSync(x.dir("checkout/notes"), "maintainer update")
      x.git("add", "notes")
      commit(x, "Maintainer update")
      git(x, "--git-dir", x.dir("remote.git"), "fetch", "-q", x.dir("checkout"), "main")
      git(x, "--git-dir", x.dir("remote.git"), "update-ref", "refs/heads/main", x.git("rev-parse", "HEAD"))
      resume(x)
    },
  })
  assert.ok(x.hostHandled)
  assert.equal(end.state, "stale", end.reason)
  assert.deepEqual(ledger(x), [])
})
test("L revoking investigation gate at the publishing intent blocks external publication", async (t) => {
  const { x, end } = await scenario(t, {
    beforeStart: host("protection"),
    onHost: async (x) => {
      x.p.mode = "wrong"
      const result = await x.json("trial", [], 4)
      assert.equal(result.automation, false)
      resume(x)
    },
  })
  assert.ok(x.hostHandled)
  assert.equal(end.state, "blocked", end.reason)
  assert.deepEqual(ledger(x), [])
})
test("L failed draft creation stays visible and retry reconciles one draft", async (t) => {
  const { x, end } = await scenario(t, {
    beforeStart: host("create", true),
    onHost: async (x, id) => {
      resume(x)
      await until(
        x,
        async () => {
          const a = await api(x, "fixes/" + id)
          return a.reason || a.state === "draft"
        },
        "retry never ran",
      )
    },
  })
  assert.ok(x.hostHandled)
  assert.equal(end.state, "draft")
  assert.equal(ledger(x).length, 1)
})

test("L base changes during pre-push host policy lookup", async (t) => {
  const { x, end } = await scenario(t, {
    beforeStart: host("protection"),
    onHost: async (x) => {
      fs.writeFileSync(x.dir("checkout/notice"), "new release")
      x.git("add", "notice")
      commit(x, "New base")
      git(x, "--git-dir", x.dir("remote.git"), "fetch", "-q", x.dir("checkout"), "main")
      git(x, "--git-dir", x.dir("remote.git"), "update-ref", "refs/heads/main", x.git("rev-parse", "HEAD"))
      resume(x)
    },
  })
  assert.ok(x.hostHandled)
  assert.equal(
    git(x, "--git-dir", x.dir("remote.git"), "for-each-ref", "--format=%(refname)", "refs/heads/ow/fix/"),
    "",
    "candidate branch published after the base moved",
  )
  assert.equal(end.state, "stale")
  assert.equal(ledger(x).length, 0)
})
test("L restore the locally filed fix proposal after SIGKILL before peer idle", async (t) => {
  const release = Promise.withResolvers()
  let filed = false,
    cut = false
  const { end, proposals } = await scenario(t, {
    automatic: true,
    afterProposal: async () => {
      filed = true
      await release.promise
    },
    onDecision: async (x, attemptId) => {
      if (filed && !cut) {
        cut = true
        try {
          assert.equal((await api(x, "fixes/" + attemptId)).state, "proposing")
          await x.stop("SIGKILL")
        } finally {
          release.resolve()
        }
        await x.start()
      }
    },
  })
  assert.ok(cut)
  assert.equal(end.state, "draft", end.reason)
  assert.equal(proposals.length, 1, "repeated a committed model selection")
})

test("L persistent host creation failure gives the owner a reason while waiting", async (t) => {
  let x
  try {
    await scenario(t, {
      decisionTimeout: 1800,
      beforeStart(r) {
        x = r
        fs.writeFileSync(r.dir("host-fault.json"), JSON.stringify({ createError: true }))
      },
    })
  } catch (e) {
    if (!/no draft decision/.test(e.message)) throw e
  }
  const calls = fs.readFileSync(x.dir("gh.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  assert.ok(calls.some((a) => a[0] === "pr" && a[1] === "create"))
  const a = (await item(x, x.subject)).fixes.at(-1)
  assert.match(
    a.reason ?? "",
    /permission|host|draft creation/i,
    "owner sees " + a.state + " with reason " + String(a.reason),
  )
  assert.deepEqual(ledger(x), [])
})
