import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { rig } from "./rig.mjs"

test("uninstall cannot report the service stopped when its loaded job refused bootout", async (t) => {
  const x = await rig(t)
  x.cfg.mcpToken = "keychain:overwatch/mcp-token"
  x.save()
  const exe = x.dir("bin/private-launchctl"),
    plist = x.dir("home/Library/LaunchAgents/review.plist")
  fs.writeFileSync(
    exe,
    '#!/bin/sh\ncase "$1" in\nbootstrap) echo loaded > "$OW_FIXTURE/job";;\nbootout) if test -f "$OW_FIXTURE/job"; then echo "fixture permission denied" >&2; exit 1; fi;;\nprint) test -f "$OW_FIXTURE/job";;\nesac\n',
    { mode: 0o755 },
  )
  x.env.OW_LAUNCHCTL = exe
  x.env.OW_LAUNCHD_PLIST = plist
  const installed = await x.cli("install")
  assert.equal(installed.code, 0, installed.err)
  assert.ok(fs.existsSync(x.dir("job")))
  const removed = await x.cli("uninstall", [], { human: true })
  assert.notEqual(removed.code, 0, removed.out)
  assert.match(removed.err, /bootout|permission/i)
})
