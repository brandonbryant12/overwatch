// Executable maintenance experiment. Mutations occur only in a disposable archive of the graded revision.
import fs from "node:fs"
import { fixtureTemp } from "../temp.mjs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
const repo = fileURLToPath(new URL("../../", import.meta.url)),
  tmp = fixtureTemp("ow-m4-extension-")
const at = (p) => path.join(tmp, p)
const add = (p, s) => fs.appendFileSync(at(p), s)
const replace = (p, old, s) => {
  const a = fs.readFileSync(at(p), "utf8")
  if (!a.includes(old)) throw Error(old)
  fs.writeFileSync(at(p), a.replace(old, s))
}
try {
  const archive = execFileSync("git", ["archive", "ddc68e7"], { cwd: repo, maxBuffer: 32 * 1024 * 1024 })
  execFileSync("tar", ["-xf", "-", "-C", tmp], { input: archive })
  fs.symlinkSync(path.join(repo, "node_modules"), at("node_modules"), "dir")
  replace(
    "src/store.ts",
    '  {\n    name: "events",',
    '  {name:"review_links",ddl:"CREATE TABLE review_links (incident TEXT, related_case TEXT)",columns:["incident","related_case"]},\n  {\n    name: "events",',
  )
  add("src/collect.ts", "\nexport const receiptTime = (): Reading => observe(true, Date.now());\n")
  replace(
    "src/server.ts",
    '      if (req.method === "GET" && path === "/v2/inbox")',
    `      if(req.method === "POST" && path === "/v2/review-note") {
        const seq=store.tx(w=>w.event("review_note",null,{}));
        const peer = config.opencode.url;
        if(peer) await fetch(peer + "/review-ledger", {method:"POST"});
        return reply(200,{seq});
      }
      if (req.method === "GET" && path === "/v2/inbox")`,
  )
  add(
    "review.mjs",
    `import {Store} from "./src/store.ts";import {receiptTime} from "./src/collect.ts";
import {rig} from "./accept/m1/rig.mjs";import {api} from "./accept/m2/api.mjs";import {join} from "node:path";
const s=Store.own(join(process.argv[2],"database"));let writer;
s.tx(w=>{writer=w;w.run("INSERT INTO review_links (related_case) VALUES (?)","absent")});
const backup=join(process.argv[2],"outside.db");s.backup(backup);s.restore(backup);
console.log("nonvocabulary",s.get("SELECT related_case from review_links"));
s.tx(w=>w.run("UPDATE review_links SET incident=?","absent"));const b=backup+"2";s.backup(b);
try{s.restore(b)}catch(e){console.log("vocabulary",e.message)}
s.guard=()=>{throw Error("no room")};
try{s.tx(w=>w.event("another_write",null,{}))}catch(e){console.log("write",e.message)}
try{writer.event("late",null,{})}catch(e){console.log("retained",e.message)}
console.log("consumer",receiptTime().state,typeof receiptTime().observedMs);s.close()
const cleanup=[];try{const x=await rig({after:f=>cleanup.push(f)});await x.start();
const key=(await api(x,"focus?subject=env:shop/prod")).requestKey;
for(let i=0;i<2;i++)console.log("owner write",await api(x,"review-note",{},{key}));
console.log("unreceipted dispatches",x.p.requests.filter(r=>r.path==="/review-ledger").length)
}finally{for(const f of cleanup.reverse())await f()}`,
  )
  execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", at("review.mjs"), tmp], {
    cwd: tmp,
    stdio: "inherit",
  })
  const compile = () => spawnSync(at("node_modules/.bin/tsc"), ["--noEmit"], { cwd: tmp, encoding: "utf8" })
  const pre = compile()
  console.log("typecheck with new consumer/route/dispatch", pre.status, pre.stdout)
  if (pre.status !== 0) throw Error("extension fixture failed to compile")
  replace(
    "src/config.ts",
    "export const READINGS = {",
    "export const READINGS = { weatherReview: ['pressure'],",
  )
  const post = compile()
  console.log(
    "new kind",
    post.status,
    post.stdout
      .split("\n")
      .filter((l) => l.includes("weatherReview"))
      .slice(0, 3)
      .join("\n"),
  )
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
