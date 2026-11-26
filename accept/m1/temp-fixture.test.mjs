import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { fixtureTemp } from "../temp.mjs"

for (const exit of ["failure", "SIGKILL"]) test("fixture lifetime after worker " + exit, {timeout:15000}, async t => {
  const temp = fixtureTemp("lifetime-")
  const rig = new URL("./rig.mjs",import.meta.url).href
  const source = `import {rig} from ${JSON.stringify(rig)}
    const x=await rig({after() {}}); await x.start()
    console.log(JSON.stringify({service:x.child.pid,root:x.root}))
    if(process.argv[1]==="failure") process.exit(1)`
  const worker = spawn(process.execPath, ["--no-warnings","--input-type=module","-e",source,exit], {
    env:{...process.env,TMPDIR:temp}, stdio:["ignore","pipe","inherit"],
  })
  const closed = once(worker,"close")
  t.after(() => { if (worker.exitCode === null && !worker.signalCode) worker.kill("SIGKILL") })
  const [line] = await once(createInterface({input:worker.stdout}),"line")
  const {service,root} = JSON.parse(line)
  assert.ok(root.startsWith(temp + path.sep))
  if (exit === "SIGKILL") worker.kill("SIGKILL")
  const [code,signal] = await closed
  assert.deepEqual([code,signal],exit === "failure" ? [1,null] : [null,"SIGKILL"])
  const alive = () => {try {process.kill(service,0);return true} catch(e) {if(e.code === "ESRCH") return false;throw e}}
  const deadline = Date.now()+5000
  while ((fs.readdirSync(temp).length || alive()) && Date.now()<deadline) await delay(25)
  assert.deepEqual(fs.readdirSync(temp),[])
  assert.equal(alive(),false,"the test's service should exit with its worker")
})
