// Run explicitly. All mutations and fixture traffic belong to the archived review copy.
import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import { fixtureTemp } from "./temp.mjs"

const repo = fileURLToPath(new URL("../", import.meta.url))
const tmp = fixtureTemp("extension-")
const file = (p) => path.join(tmp, p)
const change = (p, before, after) => {
  const source = fs.readFileSync(file(p), "utf8")
  assert.ok(source.includes(before), p)
  fs.writeFileSync(file(p), source.replace(before, after))
}
const run = (exe, args) =>
  spawnSync(exe, args, { cwd: tmp, env: { ...process.env, TMPDIR: tmp }, encoding: "utf8" })
const tsc = () => run(file("node_modules/.bin/tsc"), ["--noEmit"])
const audit = (pattern) =>
  run(process.execPath, [
    "--experimental-strip-types",
    "--no-warnings",
    "--test",
    "--test-name-pattern=" + pattern,
    "test/classes.test.ts",
  ])
try {
  const archive = execFileSync("git", ["archive", "8663a38"], { cwd: repo, maxBuffer: 32 * 1024 * 1024 })
  execFileSync("tar", ["-xf", "-", "-C", tmp], { input: archive })
  fs.symlinkSync(path.join(repo, "node_modules"), file("node_modules"), "dir")
  change(
    "src/store.ts",
    '    name: "events",',
    `    name: "review_links", ddl:"CREATE TABLE review_links (related_case TEXT, owner_case TEXT)", columns:["related_case","owner_case"], refs:{related_case:"incidents.id"}
  },
  {
    name: "events",`,
  )
  fs.appendFileSync(
    file("src/collect.ts"),
    "\nexport const reviewObservation = (): Reading => observe(true, Date.now());\n",
  )
  change(
    "src/server.ts",
    "      const KEYED:",
    `      if (req.method === "POST" && path === "/v2/review-note") {
        return reply(200,{seq:store.tx(w=>w.event("review_note",null,{}))});
      }
      const KEYED:`,
  )
  fs.writeFileSync(
    file("review.mjs"),
    `
import {Store} from "./src/store.ts"
import {reviewObservation} from "./src/collect.ts"
import {rig} from "./accept/m1/rig.mjs"
import {api} from "./accept/m2/api.mjs"
import assert from "node:assert/strict"
const s=Store.own(process.argv[2]+"/db")
// Observe only the receipt lifecycle. These checks dispatch no command or network request.
const issued=s.permit("notice",null,{step:"display"})
assert.throws(()=>issued.spend("push"),/committed intent/)
issued.spend("notice")
assert.throws(()=>issued.spend("notice"),/committed intent/)
let rolledBack
assert.throws(()=>s.tx(w=>{rolledBack=w.permit("notice",null);throw Error("rollback control")}),/rollback control/)
assert.throws(()=>rolledBack.spend("notice"),/committed intent/)
const transport=JSON.stringify(s.permit("notice",null,{step:"restart control"}))
const {spawnSync}=await import("node:child_process")
const restarted=spawnSync(process.execPath,["-e","const receipt=JSON.parse(process.argv[1]);if(typeof receipt.spend==='function')process.exit(1);console.log('receipt metadata only')",transport],{encoding:"utf8"})
assert.equal(restarted.status,0,restarted.stderr)
console.log("double spend, rolled back, wrong category: refused; fresh process:",restarted.stdout.trim())
let writer
s.tx(w=>{writer=w;w.run("INSERT INTO review_links(owner_case) VALUES (?)","missing")})
s.backup(process.argv[2]+"/first");s.restore(process.argv[2]+"/first")
console.log("misdeclared",s.get("SELECT owner_case FROM review_links"))
s.tx(w=>w.run("UPDATE review_links SET related_case=?","missing"))
s.backup(process.argv[2]+"/second")
assert.throws(()=>s.restore(process.argv[2]+"/second"),e=>(console.log("declared",e.message),/review_links.related_case/.test(e.message)))
s.guard=()=>{throw Error("capacity exhausted")}
assert.throws(()=>s.tx(w=>w.event("review",null,{})),/capacity exhausted/)
assert.throws(()=>writer.event("late",null,{}),/transaction has ended/)
console.log("new write and retained writer refused; wall-derived reading",reviewObservation().state)
s.close()
const clean=[]
try {
 const x=await rig({after:f=>clean.push(f)});await x.start()
 const {requestKey:key}=await api(x,"focus?subject=env:shop/prod")
 const send=()=>api(x,"review-note",{},{key})
 console.log("two acknowledgements",(await send()).seq,(await send()).seq)
}finally{for(const f of clean.reverse())await f()}
`,
  )
  const runtime = run(process.execPath, ["--experimental-strip-types", "--no-warnings", "review.mjs", tmp])
  assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr)
  console.log(runtime.stdout.trim())
  const first = tsc()
  assert.equal(first.status, 0, first.stdout)
  assert.equal(audit("build: every column").status, 0)
  assert.equal(audit("build: the request key").status, 0)
  console.log("typecheck, column declarations, keyed-router build check: passed")
  const declared = 'columns:["related_case","owner_case"]'
  const missing = 'columns:["related_case"]'
  change("src/store.ts", declared, missing)
  const columnCheck = audit("build: every column")
  assert.equal(columnCheck.status, 1)
  assert.match(columnCheck.stdout, /review_links has an undeclared or missing column/)
  console.log("undeclared owner_case: rejected by the column check")
  change("src/store.ts", missing, declared)
  fs.writeFileSync(
    file("src/review-adapter.ts"),
    'import {spawn} from "node:child_process"; export const unused = spawn;\n',
  )
  assert.equal(audit("build: only src/exec").status, 1)
  fs.unlinkSync(file("src/review-adapter.ts"))
  console.log("unregistered process launcher: build rejected (never called)")
  change(
    "src/config.ts",
    "export const READINGS = {",
    "export const READINGS = { reviewWeather: ['pressure'],",
  )
  const newKind = tsc()
  assert.equal(newKind.status, 2, newKind.stdout)
  console.log(
    newKind.stdout
      .split("\n")
      .filter((l) => l.includes("reviewWeather"))
      .slice(0, 3)
      .join("\n"),
  )
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
