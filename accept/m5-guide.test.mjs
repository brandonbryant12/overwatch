import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import { rig } from "./m1/rig.mjs"

test("the notification runbook locates a live service with the supported default data directory", async (t) => {
  const x = await rig(t)
  delete x.cfg.dataDir
  x.save()
  await x.start()
  const doc = fs.readFileSync(new URL("../docs/owner-runbook.md", import.meta.url), "utf8")
  const line = doc.split("\n").find((line) => line.startsWith("OWURL=$("))
  assert.ok(line, "missing service discovery recipe")
  const result = spawnSync("/bin/zsh", ["-f", "-c", line + ' && print -r -- "$OWURL"'], {
    cwd: x.root,
    env: { ...x.env, OWCFG: x.dir("config.json") },
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), x.url, result.stderr)
})
