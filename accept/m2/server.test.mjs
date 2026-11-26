import test from "node:test"
import assert from "node:assert/strict"
import { rig } from "../m1/rig.mjs"
import { expected, filing } from "../m1/peers.mjs"
import { api, act, inbox, item, ids, live, tick } from "./api.mjs"

test("demo groups, strip, historical search and independent renewal", async t => {
  const x = await rig(t)
  await x.start("demo")
  const g = await inbox(x)
  assert.deepEqual(Object.keys(g.groups).sort(), ["needsYou", "new", "quiet", "working"])
  for (const rows of Object.values(g.groups)) assert.ok(rows.length)
  assert.equal(ids(g).length, new Set(ids(g)).size)
  assert.deepEqual((await x.status()).inbox, g)
  const start = performance.now()
  const found = await api(x, "search?q=search%20index%20rebuild")
  assert.ok(performance.now() - start < 2000)
  const id = found.items.find(row => /search index rebuild/i.test(row.title)).id
  assert.equal((await item(x, id)).incident.way.kind, "done")
  assert.ok(!ids(g).includes(id))
  const needs = await Promise.all(g.groups.needsYou.map(id => item(x, id)))
  assert.ok(needs.some(d => /checkout.*timeout/i.test(d.incident.title)))
  const arrivals = await Promise.all(g.groups.new.map(id => item(x, id)))
  const warmup = arrivals.find(d => /cache warm-up/i.test(d.incident.title))
  assert.ok(warmup, "staging demo return")
  assert.equal(warmup.incident.returned.code, "finding")
  const returned = warmup.history.find(e => e.seq === warmup.incident.returned.seq && e.kind === "returned")
  const action = warmup.history.find(e => e.seq === returned.data.actionSeq && e.kind === "action")
  const finding = warmup.history.find(e => e.seq === returned.data.causeSeq && e.kind === "finding")
  assert.ok(action && finding && action.seq < finding.seq && finding.seq < returned.seq)
  assert.equal(action.data.action, "later")
  assert.ok(warmup.findings.length)
  assert.ok(warmup.incident.returned.reason.length)
  await x.control("clock", { nowMs: Date.now() + 86_400_000, monoMs: 86_400_000 })
  await x.poll()
  const s = await x.status()
  const strip = Object.fromEntries(s.environments.map(e => [e.environment, e.health]))
  assert.deepEqual(strip, { production: "attention", staging: "quiet", qa: "signed_out" })
  assert.equal(x.calls().length + x.p.requests.length, 0)
})

for (const action of ["done", "later", "never"]) test(action + " is searchable and undoable after restart", async t => {
  const x = await live(t)
  const g = await inbox(x), id = g.groups.needsYou[0]
  assert.ok(id)
  const changed = await act(x, id, { action })
  assert.ok(changed.seq > g.seq && !ids(changed.inbox).includes(id))
  const actionSeq = (await item(x, id)).incident.way.seq
  await x.stop()
  await x.start()
  assert.ok((await api(x, "search?q=PAYMENTS")).items.some(row => row.id === id))
  assert.equal((await item(x, id)).incident.way.kind, action)
  await act(x, id, { action: "undo", actionSeq })
  const detail = await item(x, id)
  assert.equal(detail.incident.way, null)
  assert.equal(detail.incident.count, 1)
  assert.equal(detail.incident.group, "needsYou")
  assert.ok(detail.history.some(e => e.kind === "action" && e.data.action === "undo" && e.data.actionSeq === actionSeq))
  await act(x, id, { action: "undo", actionSeq }, { code: 409 })
})

test("Done admits a new event after grace; replay and the grace window stay hidden", async t => {
  const x = await live(t)
  const id = (await inbox(x)).groups.needsYou[0]
  await act(x, id, { action: "done" })
  await tick(x, ["ERROR payments"])
  assert.equal((await item(x, id)).incident.way.kind, "done")
  await tick(x, ["ERROR payments"])
  const row = (await item(x, id)).incident
  assert.equal(row.count, 3)
  assert.deepEqual([row.way, row.returned.code], [null, "again"])
  assert.match(row.returned.reason, /again|since/i)
})

test("frozen wall: only a deploy committed after Later returns the item once", async t => {
  const x = await live(t)
  const id = (await inbox(x)).groups.needsYou[0]
  await act(x, id, { action: "later" })
  const seq = (await item(x, id)).incident.way.seq
  await tick(x, [], 60000, 0)
  assert.equal((await item(x, id)).incident.way.seq, seq)
  x.world({ revision: "b".repeat(40) })
  await tick(x, [], 60000, 0)
  await tick(x, [], 60000, 0)
  const d = await item(x, id)
  const trigger = (await x.status()).deploys.at(-1)
  assert.deepEqual([d.incident.way, d.incident.returned.code, d.incident.returned.causeSeq], [null, "deploy", trigger.seq])
  assert.ok(seq < trigger.seq && trigger.seq < d.incident.returned.seq)
  assert.equal(d.history.filter(e => e.kind === "returned").length, 1)
})

