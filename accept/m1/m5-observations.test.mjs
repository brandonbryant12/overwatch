import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import { source } from "./observation-rig.mjs"
import { rig, T } from "./rig.mjs"

for (const overall_state of ["Unknown", "No Data"]) {
  test(
    "a provider reporting " + overall_state + " alongside OK cannot certify a quiet environment",
    async (t) => {
      const x = await source(t, "dd", ["monitors"], {
        monitors: [
          { id: 1, name: "Old replica", overall_state: "OK" },
          { id: 2, name: "New replica", overall_state },
        ],
      })
      const status = await x.status()
      assert.notEqual(status.environments[0].health, "quiet", JSON.stringify(status.environments[0].readings))
    },
  )
}

test("metric dated half a second past the requested end cannot certify quiet", async (t) => {
  const x = await source(t, "dd", ["metrics"], { ddPointTime: T + 500 })
  const status = await x.status()
  assert.notEqual(status.environments[0].health, "quiet", JSON.stringify(status.environments[0].readings))
})

test("uninstall keeps the plist when the service manager itself is unavailable", async (t) => {
  const x = await rig(t)
  x.cfg.mcpToken = "keychain:overwatch/mcp-token"
  x.save()
  const plist = x.dir("home/Library/LaunchAgents/review.plist")
  x.env.OW_LAUNCHD_PLIST = plist
  const manager = x.dir("bin/test-launchctl")
  fs.writeFileSync(manager, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  x.env.OW_LAUNCHCTL = manager
  const installed = await x.cli("install")
  assert.equal(installed.code, 0, installed.err)
  assert.ok(fs.existsSync(plist))
  x.env.OW_LAUNCHCTL = x.dir("unavailable/launchctl")
  const removed = await x.cli("uninstall", [], { human: true })
  assert.deepEqual(
    { failed: removed.code !== 0, kept: fs.existsSync(plist) },
    { failed: true, kept: true },
    removed.out + removed.err,
  )
})
