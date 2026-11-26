import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import { createInterface } from "node:readline"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fixtureTemp } from "../temp.mjs"
import { binary } from "./chrome.mjs"

test("killing a Chrome test releases its real profile and service scratch", { skip: !binary, timeout: 25000 }, async t => {
  const temp = fixtureTemp("killed-browser-")
  const script = `
    import { rig } from ${JSON.stringify(new URL("../m1/rig.mjs", import.meta.url).href)}
    import { browser } from ${JSON.stringify(new URL("./chrome.mjs", import.meta.url).href)}
    const hooks = { after() {} }
    const x = await rig(hooks)
    await x.start("demo")
    const b = await browser(hooks, x)
    await b.visit(x.url + "/")
    console.log(JSON.stringify({ browser: b.pid, service: x.child.pid }))
  `
  const worker = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    env: { ...process.env, TMPDIR: temp }, stdio: ["ignore", "pipe", "inherit"],
  })
  const closed = once(worker, "close")
  t.after(() => worker.kill("SIGKILL"))
  const output = createInterface({ input: worker.stdout })
  const [ready] = await Promise.race([once(output, "line"), closed])
  assert.equal(typeof ready, "string", "Chrome and the service must be ready before killing the worker")
  const { browser, service } = JSON.parse(ready)
  const alive = pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error.code === "ESRCH") return false
      throw error
    }
  }
  assert.ok(fs.readdirSync(temp).some(name => name.startsWith("owa-")))
  worker.kill("SIGKILL")
  assert.deepEqual(await closed, [null, "SIGKILL"])
  const deadline = Date.now() + 6000
  while ((alive(browser) || alive(service) || fs.readdirSync(temp).length) && Date.now() < deadline) await delay(25)
  assert.equal(alive(browser), false, "Chrome exited after its CDP pipe closed")
  assert.equal(alive(service), false, "the demo service exited with its worker")
  assert.deepEqual(fs.readdirSync(temp), [])
})
