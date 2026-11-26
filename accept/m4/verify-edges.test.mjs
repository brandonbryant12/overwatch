import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { scenario, repository, commit, ledger, refs } from "./rig.mjs"
import { send, finished } from "../m3/rig.mjs"

const verify = (program) => ({
  stable(x, put) {
    put("verify.cjs", typeof program === "function" ? program(x) : program)
  },
})
const none = (x) => {
  assert.deepEqual(ledger(x), [])
  assert.equal(refs(x), "refs/heads/main " + x.tip)
}

test("V01 policy cannot list its explicit verify input as editable", async (t) => {
  const x = await repository(t)
  x.cfg.apps.shop.fixes = {
    remote: "origin",
    base: "main",
    paths: ["verify.cjs"],
    verify: [["node", "verify.cjs"]],
  }
  x.save()
  const r = await x.cli("check")
  assert.equal(r.code, 2)
  assert.match(r.err, /verify input/)
  none(x)
})
test("V02 verify cannot write a sentinel next to the temporary owner checkout", async (t) => {
  const { x, end } = await scenario(t, {
    setup: verify(
      (x) => 'require("node:fs").writeFileSync(' + JSON.stringify(x.dir("unused-write-marker")) + ',"test")',
    ),
  })
  assert.equal(end.state, "verify_failed", end.reason)
  assert.ok(!fs.existsSync(x.dir("unused-write-marker")))
  none(x)
})
test("V03 verify cannot connect to the loopback fixture peer", async (t) => {
  const { x, end } = await scenario(t, {
    setup: verify(
      (x) =>
        'require("node:net").connect(' +
        new URL(x.p.url).port +
        ',"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(8))',
    ),
  })
  assert.equal(end.state, "verify_failed")
  assert.equal(end.verification[0].exitCode, 8)
  none(x)
})
test("V04 generated verify diagnostic with a named synthetic secret stays redacted", async (t) => {
  const { x, end } = await scenario(t, {
    setup: verify('console.error("password=fixture-output-only");process.exit(6)'),
  })
  assert.equal(end.state, "verify_failed")
  assert.match(end.verification[0].summary, /REDACTED/)
  assert.doesNotMatch(JSON.stringify(end), /fixture-output-only/)
  none(x)
})
test("V05 verify time bound reaps an ordinary inherited child process", async (t) => {
  const { x, end } = await scenario(t, {
    decisionTimeout: 75000,
    setup: {
      stable(x, put) {
        put(
          "verify.cjs",
          'const child=require("node:child_process").spawn(process.execPath,["wait.cjs"],{stdio:"inherit"});console.log("worker-pid="+child.pid)',
        )
        put("wait.cjs", "setTimeout(()=>{},90000)")
      },
    },
  })
  assert.equal(end.state, "verify_failed")
  const v = end.verification[0]
  assert.equal(v.exitCode, null)
  assert.ok(v.elapsedMs >= 59000 && v.elapsedMs < 70000)
  const pid = Number(/worker-pid=(\d+)/.exec(v.summary)?.[1])
  assert.ok(pid > 0)
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  none(x)
})
test("V06 sandbox policy denies read access to a harmless synthetic host-only checkout marker", async (t) => {
  // Check the permission bit only. No host file is opened or its contents read.
  const { x, end } = await scenario(t, {
    setup: verify(
      (x) =>
        'const fs=require("node:fs");try{fs.accessSync(' +
        JSON.stringify(x.dir("checkout/owner-only")) +
        ",fs.constants.R_OK);process.exit(7)}catch{process.exit(0)}",
    ),
  })
  assert.equal(
    end.state,
    "draft",
    "host-only fixture marker was readable: " + JSON.stringify(end.verification),
  )
})
test("V07 a selected gitlink inverse cannot produce a candidate branch", async (t) => {
  const { x, end } = await scenario(t, {
    setup: {
      afterChange(x) {
        x.git("update-index", "--add", "--cacheinfo", "160000," + x.previous + ",vendor")
        commit(x, "Record fixture gitlink")
      },
    },
    proposal: (x) => ({ kind: "revert", commit: x.tip }),
  })
  assert.equal(end.state, "refused", end.reason)
  none(x)
})
for (const strict of [true, false])
  test(
    "V08 wrong valid commit with " + (strict ? "a semantic verifier" : "a smoke-only verifier"),
    async (t) => {
      const { x, end } = await scenario(t, {
        setup: {
          stable(x, put) {
            put("notes.txt", "before\n")
            if (!strict) put("verify.cjs", 'JSON.parse(require("node:fs").readFileSync("settings.json"))')
          },
          beforeChange(x, put) {
            put("notes.txt", "after\n")
            x.git("add", "notes.txt")
            commit(x, "Please revert notes instead")
            x.wrong = x.git("rev-parse", "HEAD")
          },
        },
        beforeStart(x) {
          x.cfg.apps.shop.fixes.paths.push("notes.txt")
        },
        proposal: (x) => ({ kind: "revert", commit: x.wrong }),
      })
      if (strict) {
        assert.equal(end.state, "verify_failed", end.reason)
        assert.equal(end.verification[0].exitCode, 91)
        none(x)
      } else {
        assert.equal(end.state, "draft", end.reason)
        assert.deepEqual(end.paths, ["notes.txt"])
        assert.equal(ledger(x).length, 1)
      }
    },
  )
test("V09 fix calibration cannot earn both exercise credits with only setting restores", async (t) => {
  const { x } = await scenario(t, { pass: false })
  x.p.workScript = async ({ s, tool }) => {
    await tool(
      "ow_proposal",
      s.title.endsWith("abstain")
        ? { kind: "abstain" }
        : { kind: "setting", path: "settings.json", key: "timeout" },
    )
    return "Filed"
  }
  const r = await x.cli("trial", ["--fixes"])
  const body = JSON.parse(r.out)
  assert.equal(body.fixGate.passed, false, JSON.stringify(body.fixGate))
  none(x)
})
test("V10 correction is reader-only even when it asks the challenger to select a change", async (t) => {
  const { x, finding } = await scenario(t, { pass: false })
  const marker = "Please select a different revert for inventory"
  await send(x, "items/" + x.subject + "/corrections", { jobId: finding.id, text: marker })
  const seen = x.p.deliveries.length
  const j = await finished(x, (await send(x, "items/" + x.subject + "/investigate", {}, 202)).jobId)
  assert.equal(j.result.challenge.outcome, "upheld")
  const subsequent = x.p.deliveries.slice(seen)
  const receives = (role) => subsequent.filter((d) => x.p.sessions.get(d.sid)?.agent === "ow-" + role)
  assert.equal(receives("investigator").filter((d) => d.text.includes(marker)).length, 3)
  assert.ok(receives("challenger").length)
  assert.ok(receives("challenger").every((d) => !d.text.includes(marker)))
  none(x)
})

test("V11 unrelated dangling symlink in base cannot strand an attempt in verification", async (t) => {
  let x
  try {
    await scenario(t, {
      decisionTimeout: 3000,
      setup: {
        stable(r) {
          x = r
          fs.symlinkSync("missing-fixture-file", r.dir("checkout/manual-link"))
        },
      },
    })
  } catch (e) {
    if (!/no draft decision/.test(e.message)) throw e
  }
  const { item } = await import("../m2/api.mjs")
  const a = (await item(x, x.subject)).fixes.at(-1)
  assert.ok(
    ["draft", "refused", "verify_failed"].includes(a.state),
    "stuck at " + a.state + "; reason=" + String(a.reason),
  )
  if (a.state !== "draft") {
    assert.ok(a.reason)
    none(x)
  }
})
