import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { scenario } from "./rig.mjs"

test("after restart a completed fix releases its interrupted verification checkout", async t => {
  let interrupted
  const { x, end } = await scenario(t, {
    setup: {
      stable(x, put) {
        put("verify.cjs", [
          'const fs = require("node:fs")',
          'const path = require("node:path")',
          'const settings = JSON.parse(fs.readFileSync("settings.json", "utf8"))',
          'fs.writeFileSync(path.join(process.env.TMPDIR, "verification-started"), "")',
          'setTimeout(() => process.exit(settings.timeout === 30 ? 0 : 91), 1500)',
        ].join("\n"))
      },
    },
    decisionTimeout: 25000,
    async onDecision(x) {
      if (interrupted) return
      const scratch = fs.readdirSync(x.dir("tmp")).find(name =>
        name.startsWith("ow-verify-") && fs.existsSync(x.dir(path.join("tmp", name, "tmp", "verification-started"))))
      if (!scratch) return
      interrupted = scratch
      await x.stop("SIGKILL")
      await x.start()
    },
  })
  assert.ok(interrupted, "the first verify command must be running at the cut")
  assert.equal(end.state, "draft", end.reason)
  await x.stop()
  const left = fs.readdirSync(x.dir("tmp")).filter(name => name.startsWith("ow-verify-"))
  assert.deepEqual(left, [], "completed retry retained " + left.length + " verification checkout(s)")
})
