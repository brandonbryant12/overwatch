import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { createInterface } from "node:readline"
import { randomBytes } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { peers } from "./peers.mjs"

export const BIN = fileURLToPath(new URL("../../bin/overwatch", import.meta.url))
const fake = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url))
export const T = Date.UTC(2026, 0, 20, 12)
export const iso = (n) => new Date(n).toISOString()
export const stamp = iso(T - 1000)
const shell = (s) => "'" + s.replaceAll("'", "'\\''") + "'"
export function capture(exe, args, opt = {}) {
  const c = spawn(exe, args, { ...opt, stdio: ["ignore", "pipe", "pipe"] })
  let out = "",
    err = ""
  c.stdout.on("data", (b) => (out += b))
  c.stderr.on("data", (b) => (err += b))
  const timer = setTimeout(() => c.kill("SIGKILL"), opt.timeout ?? 20000)
  return once(c, "close")
    .then(([code, signal]) => ({ code, signal, out, err }))
    .finally(() => clearTimeout(timer))
}
export async function rig(t, { both = false, baseline = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-m1-"))
  const dir = (name) => path.join(root, name)
  for (const d of [
    "bin",
    "home",
    "config/opencode/skills/overwatch",
    "state",
    "cache",
    "tmp",
    "data",
    "checkout",
    "home/Library/LaunchAgents",
  ])
    fs.mkdirSync(dir(d), { recursive: true })
  const children = new Set()
  let w = { lines: [] },
    now = T,
    mono = 0
  const p = await peers(() => w)
  t.after(async () => {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) {
        const closed = once(c, "close")
        c.kill("SIGKILL")
        await closed
      }
    await p.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const token = randomBytes(24).toString("hex")
  p.token = token
  const env = {
    PATH: dir("bin") + ":" + path.dirname(process.execPath) + ":/usr/bin:/bin",
    HOME: dir("home"),
    TMPDIR: dir("tmp"),
    XDG_CONFIG_HOME: dir("config"),
    XDG_DATA_HOME: dir("data"),
    XDG_STATE_HOME: dir("state"),
    XDG_CACHE_HOME: dir("cache"),
    OW_FIXTURE: root,
    OW_BIN: BIN,
    OW_MCP_TOKEN: token,
    DD_API_KEY: "fixture-api",
    DD_APP_KEY: "fixture-app",
    KUBECONFIG: dir("no-cluster"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HTTPS_PROXY: p.url,
    NO_PROXY: "127.0.0.1,localhost",
    npm_config_registry: p.url + "/registry",
  }
  for (const name of ["kubectl", "gh", "opencode", "launchctl", "security"])
    fs.writeFileSync(
      dir("bin/" + name),
      "#!/bin/sh\nexec " + shell(process.execPath) + " " + shell(fake) + " " + name + ' "$@"\n',
      { mode: 0o755 },
    )
  const git = (...args) =>
    execFileSync("git", ["-C", dir("checkout"), ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  git("init", "-q")
  fs.writeFileSync(dir("checkout/main.txt"), "tracked at deploy\n")
  git("add", "main.txt")
  git(
    "-c",
    "user.email=fixture@localhost",
    "-c",
    "user.name=Fixture",
    "commit",
    "-qm",
    "first fixture deployment",
  )
  w.revision = git("rev-parse", "HEAD")
  const pods = {
    type: "kubernetes",
    context: "lab",
    namespace: "shop",
    selector: "app=shop",
    readings: ["logs", "events", "workloads", "usage"],
  }
  const dd = {
    type: "datadog",
    baseUrl: p.url,
    apiKey: "env:DD_API_KEY",
    appKey: "env:DD_APP_KEY",
    query: "service:shop",
    metric: "avg:shop.errors{*}",
    readings: ["logs", "monitors", "metrics"],
  }
  const sources = both ? { pods, dd } : { pods }
  const cfg = {
    version: 2,
    dataDir: dir("store"),
    port: 0,
    mcpToken: "env:OW_MCP_TOKEN",
    apps: { shop: { checkout: dir("checkout"), environments: { prod: { sources } } } },
    watchers: [{ app: "shop", environment: "prod", every: "1m" }],
    opencode: { url: p.url, model: "fixture/glm" },
    readings: 3,
  }
  const ocConfig = () => ({
    model: "fixture/glm",
    agents: {
      "ow-investigator": {
        mode: "primary",
        permissions: [
          { action: "*", resource: "*", effect: "deny" },
          ...["ow_telemetry", "ow_code_read", "ow_code_search", "ow_history", "ow_finding"].map((n) => ({
            action: "ow_" + n,
            resource: "*",
            effect: "allow",
          })),
        ],
      },
    },
    mcp: {
      servers: {
        ow: {
          type: "remote",
          url: (p.service ?? "http://127.0.0.1:7331") + "/mcp",
          headers: { Authorization: "Bearer " + token },
          oauth: false,
          codemode: false,
        },
      },
    },
  })
  const writeOC = () => fs.writeFileSync(dir("config/opencode/opencode.json"), JSON.stringify(ocConfig()))
  writeOC()
  fs.writeFileSync(
    dir("config/opencode/skills/overwatch/SKILL.md"),
    "---\nname: overwatch\ndescription: Read the Overwatch inbox.\n---\nUse the Overwatch tools.\n",
  )
  const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  fs.writeFileSync(
    dir("home/Library/LaunchAgents/dev.overwatch.service.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>dev.overwatch.service</string><key>ProgramArguments</key><array>' +
      [BIN, "serve", "--config", dir("config.json")].map((v) => "<string>" + xml(v) + "</string>").join("") +
      "</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>" +
      xml(env.PATH) +
      "</string><key>HTTPS_PROXY</key><string>" +
      p.url +
      "</string></dict></dict></plist>",
  )
  const save = () => fs.writeFileSync(dir("config.json"), JSON.stringify(cfg))
  const world = (patch) => {
    w = { ...w, ...patch }
    fs.writeFileSync(dir("world.next"), JSON.stringify(w))
    fs.renameSync(dir("world.next"), dir("world.json"))
  }
  save()
  world({})
  const cli = (cmd, args = [], { human = false, exe = BIN, timeout } = {}) =>
    capture(exe, [cmd, "--config", dir("config.json"), ...args, ...(human ? [] : ["--json"])], {
      env,
      cwd: root,
      timeout,
    })
  const json = async (cmd, args = [], code = 0, opts) => {
    const r = await cli(cmd, args, opts)
    assert.equal(r.code, code, r.err + " " + r.out)
    return JSON.parse(r.out)
  }
  const logs = []
  const x = {
    root,
    dir,
    env,
    w: () => w,
    cfg,
    p,
    token,
    git,
    world,
    save,
    cli,
    json,
    logs,
    now: () => now,
    calls: () =>
      fs.existsSync(dir("calls.jsonl"))
        ? fs.readFileSync(dir("calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
        : [],
    inspect: (fn) => {
      assert.ok(!x.child, "database observation requires stopped service")
      const db = new DatabaseSync(dir("store/overwatch.db"), { readOnly: true })
      try {
        return fn(db)
      } finally {
        db.close()
      }
    },
  }
  x.start = async (command = "serve", exe = BIN) => {
    const c = spawn(exe, [command, "--config", dir("config.json"), "--json"], {
      env: { ...env, OW_TEST_FD: "3" },
      cwd: root,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    })
    children.add(c)
    x.child = c
    c.stderr.on("data", (b) => logs.push(String(b)))
    const closed = once(c, "close")
    const readers = createInterface({ input: c.stdout })
    const ready = once(readers, "line")
    const timer = AbortSignal.timeout(8000)
    const line = await Promise.race([
      ready,
      closed.then(() => {
        throw Error("serve exited " + logs.join("").slice(-800))
      }),
      once(timer, "abort").then(() => {
        throw Error("serve never became ready")
      }),
    ])
    const r = (x.ready = JSON.parse(line[0]))
    assert.equal(r.version, 2)
    p.service = x.url = r.url
    writeOC()
    const fd = c.stdio[3],
      pending = new Map()
    let id = 0
    fd.on("error", () => {})
    createInterface({ input: fd }).on("line", (l) => {
      const v = JSON.parse(l)
      pending.get(v.id)?.(v)
    })
    closed.then(() => {
      for (const notify of pending.values()) notify(null)
      if (x.child === c) x.child = null
    })
    x.control = (op, args = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id,
          tm = setTimeout(() => {
            pending.delete(n)
            reject(Error("control timed out " + op))
          }, 30000)
        pending.set(n, (v) => {
          clearTimeout(tm)
          pending.delete(n)
          v ? resolve(v) : reject(Error("service exited during " + op))
        })
        fd.write(JSON.stringify({ id: n, op, ...args }) + "\n")
      })
    await x.control("clock", { nowMs: now, monoMs: mono })
    return x
  }
  x.advance = async (ms, wall = ms) => {
    now += wall
    mono += ms
    await x.control("clock", { nowMs: now, monoMs: mono })
  }
  x.stop = async (signal = "SIGTERM") => {
    const c = x.child
    if (!c) return
    const end = once(c, "close")
    c.kill(signal)
    await end
    x.child = null
  }
  x.status = async () => {
    const r = await fetch(x.url + "/v2/status", { signal: AbortSignal.timeout(4000) })
    assert.equal(r.status, 200)
    return r.json()
  }
  x.poll = () => x.control("poll")
  if (baseline) {
    const r = await cli("check")
    assert.equal(r.code, 0, "rewrite check failed: " + (r.err + r.out).slice(0, 600))
    assert.equal(JSON.parse(r.out).version, 2, "requires the simple-core executable")
  }
  return x
}
export const byTitle = (s, word) => s.incidents.filter((i) => i.title.toLowerCase().includes(word))
export const total = (s, word) => byTitle(s, word).reduce((n, i) => n + i.count, 0)

// M1 exposed trial rows at the root. M2 gives them a separate namespace.
export const trialRows = snapshot => snapshot.trial ?? snapshot
