/**
 * What one demo, one trial and one killed verify leave in the service's temporary folder, measured with the
 * acceptance rigs. Prints one JSON line per case. Not part of `pnpm run check`.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { rig, BIN } from "../../accept/m1/rig.mjs"
import { scenario } from "../../accept/m4/rig.mjs"

function measure(dir) {
  let dirs = 0, bytes = 0
  const walk = (p) => { for (const n of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, n.name); if (n.isDirectory()) { dirs++; walk(q) } else bytes += fs.lstatSync(q).size } }
  const top = fs.readdirSync(dir)
  walk(dir)
  return { top, dirs, bytes }
}

test("one demo", async (t) => {
  const x = await rig(t)
  x.save()
  const p = spawn(BIN, ["demo", "--config", x.dir("config.json"), "--json"], { env: x.env, stdio: ["ignore", "pipe", "ignore"] })
  await once(p.stdout, "data")
  p.kill("SIGTERM")
  await once(p, "exit")
  const m = measure(x.dir("tmp"))
  console.log(JSON.stringify({ case: "demo", ...m }))
  assert.deepEqual(m.top, [])
})

test("one trial", async (t) => {
  const { x } = await scenario(t, { pass: "investigationOnly" })
  await x.stop()
  const m = measure(x.dir("tmp"))
  console.log(JSON.stringify({ case: "trial and a verified draft", ...m }))
  assert.deepEqual(m.top.filter((n) => /^(overwatch-|ow-)/.test(n)), [])
})

test("one killed verify", async (t) => {
  let killed = false
  const { x } = await scenario(t, {
    setup: { stable(x, put) { put("verify.cjs", 'const fs=require("node:fs");fs.writeFileSync(require("node:path").join(process.env.TMPDIR,"started"),"");setTimeout(()=>process.exit(JSON.parse(fs.readFileSync("settings.json","utf8")).timeout===30?0:91),1500)') } },
    decisionTimeout: 25000,
    async onDecision(x) {
      if (killed) return
      const v = fs.readdirSync(x.dir("tmp")).find((n) => n.startsWith("ow-verify-") && fs.existsSync(x.dir(path.join("tmp", n, "tmp", "started"))))
      if (!v) return
      killed = true
      await x.stop("SIGKILL")
      console.log(JSON.stringify({ case: "at the kill", ...measure(x.dir("tmp")) }))
      await x.start()
      console.log(JSON.stringify({ case: "right after restart", ...measure(x.dir("tmp")) }))
    },
  })
  assert.ok(killed)
  await x.stop()
  const m = measure(x.dir("tmp"))
  console.log(JSON.stringify({ case: "killed verify, after the retry and stop", ...m }))
  assert.deepEqual(m.top.filter((n) => /^(overwatch-|ow-)/.test(n)), [])
})
