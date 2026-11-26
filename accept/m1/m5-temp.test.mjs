import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { rig } from "./rig.mjs"

const dirs = (x) =>
  fs
    .readdirSync(x.dir("tmp"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
test("ordinary polling and shutdown leave no product scratch directory", async (t) => {
  const x = await rig(t)
  await x.start()
  for (let i = 0; i < 3; i++) {
    await x.advance(60000)
    await x.poll()
  }
  await x.stop()
  assert.deepEqual(dirs(x), [])
})
test("closing two demos releases both temporary data directories", async (t) => {
  const x = await rig(t)
  for (let i = 0; i < 2; i++) {
    await x.start("demo")
    await x.stop()
  }
  assert.deepEqual(
    dirs(x).filter((p) => p.startsWith("overwatch-demo-")),
    [],
  )
})
test("two completed investigation trials release both seed repositories", async (t) => {
  const x = await rig(t)
  await x.start()
  for (let i = 0; i < 2; i++) assert.equal((await x.json("trial")).valid, 5)
  await x.stop()
  assert.deepEqual(
    dirs(x).filter((p) => p.startsWith("overwatch-trial-")),
    [],
  )
})

test("the builder's fake launchd test releases its own temporary homes", async (t) => {
  const x = await rig(t)
  const { spawnSync } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const file = fileURLToPath(new URL("../../test/launchd.test.ts", import.meta.url))
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--test", "--test-concurrency=1", file],
    { env: x.env, encoding: "utf8" },
  )
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(
    dirs(x).filter((p) => p.startsWith("ow-launchd-")),
    [],
  )
})
