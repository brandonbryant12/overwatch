#!/usr/bin/env node
// Local command double. The assessment drives merge/close independently of the service.
import fs from "node:fs"
import path from "node:path"
const cwd = process.env.OW_FIXTURE
const file = path.join(cwd, "prs.json")
const args = process.argv.slice(2)
fs.appendFileSync(path.join(cwd, "gh.jsonl"), JSON.stringify(args) + "\n")
const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []
const option = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null)
const [group, op] = args
const faultFile = path.join(cwd, "host-fault.json")
const fault = fs.existsSync(faultFile) ? JSON.parse(fs.readFileSync(faultFile)) : {}
async function boundary(stage) {
  if (fault.pause !== stage || fs.existsSync(path.join(cwd,"host-resume"))) return
  fs.writeFileSync(path.join(cwd,"host-paused"),stage)
  const end = Date.now()+12000
  while (!fs.existsSync(path.join(cwd,"host-resume")) && Date.now()<end)
    await new Promise(r=>setTimeout(r,15))
  if (fault.interrupt) process.exit(1)
}
if (group === "pr" && op === "list" && fault.listTimeout) await new Promise(r=>setTimeout(r,32000))
await boundary(group === "api" ? "protection" : op)
if (group === "api" && fault.protectionError) { console.error("branch policy unavailable"); process.exit(1) }
if (group === "pr" && op === "list" && fault.listError) { console.error("draft lookup unavailable"); process.exit(1) }
if (group === "pr" && op === "list" && fault.listRow) { console.log(JSON.stringify([{...fault.listRow,headRefName:option("--head")}])); process.exit(0) }
if (group === "pr" && op === "create" && fault.createError) { console.error("fixture draft permission denied"); process.exit(1) }
if (group === "pr" && op === "create" && fault.createOutput) { console.log(fault.createOutput); process.exit(0) }
if (args[0] === "--version") console.log("gh version 2.80.0")
else if (group === "auth" && op === "status") console.log("Fixture account")
else if (group === "api" && args.some((a) => a.includes("branches/"))) {
  const name = args.find((a) => a.includes("branches/")).split("branches/")[1]
  console.log(JSON.stringify({ name, protected: fault.protected === true || name === "main" }))
} else if (group === "pr" && op === "create") {
  const body = option("--body-file") ? fs.readFileSync(option("--body-file"), "utf8") : option("--body")
  const number = rows.length + 1,
    url = "http://127.0.0.1/pull/" + number
  rows.push({
    number,
    url,
    isDraft: args.includes("--draft"),
    baseRefName: option("--base"),
    headRefName: option("--head"),
    title: option("--title"),
    body,
    state: "OPEN",
    mergeCommit: null,
  })
  fs.writeFileSync(file, JSON.stringify(rows))
  await boundary("created")
  console.log(url)
} else if (group === "pr" && ["list", "view"].includes(op)) {
  let result = rows.filter((r) => !option("--head") || r.headRefName === option("--head"))
  if (op === "view")
    result = result.find(
      (r) => String(r.number) === args[2] || r.url === args[2] || r.headRefName === args[2],
    )
  if (!result) process.exit(1)
  console.log(JSON.stringify(result))
} else {
  console.error("Unsupported fixture gh operation", group, op)
  process.exit(9)
}