test("Later deadline returns exactly at its deadline without a new problem", async t => {
  const x = await live(t)
  const id = (await inbox(x)).groups.needsYou[0]
  await act(x, id, { action: "later", untilMs: x.now() + 60000 })
  await tick(x, [], 59999)
  assert.equal((await item(x, id)).incident.way.kind, "later")
  await tick(x, [], 1)
  assert.equal((await item(x, id)).incident.returned.code, "deadline")
})

for (const [action, n] of [["later", 5], ["never", 9]]) test(action + " returns at its worsening threshold", async t => {
  const x = await live(t)
  const id = (await inbox(x)).groups.needsYou[0]
  await act(x, id, { action, ...(action === "later" && { when: "worse" }) })
  x.world({ revision: "c".repeat(40) })
  await tick(x, Array(n - 1).fill("ERROR payments"))
  assert.equal((await item(x, id)).incident.way.kind, action)
  await tick(x, ["ERROR payments"])
  const row = (await item(x, id)).incident
  assert.deepEqual([row.way, row.returned.code], [null, "worse"])
  assert.ok(row.returned.reason.length)
})

test("automatic quiet needs three consecutive measured intervals; recurrence explains the return", async t => {
  const x = await live(t)
  const id = (await inbox(x)).groups.needsYou[0]
  await tick(x)
  await tick(x)
  x.world({ kubeFailure: "network unreachable" })
  await tick(x)
  x.world({ kubeFailure: null })
  await tick(x)
  await tick(x)
  assert.notEqual((await item(x, id)).incident.group, "quiet")
  await tick(x)
  assert.equal((await item(x, id)).incident.group, "quiet")
  assert.equal((await x.status()).environments[0].health, "quiet")
  await tick(x, ["ERROR payments"])
  const d = await item(x, id)
  assert.deepEqual([d.incident.count, d.incident.returned.code, d.incident.group], [2, "recurred", "needsYou"])
})

test("seen is a monotone shared fence across clients and restart", async t => {
  const x = await live(t)
  const g = await inbox(x), id = g.groups.needsYou[0]
  await act(x, id, { action: "seen", throughSeq: g.seq })
  await tick(x, ["ERROR payments"])
  const now = (await x.status()).seq
  const updated = await act(x, id, { action: "seen", throughSeq: now })
  const stale = await act(x, id, { action: "seen", throughSeq: g.seq })
  assert.equal(updated.seq, stale.seq)
  await x.stop()
  await x.start()
  assert.equal((await item(x, id)).incident.seenSeq, now)
})

test("one bar previews and durably deduplicates a prompt in focus", async t => {
  const x = await live(t)
  const id = (await inbox(x)).groups.needsYou[0]
  const focus = () => api(x, "focus?subject=" + encodeURIComponent(id))
  const preview = await focus(), opts = { key: preview.requestKey }
  const prompt = { subject: id, text: "Why did payments fail?", mode: "auto" }
  assert.equal(preview.promptTarget.mode, "new")
  await api(x, "ask", { ...prompt, mode: "continue" }, { key: (await focus()).requestKey, code: 409 })
  const result = await api(x, "ask", prompt, opts)
  assert.deepEqual(result.target, { subject: id, mode: "new", jobId: result.jobId })
  await x.stop()
  await x.start()
  assert.deepEqual(await api(x, "ask", prompt, opts), result)
  await api(x, "ask", { ...prompt, text: "different" }, { ...opts, code: 409 })
  assert.equal((await focus()).promptTarget.jobId, result.jobId)
  assert.equal((await api(x, "ask", { ...prompt, mode: "continue" }, { key: (await focus()).requestKey })).jobId, result.jobId)
  assert.notEqual((await api(x, "ask", { ...prompt, mode: "new" }, { key: (await focus()).requestKey })).jobId, result.jobId)
  assert.ok((await inbox(x)).groups.working.includes(id))
})

test("all default error words and only those words affect log health; warnings remain searchable", async t => {
  const x = await live(t, ["WARN ordinary", "INFO panicroom", "INFO emergency contact updated"])
  assert.equal((await x.status()).environments[0].health, "quiet")
  assert.equal((await api(x, "search?q=ordinary")).items.length, 1)
  await tick(x, ["error one", "FATAL two", "Panic three", "exception four", "critical five"])
  const s = await x.status()
  assert.equal(s.incidents.filter(i => i.severity === "error").length, 5)
  assert.equal(s.environments[0].health, "attention")
})

