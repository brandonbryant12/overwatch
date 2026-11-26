import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { rig } from "./rig.mjs"
const minute = 60000
async function source(t, kind, readings, patch) {
  const x = await rig(t, { both: true })
  const sources = x.cfg.apps.shop.environments.prod.sources
  delete sources[kind === "dd" ? "pods" : "dd"]
  sources[kind].readings = readings
  x.save()
  x.world(patch)
  await x.start()
  await x.poll()
  return x
}
async function step(x, patch = {}, elapsed = minute, wall = elapsed) {
  x.world(patch)
  await x.advance(elapsed, wall)
  await x.poll()
  return x.status()
}
async function restoreWith(x, sql) {
  const file = x.dir("detached.sqlite")
  const before = await x.json("backup", ["--to", file])
  await x.stop()
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: false })
  try {
    assert.ok(db.prepare(sql).run().changes > 0)
  } finally {
    db.close()
  }
  const r = await x.cli("restore", ["--from", file])
  assert.equal(r.code, 5, r.out)
  assert.equal((await x.json("status")).seq, before.seq)
}
export { source, step, restoreWith }
