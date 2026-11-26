// Run explicitly against the assessed revision. This changes only a disposable source archive.
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import { fixtureTemp } from "./temp.mjs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../", import.meta.url))
const scratch = fixtureTemp("ow-extension-review-")
const file = (name) => path.join(scratch, name)
function replace(name, original, next) {
  const source = fs.readFileSync(file(name), "utf8")
  if (!source.includes(original)) throw Error("Unrecognized assessment fixture in " + name)
  fs.writeFileSync(file(name), source.replace(original, next))
}
try {
  const archive = execFileSync("git", ["archive", "4de1027"], { cwd: repo, maxBuffer: 32 * 1024 * 1024 })
  execFileSync("tar", ["-xf", "-", "-C", scratch], { input: archive })
  fs.symlinkSync(path.join(repo, "node_modules"), file("node_modules"), "dir")
  replace(
    "src/config.ts",
    "export const READINGS = { kubernetes:",
    'export const READINGS = { capacityFixture: ["used"], kubernetes:',
  )
  const firstEvent = '  {\n    name: "events",'
  replace(
    "src/store.ts",
    firstEvent,
    '  { name: "review_labels", ddl: "CREATE TABLE review_labels (incident TEXT NOT NULL)", columns: ["incident"] },\n' +
      firstEvent,
  )
  fs.writeFileSync(
    file("src/extension-review.ts"),
    `import { Store } from "./store.ts";
import { endpoint } from "./collect.ts";
import { clean } from "./redact.ts";
import type { Sample } from "./parse.ts";
import type { Source } from "./config.ts";
import {join} from "node:path";
const dir=process.argv[2]!;
const store=Store.own(join(dir,"store"));
const future: Sample={ measured:true,value:Number.NaN };
console.log("new consumer",future.measured,Number.isFinite(future.value));
const source: Source={kind:"capacityFixture",id:"demo/new",app:"demo",name:"new",environment:"staging",everyMs:60000,readings:["used"],excluded:[],checkout:dir,words:{error:[],warn:[]}};
console.log("new source endpoint",endpoint(source));
store.tx(w=>{w.event("label",null,{});w.run("INSERT INTO review_labels (incident) VALUES (?)",clean("absent"))});
const backup=join(dir,"review.sqlite"); store.backup(backup);store.restore(backup);
console.log("new table recovered",store.get("SELECT incident FROM review_labels"));
store.guard=()=>{throw Error("floor")};
try{store.tx(w=>w.event("review",null,{}))}catch{console.log("new ordinary write refused")}
console.log("maintenance-labelled event",store.tx(w=>w.event("review",null,{}),true));store.close();
`,
  )
  execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", file("src/extension-review.ts"), scratch],
    { stdio: "inherit" },
  )
  const compiled = spawnSync(file("node_modules/.bin/tsc"), ["--noEmit"], { cwd: scratch, encoding: "utf8" })
  if (compiled.error) throw compiled.error
  console.log("Full typecheck exit", compiled.status)
  process.stdout.write(compiled.stdout + compiled.stderr)
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