test("pattern overrides apply only to their app", async t => {
  const x = await rig(t)
  x.cfg.apps.other = structuredClone(x.cfg.apps.shop)
  x.cfg.apps.shop.problemPatterns = { error: ["broken"], warn: [] }
  x.cfg.watchers.push({ ...x.cfg.watchers[0], app: "other" })
  x.save()
  const checked = await x.cli("check")
  assert.equal(checked.code, 0, checked.out)
  await x.start()
  await tick(x, ["BROKEN fixture", "WARN ordinary"])
  const s = await x.status()
  assert.deepEqual(s.environments.map(e => e.health).sort(), ["attention", "quiet"])
  assert.ok(s.incidents.some(i => i.app === "shop" && i.severity === "error"))
  assert.ok(s.incidents.some(i => i.app === "other" && i.severity === "warn"))
})

test("trial namespaces are disjoint and excluded from real work", async t => {
  const x = await live(t)
  await x.json("trial")
  const s = await x.status()
  assert.deepEqual(s.jobs, [])
  assert.deepEqual(s.findings, [])
  assert.equal(s.trial.jobs.length, 5)
  assert.equal(s.trial.findings.length, 5)
  const cli = await x.json("status")
  assert.deepEqual(cli.jobs, [])
  assert.deepEqual(cli.trial.jobs, s.trial.jobs)
  assert.equal((await api(x, "search?q=Overwatch%20trial")).items.length, 0)
  const id = (await inbox(x)).groups.needsYou[0]
  await act(x, id, { action: "later" })
  await x.json("trial")
  assert.equal((await item(x, id)).incident.way.kind, "later", "unrelated trial filings cannot return real work")
})

test("telemetry pages resume deterministically without duplicate handles and leave a call for filing", async t => {
  const x = await rig(t)
  await x.start()
  let checked = false
  x.p.script = async ({ id, tool }) => {
    const args = { source: "pods" }, first = await tool("ow_telemetry", args)
    if (id === "regression") {
      assert.equal(first.pieces.length, 50)
      assert.equal(typeof first.nextCursor, "string")
      const next = { ...args, cursor: first.nextCursor }
      const second = await tool("ow_telemetry", next)
      assert.equal(second.pieces.length, 50)
      assert.equal(new Set([...first.pieces, ...second.pieces].map(p => p.handle)).size, 100)
      assert.deepEqual(await tool("ow_telemetry", next), second)
      checked = true
    } else assert.equal(first.nextCursor, null)
    await tool("ow_finding", filing(expected[id], [first.pieces[0].handle]))
    return "filed"
  }
  const result = await x.cli("trial")
  assert.deepEqual(x.p.errors, [])
  assert.equal(result.code, 0)
  assert.ok(checked)
})

for (const way of ["later", "never"]) test("severity rise returns " + way + " on the same Datadog monitor", async t => {
  const x = await rig(t, { both: true })
  const sources = x.cfg.apps.shop.environments.prod.sources
  delete sources.pods
  sources.dd.readings = ["monitors"]
  x.save()
  const monitor = { id: 17, name: "Payments latency", overall_state: "Warn" }
  x.world({ monitors: [monitor] })
  await x.start()
  await x.poll()
  const id = (await inbox(x)).groups.new[0]
  await act(x, id, { action: way })
  x.world({ monitors: [{ ...monitor, overall_state: "Alert" }] })
  await tick(x)
  const row = (await item(x, id)).incident
  assert.deepEqual([row.id, row.way, row.severity, row.returned.code], [id, null, "error", "severity"])
})

test("an unrelated environment's deploy cannot return a deferred production item", async t => {
  const x = await rig(t, { both: true })
  const prod = x.cfg.apps.shop.environments.prod.sources
  x.cfg.apps.shop.environments.staging = { sources: { pods: prod.pods } }
  delete prod.pods
  prod.dd.readings = ["logs"]
  x.cfg.watchers.push({ app: "shop", environment: "staging", every: "1m" })
  x.save()
  x.world({ ddLogs: [{ id: "payment", time: new Date(x.now() - 1).toISOString(), text: "ERROR checkout" }] })
  await x.start()
  await x.poll()
  const id = (await inbox(x)).groups.needsYou[0]
  await act(x, id, { action: "later" })
  x.world({ revision: "d".repeat(40) })
  await tick(x)
  const detail = await item(x, id)
  assert.ok((await x.status()).deploys.some(d => d.revision === "d".repeat(40) && d.environment === "staging"))
  assert.equal(detail.incident.way.kind, "later")
})

test("stale undo is fenced from a newer action on the same subject", async t => {
  const x = await live(t)
  const id = (await inbox(x)).groups.needsYou[0]
  await act(x, id, { action: "later" })
  const old = (await item(x, id)).incident.way.seq
  await act(x, id, { action: "undo", actionSeq: old })
  await act(x, id, { action: "never", reason: "expected" })
  await act(x, id, { action: "undo", actionSeq: old }, { code: 409 })
  const way = (await item(x, id)).incident.way
  assert.ok(way.seq > old)
  assert.deepEqual([way.kind, way.reason], ["never", "expected"])
})
