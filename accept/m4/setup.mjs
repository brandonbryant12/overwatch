// Timed clean-fork exercise using the literal examples from the guide and a launchctl ledger.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
const original = fileURLToPath(new URL("../../", import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-colleague-"))
const at = (p) => path.join(root, p)
try {
  const start = performance.now(),
    env = {
      HOME: at("home"),
      PATH: at("bin") + ":" + path.dirname(process.execPath) + ":/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      OW_LAUNCHCTL: at("bin/launchctl"),
      OW_LAUNCHD_PLIST: at("home/Library/LaunchAgents/dev.overwatch.service.plist"),
      HTTPS_PROXY: "http://127.0.0.1:1",
    }
  const run = (p, args, cwd = root) => execFileSync(p, args, { cwd, env, encoding: "utf8" }).trim()
  run("git", ["clone", "-q", "--local", "--no-checkout", original, at("fork")])
  run("git", ["checkout", "-q", "ddc68e7"], at("fork"))
  const guide = fs.readFileSync(at("fork/docs/setup.md"), "utf8"),
    blocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1])
  for (const dir of ["home/.config/overwatch", "home/.config/opencode/skills", "home/src/shop", "bin"])
    fs.mkdirSync(at(dir), { recursive: true })
  fs.writeFileSync(at("home/.config/overwatch/config.json"), blocks[0])
  fs.writeFileSync(at("home/.config/opencode/opencode.json"), blocks[1])
  fs.cpSync(at("fork/skills/overwatch"), at("home/.config/opencode/skills/overwatch"), { recursive: true })
  fs.writeFileSync(env.OW_LAUNCHCTL, '#!/bin/sh\necho "$@" >> "$HOME/launchctl.calls"\n', { mode: 0o755 })
  for (const exe of ["security", "gh", "kubectl", "opencode", "terminal-notifier"])
    fs.writeFileSync(at("bin/" + exe), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  for (const cmd of ["check", "install", "restart", "uninstall"]) {
    console.log(
      cmd,
      run(at("fork/bin/overwatch"), [cmd], at("fork")),
      Math.round(performance.now() - start) + " ms since clone",
    )
    if (cmd === "install")
      assert.ok(fs.readFileSync(env.OW_LAUNCHD_PLIST, "utf8").includes(at("fork/src/main.ts")))
  }
  assert.ok(!fs.existsSync(env.OW_LAUNCHD_PLIST))
  console.log(fs.readFileSync(at("home/launchctl.calls"), "utf8"))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
