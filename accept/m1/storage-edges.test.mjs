import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { DatabaseSync } from "node:sqlite"
import { rig, BIN, T, iso, stamp, total } from "./rig.mjs"

test("simultaneous first startup has exactly one ready owner", async t => {
  const x = await rig(t)
  const children = [BIN, process.env.M1_OTHER_BIN || BIN].map(bin =>
    spawn(bin, ["serve", "--json", "--config", x.dir("config.json")], {
      env: { ...x.env, OW_TEST_FD: "3" }, stdio: ["ignore", "pipe", "pipe", "pipe"],
    }))
  const ends = children.map(c => once(c, "close"))
  t.after(async () => { children.forEach(c => c.kill("SIGKILL")); await Promise.all(ends) })
  for (const c of children) c.stdio[3].on("error", () => {})
  const results = await Promise.all(children.map((c, i) => Promise.race([
    ends[i].then(([code]) => ({ code })),
    once(c.stdout, "data").then(([bytes]) => JSON.parse(bytes)),
  ])))
  // Busy diagnostics can arrive on stdout before close.
  assert.equal(results.filter(r => r.url).length, 1, JSON.stringify(results))
  const loser = results.findIndex(r => !r.url)
  assert.equal((await ends[loser])[0], 3)
})

async function saved(t) {
  const x = await rig(t)
  x.world({ lines: [[stamp, "ERROR saved"]] })
  await x.start()
  await x.poll()
  const file = x.dir("fixture.db")
  const saved = await x.json("backup", ["--to", file])
  await x.stop()
  return { x, file, saved }
}

test("an inconsistent incident sequence in a detached backup preserves the good target", async t => {
  const { x, file, saved: before } = await saved(t)
  const db = new DatabaseSync(file)
  db.prepare("update incidents set seq=?").run(before.seq + 1)
  db.close()
  const result = await x.cli("restore", ["--from", file])
  assert.equal(result.code, 5, result.out)
  assert.equal((await x.json("status")).seq, before.seq)
  assert.ok(x.inspect(d => d.prepare("select seq from incidents").get().seq) <= before.seq)
})

async function storageFixture(t, pageSize, mode) {
  const { x, file, saved: before } = await saved(t)
  const db = new DatabaseSync(file)
  db.exec("pragma journal_mode=delete")
  db.exec("pragma page_size=" + pageSize)
  db.exec("pragma auto_vacuum=" + mode)
  db.exec("vacuum")
  db.exec("create table padding(x blob); insert into padding values(zeroblob(25165824)); drop table padding")
  db.close()
  // Install a detached, closed compatible file as the starting database in a new owner's directory.
  const dir = x.dir("upgrade")
  fs.mkdirSync(dir)
  const target = dir + "/overwatch.db"
  fs.copyFileSync(file, target)
  x.cfg.dataDir = dir
  x.save()
  const size = () => fs.statSync(target).size
  const inspect = () => {
    const d = new DatabaseSync(target, { readOnly: true })
    try {
      return [d.prepare("pragma auto_vacuum").get().auto_vacuum, d.prepare("pragma freelist_count").get().freelist_count]
    } finally { d.close() }
  }
  return { x, size, inspect, before }
}

test("a legacy compatible file migrates to incremental vacuum on startup, preserving business state", async t => {
  const { x, inspect, before } = await storageFixture(t, 4096, "none")
  assert.equal(inspect()[0], 0)
  await x.start()
  assert.equal(total(await x.status(), "saved"), 1)
  assert.equal((await x.status()).seq, before.seq)
  await x.stop()
  assert.deepEqual(inspect(), [2, 0])
})

for (const page of [4096, 16384]) test("reclaim is positive and bounded to 16 MiB with page size " + page, async t => {
  const { x, size, inspect } = await storageFixture(t, page, "incremental")
  assert.ok(inspect()[1] * page > 16 * 1024 ** 2)
  const first = size()
  await x.start()
  await x.poll()
  await x.stop()
  const freed = first - size()
  assert.ok(freed > 0 && freed <= 16 * 1024 ** 2, "bytes reclaimed in one pass = " + freed)
  await x.start()
  await x.poll()
  await x.stop()
  assert.ok(first - size() >= freed)
  assert.ok(first - size() > freed || inspect()[1] === 0)
})

test("persistent pressure after compaction pauses growth and leaves the checkpoint alone", async t => {
  const x = await rig(t)
  await x.start()
  await x.poll()
  await x.advance(60_000)
  await x.control("space", { freeBytes: 2 ** 30, dbBytes: 2 ** 30 + 1 })
  x.world({ lines: [[iso(x.now() - 1), "ERROR new"]] })
  await x.poll()
  const s = await x.status()
  assert.deepEqual([s.paused, s.sources[0].checkpointMs, total(s, "new")], ["disk", T, 0])
})

test("restart after the wall clock moves backwards cannot postpone a probe beyond five elapsed minutes", async t => {
  const x = await rig(t)
  x.world({ kubeFailure: "network unreachable" })
  await x.start()
  await x.poll()
  await x.advance(0, -3600000)
  await x.stop()
  x.world({ kubeFailure: null })
  await x.start()
  await x.poll()
  await x.advance(300001, 0)
  await x.poll()
  assert.equal((await x.status()).sources[0].failure, null)
})

test("current version also yields when the compatible predecessor acquired ownership first",
  { skip: process.env.M1_OTHER_BIN ? false : "set M1_OTHER_BIN to a compatible checkout" }, async t => {
    const x = await rig(t)
    await x.start("serve", process.env.M1_OTHER_BIN)
    const contender = await x.cli("serve")
    assert.equal(contender.code, 3, contender.out)
    await x.stop("SIGKILL")
    await x.start()
    assert.equal((await x.status()).live, true)
  })
