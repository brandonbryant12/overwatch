import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { ledger, scenario } from "./rig.mjs"

// An application-owned npm test entry point for a clean Git archive with vendored packages.
// Populate the ordinary Node module search path in private scratch, using only committed inputs.
const offlineRunner = `
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const deps = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-deps-"))
try {
  for (const entry of ["vendor", "package.json", "package-lock.json"]) {
    fs.cpSync(entry, path.join(deps, entry), { recursive: true })
  }
  const install = spawnSync(process.execPath, [
    process.env.npm_execpath, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
  ], { cwd: deps, stdio: "inherit" })
  if (install.status !== 0) process.exitCode = install.status ?? 1
  else {
    const run = spawnSync(process.execPath, ["check.cjs"], {
      env: { ...process.env, NODE_PATH: path.join(deps, "node_modules") }, stdio: "inherit",
    })
    process.exitCode = run.status ?? 1
  }
} finally {
  fs.rmSync(deps, { recursive: true, force: true })
}
`

// A small offline npm tree. The application needs the validator, which uses the scalar package.
// Track the tarballs and lockfile just as an application may vendor its packages for offline CI.
for (const [label, prepareDeps] of [
  ["the documented npm verify works, or identifies the unavailable prerequisite and its repair", false],
  ["npm test can prepare its locked dependencies offline in verifier scratch", true],
]) test(label, async (t) => {
  const { x, end } = await scenario(t, {
    setup: {
      stable(x, put) {
        const checkout = x.dir("checkout")
        const npm = process.env.PATH.split(path.delimiter)
          .map((dir) => path.join(dir, "npm"))
          .find((file) => fs.existsSync(file))
        assert.ok(npm, "the realistic verifier fixture requires an installed npm CLI")
        fs.symlinkSync(fs.realpathSync(npm), x.dir("bin/npm"))
        const env = { ...x.env, npm_config_cache: x.dir("owner-cache"), npm_config_offline: "true" }
        const command = (exe, args) => spawnSync(exe, args, { cwd: checkout, env, encoding: "utf8" })
        fs.mkdirSync(path.join(checkout, "vendor"))
        for (const [name, dependencies, code] of [
          ["fixture-scalar", {}, "exports.number = x => Number(x)"],
          [
            "fixture-validator",
            { "fixture-scalar": "1.0.0" },
            "exports.ok = x => require('fixture-scalar').number(x) === 30",
          ],
        ]) {
          const dir = x.dir(name + "/package")
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(
            path.join(dir, "package.json"),
            JSON.stringify({ name, version: "1.0.0", dependencies }),
          )
          fs.writeFileSync(path.join(dir, "index.js"), code)
          const packed = command("tar", [
            "-czf",
            "vendor/" + name + ".tgz",
            "-C",
            path.dirname(dir),
            "package",
          ])
          assert.equal(packed.status, 0, packed.stderr)
        }
        put(
          "package.json",
          JSON.stringify({
            name: "fixture-shop",
            private: true,
            version: "1.0.0",
            scripts: { test: prepareDeps ? "node verify-offline.cjs" : "node check.cjs" },
            dependencies: {
              "fixture-validator": "file:vendor/fixture-validator.tgz",
              "fixture-scalar": "file:vendor/fixture-scalar.tgz",
            },
          }),
        )
        if (prepareDeps) put("verify-offline.cjs", offlineRunner)
        put(".gitignore", "node_modules/\n")
        put(
          "check.cjs",
          "const {ok}=require('fixture-validator');process.exit(ok(require('./settings.json').timeout)?0:91)",
        )
        const installed = command("npm", [
          "install",
          "--offline",
          "--no-fund",
          "--no-audit",
          "--ignore-scripts",
        ])
        assert.equal(installed.status, 0, installed.stderr || installed.error?.message)
        assert.ok(fs.existsSync(x.dir("owner-cache/_cacache")))
        const control = command("npm", ["test"])
        assert.equal(control.status, 0, control.stdout + control.stderr)
        x.runOwnerVerify = () => command("npm", ["test"])
      },
      changed(x) {
        const control = x.runOwnerVerify()
        assert.equal(control.status, 91, control.stdout + control.stderr)
      },
    },
    beforeStart(x) {
      x.cfg.apps.shop.fixes.verify = [["npm", "test"]]
    },
  })
  t.diagnostic(JSON.stringify({ state: end.state, reason: end.reason, verification: end.verification }))
  await x.stop()
  assert.deepEqual(fs.readdirSync(x.dir("tmp")).filter(name => name.startsWith("ow-verify-")), [])
  if (prepareDeps) assert.equal(end.state, "draft", JSON.stringify(end.verification))
  if (end.state === "draft") {
    assert.equal(end.verification[0].exitCode, 0)
    assert.equal(ledger(x).length, 1)
  } else {
    assert.equal(end.state, "verify_failed")
    assert.deepEqual(ledger(x), [])
    const feedback = [end.reason, ...end.verification.map((v) => v.summary)].join(" ")
    assert.match(feedback, /sandbox|isolat|dependenc|offline|cache|module|permission|permitted/i)
    assert.match(
      feedback,
      /(?:use|configure|provide|choose|install|vendor) (?:a |an |the )?(?:standalone|self-contained|offline|trusted|verification|dependenc|package|node)/i,
      "Owner needs a workable verification setup: " + feedback,
    )
  }
})
