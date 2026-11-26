import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fc from "fast-check"
import { rig, stamp, total, iso, T, capture } from "./rig.mjs"

test("independent SQLite writer and two services contend for one file in both directions", async (t) => {
  const x = await rig(t)
  await x.start()
  const target = x.dir("store/overwatch.db")
  // Independent predecessor stand-in. Uses no Overwatch source, discovery file or lock convention.
  // It attempts ownership as a contender, never reads product state as a test oracle.
  const contender =
    "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1]);try{d.exec('pragma busy_timeout=0; pragma locking_mode=exclusive; begin immediate; commit');console.log('owned');process.stdin.resume()}catch(e){console.error(e.message);process.exitCode=3}"
  for (const kind of fc
    .sample(fc.constantFrom("service", "independent"), { numRuns: 3 })
    .concat(["independent", "service"])) {
    const r =
      kind === "service"
        ? await x.cli("serve")
        : await capture(process.execPath, ["--input-type=module", "-e", contender, target], { timeout: 2000 })
    assert.equal(r.code, 3, r.out + r.err)
  }
  assert.equal((await x.json("status")).live, true)
  await x.stop("SIGKILL")
  const c = spawn(process.execPath, ["--input-type=module", "-e", contender, target], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  t.after(() => c.kill("SIGKILL"))
  assert.match(String((await once(c.stdout, "data"))[0]), /owned/)
  assert.equal((await x.cli("serve")).code, 3)
  assert.equal((await x.cli("status")).code, 3)
  const done = once(c, "close")
  c.kill("SIGKILL")
  await done
  await x.start()
  if (process.env.M1_OTHER_BIN)
    assert.equal((await x.cli("serve", [], { exe: process.env.M1_OTHER_BIN })).code, 3)
})
test("commit sequence orders deployments and incidents under a frozen wall clock", async (t) => {
  const x = await rig(t)
  await x.start()
  x.world({ lines: [[stamp, "ERROR first"]] })
  await x.poll()
  const s1 = await x.status()
  assert.ok(total(s1, "first"))
  await x.advance(60000, 0)
  const next = "a".repeat(40)
  x.world({
    revision: next,
    lines: [
      [stamp, "ERROR first"],
      [stamp, "ERROR second"],
    ],
  })
  await x.poll()
  const s2 = await x.status()
  assert.equal(s2.deploys.at(-1).revision, next)
  assert.equal(s2.deploys.at(-1).previous, x.git("rev-parse", "HEAD"))
  assert.ok(s2.deploys.at(-1).seq > s1.seq && s2.deploys.at(-1).seq <= s2.seq)
  assert.equal(total(s2, "second"), 1)
  await x.stop()
  x.inspect((db) => {
    const rows = db.prepare("select seq,kind,at_ms from events where seq<=? order by seq").all(s2.seq)
    assert.ok(rows.length >= 2)
    assert.ok(rows.some((r) => r.kind === "deploy" && r.seq === s2.deploys.at(-1).seq))
    assert.ok(rows.filter((r) => r.seq > s1.seq).every((r) => r.at_ms === T))
    assert.equal(new Set(rows.map((r) => r.seq)).size, rows.length)
  })
})

test(
  "kill after actual SQL writes, replay with an added occurrence",
  { timeout: process.env.M1_LONG ? 480000 : 120000 },
  async (t) => {
    async function setup() {
      const x = await rig(t, { both: true })
      const line = [stamp, "ERROR durable"]
      x.world({ lines: [line, line], ddLogs: [{ id: "dd-first", time: stamp, text: "ERROR external" }] })
      await x.start()
      return x
    }
    const base = await setup()
    await base.control("trace", { killAfter: null })
    const { writes } = await base.poll()
    assert.ok(Number.isInteger(writes) && writes >= 2)
    await base.stop()
    const points = process.env.M1_LONG
      ? Array.from({ length: writes }, (_, i) => i + 1)
      : [...new Set([1, Math.ceil(writes / 2), writes])]
    for (const cut of points) {
      const x = await setup()
      await x.control("trace", { killAfter: cut })
      const death = once(x.child, "close")
      await assert.rejects(x.poll(), /exited/)
      assert.equal((await death)[1], "SIGKILL")
      x.world({
        lines: [
          [stamp, "ERROR durable"],
          [stamp, "ERROR durable"],
          [iso(T - 2), "ERROR durable"],
        ],
        ddLogs: [...x.w().ddLogs, { id: "dd-late", time: iso(T - 3), text: "ERROR external" }],
      })
      await x.start()
      await x.advance(60000)
      await x.poll()
      const s = await x.status()
      assert.equal(total(s, "durable"), 3, "cut " + cut)
      assert.equal(total(s, "external"), 2, "cut " + cut)
      assert.ok(s.sources.every((src) => src.checkpointMs === x.now()))
      await x.stop()
    }
  },
)
function publicRows(db) {
  return Object.fromEntries(
    ["events", "incidents", "occurrences", "evidence", "findings"].map((k) => [
      k,
      db.prepare("select * from " + k + " order by 1").all(),
    ]),
  )
}
test("offline restore preserves history, next sequence, rows and old target on rejection", async (t) => {
  const x = await rig(t)
  await x.start()
  x.world({ lines: [[stamp, "ERROR saved"]] })
  await x.poll()
  const before = await x.status(),
    file = x.dir("backup.sqlite")
  const backup = await x.json("backup", ["--to", file])
  assert.equal(backup.seq, before.seq)
  assert.equal((await x.cli("restore", ["--from", file])).code, 3)
  await x.stop()
  const original = x.inspect((db) => {
    assert.equal(db.prepare("pragma application_id").get().application_id, 0x4f575432)
    assert.equal(db.prepare("pragma journal_mode").get().journal_mode, "wal")
    assert.equal(db.prepare("pragma user_version").get().user_version, 1)
    return publicRows(db)
  })
  await x.start()
  await x.advance(60000)
  x.world({ lines: [[iso(x.now() - 1), "ERROR after"]] })
  await x.poll()
  await x.stop()
  const changed = x.inspect(publicRows)
  const foreign = x.dir("foreign.sqlite")
  const f = new DatabaseSync(foreign)
  f.exec("create table ordinary(x)")
  f.close()
  for (const invalid of [foreign, x.dir("text")]) {
    if (invalid !== foreign) fs.writeFileSync(invalid, "fixture")
    assert.equal((await x.cli("restore", ["--from", invalid])).code, 5)
    assert.deepEqual(x.inspect(publicRows), changed)
  }
  await x.json("restore", ["--from", file])
  assert.deepEqual(x.inspect(publicRows), original)
  await x.start()
  let s = await x.status()
  for (const key of ["incidents", "jobs", "findings", "deploys", "sources", "seq"])
    assert.deepEqual(s[key], before[key], key)
  await x.advance(60000)
  await x.poll()
  s = await x.status()
  assert.ok(s.seq > backup.seq)
  assert.equal(total(s, "after"), 1)
})

test("future schema and impossible counts in a detached backup preserve the working database", async (t) => {
  const x = await rig(t)
  await x.start()
  x.world({ lines: [[stamp, "ERROR anchored"]] })
  await x.poll()
  const file = x.dir("good.sqlite")
  await x.json("backup", ["--to", file])
  await x.stop()
  const original = x.inspect(publicRows)
  for (const kind of ["version", "count"]) {
    const copy = x.dir(kind + ".sqlite")
    fs.copyFileSync(file, copy)
    const db = new DatabaseSync(copy)
    try {
      if (kind === "version") db.exec("pragma user_version=2147483647")
      else {
        // Synthetic corrupt input only. An incident total cannot be negative.
        db.exec("pragma ignore_check_constraints=on")
        db.prepare("update incidents set count=-1").run()
      }
    } finally {
      db.close()
    }
    assert.equal((await x.cli("restore", ["--from", copy])).code, 5)
    assert.deepEqual(x.inspect(publicRows), original)
  }
})
