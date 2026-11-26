import test from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { rig, iso, T } from "../m1/rig.mjs"
import { live, tick, api, item, act } from "./api.mjs"

const minute = 60000, day = 86400000
const issue = async x => (await x.status()).incidents[0].id

test("P01 frozen-wall replay cannot make three complete event-time intervals", async t => {
  const x = await live(t), id = await issue(x)
  for (let i = 0; i < 3; i++) await tick(x, [], minute, 0)
  assert.equal((await item(x, id)).incident.active, true)
})
test("P02 catch-up breaks the streak toward Quiet", async t => {
  const x = await live(t), id = await issue(x)
  await tick(x); await tick(x); await tick(x, [], 6 * 3600000); await tick(x)
  assert.equal((await item(x, id)).incident.active, true)
})
test("P03 Done grace after restart is bounded even when no new arrival previously checked it", async t => {
  const x = await live(t), id = await issue(x)
  await act(x, id, { action: "done" })
  await x.advance(0, -minute); await x.stop(); await x.start()
  await x.poll()
  // kubectl serves each instance in timestamp order, even with the wall set back.
  x.world({ lines: [[iso(x.now() - 1), "ERROR payments"], ...x.w().lines] })
  await x.advance(minute + 1, 0); await x.poll()
  const row = (await item(x, id)).incident
  assert.equal(row.count, 2, "the post-restart occurrence must have been admitted")
  assert.equal(row.returned?.code, "again")
})
test("P04 a returned Later fence cannot be undone by a stale tab after restart", async t => {
  const x = await live(t), id = await issue(x)
  const r = await act(x, id, { action: "later", untilMs: T + minute })
  await x.advance(0, -minute); await x.stop(); await x.start(); await x.poll()
  await tick(x, [], minute, 0); await tick(x, [], minute, 0)
  const d = await item(x, id), returned = d.incident.returned
  assert.equal(returned.code, "deadline")
  assert.ok(r.action.seq < returned.causeSeq && returned.causeSeq < returned.seq)
  assert.equal(d.history.filter(e => e.kind === "returned").length, 1)
  await act(x, id, { action: "undo", actionSeq: r.action.seq }, { code: 409 })
})
test("P05 disposition named by the action event has the same seq as the committed disposition", async t => {
  const x = await live(t), id = await issue(x)
  await act(x, id, { action: "never" })
  const d = await item(x, id), e = d.history.find(e => e.kind === "action")
  assert.equal(e.data.way.seq, d.incident.way.seq)
})
test("P06 rate comparison needs an exact baseline after an observed loss", async t => {
  const x = await live(t, ["ERROR payments", "ERROR payments"]), id = await issue(x)
  x.world({ lines: x.w().lines.slice(1) })
  await tick(x)
  assert.equal((await item(x, id)).incident.exact, false)
  await act(x, id, { action: "later", when: "worse" })
  await tick(x, Array(5).fill("ERROR payments"))
  assert.equal((await item(x, id)).incident.way?.kind, "later")
})
test("P07 hourly replay and catch-up use source time and the thirty-day retention horizon", async t => {
  const x = await rig(t, { both: true }), src = x.cfg.apps.shop.environments.prod.sources
  delete src.pods; src.dd.readings = ["logs"]; x.save()
  const log = (id, at) => ({ id, time: iso(at), text: "ERROR payments" })
  x.world({ ddLogs: [log("old", T - 1)] }); await x.start(); await x.poll()
  await x.advance(31 * day)
  const last = x.now() - 3600001
  x.world({ ddLogs: [...x.w().ddLogs, log("later", last)] }); await x.poll()
  await x.advance(minute); await x.poll(); await x.stop()
  const rows = x.inspect(db => db.prepare("select hour,count from hourly order by hour").all().map(r => [r.hour, r.count]))
  assert.deepEqual(rows, [[Math.floor(last / 3600000), 1]])
})
test("P08 case-insensitive search finds retained non-ASCII text", async t => {
  const x = await live(t, ["ERROR CAFÉ"]), id = await issue(x)
  assert.deepEqual((await api(x, "search?q=" + encodeURIComponent("café"))).items.map(r => r.id), [id])
})
test("P09 uncited real evidence leaves search by age while cited evidence remains", async t => {
  const x = await rig(t); await x.start("demo")
  const file = x.dir("older.db"); await api(x, "backup", { file }); await x.stop()
  const db = new DatabaseSync(file)
  try {
    db.prepare("update runs set started_ms=?").run(T - day)
    db.prepare("insert into evidence select ?,run_id,session_id,source,?,ordinal+1 from evidence limit 1")
      .run("e_0123456789abcdef0123456789", "ephemeral-canary")
  } finally { db.close() }
  await x.json("restore", ["--from", file]); await x.start()
  const hits = async q => (await api(x, "search?q=" + q)).items.length
  assert.equal(await hits("ephemeral-canary"), 1)
  await x.advance(15 * day); await x.poll()
  assert.equal(await hits("logged%20daily"), 1)
  assert.equal(await hits("ephemeral-canary"), 0)
})
test("P10 duplicate prompt delivery stays singular and redacted in history, search and outbound traffic", async t => {
  const x = await live(t), id = await issue(x)
  const { requestKey: key } = await api(x, "focus?subject=" + id)
  const secret = "violet-canary-4587"
  const payload = { subject: id, text: "Review password=" + secret, mode: "auto" }
  const [first, second] = await Promise.all([api(x, "ask", payload, { key }), api(x, "ask", payload, { key })])
  assert.deepEqual(first, second)
  const result = await item(x, id)
  assert.equal(result.history.filter(e => e.kind === "asked").length, 1)
  assert.equal((await api(x, "search?q=" + secret)).items.length, 0)
  assert.ok(!JSON.stringify([result, await x.status(), x.p.requests]).includes(secret))
  await x.stop()
  x.inspect(db => {
    for (const { name } of db.prepare("select name from sqlite_master where type='table'").all()) {
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()).includes(secret), name)
    }
  })
})

test("P21 an old result can be reached when a literal query matches more than fifty subjects", async t => {
  const labels = Array.from({ length: 51 }, (_, n) => "ERROR retry " + String.fromCharCode(97 + Math.floor(n / 26), 97 + n % 26))
  const x = await live(t, labels)
  const all = new Set((await x.status()).incidents.map(i => i.id))
  assert.equal(all.size, 51)
  const hits = new Set(), cursors = new Set()
  let cursor = null
  do {
    const page = await api(x, "search?q=retry" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""))
    for (const i of page.items) { assert.ok(!hits.has(i.id)); hits.add(i.id) }
    cursor = page.nextCursor
    if (cursor) { assert.ok(!cursors.has(cursor)); cursors.add(cursor) }
  } while (cursor)
  assert.equal(hits.size, all.size)
})
test("P22 service admission after grace returns old event time and ignores repeated seen at its fence", async t => {
  const x = await live(t), id = await issue(x)
  const through = (await x.status()).seq
  await act(x, id, { action: "seen", throughSeq: through })
  await act(x, id, { action: "done" })
  const before = (await x.status()).seq
  await act(x, id, { action: "seen", throughSeq: through })
  assert.equal((await x.status()).seq, before)
  await x.stop(); await x.start()
  x.world({ lines: [...x.w().lines, [iso(T - 1), "ERROR payments"]] })
  await x.advance(minute + 1); await x.poll()
  const r = (await item(x, id)).incident
  assert.deepEqual([r.count, r.returned?.code], [2, "again"])
})
