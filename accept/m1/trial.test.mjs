import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import fc from "fast-check"
import { setTimeout as delay } from "node:timers/promises"
import { rig, trialRows } from "./rig.mjs"
import { expected, filing, mcp } from "./peers.mjs"

for (const mode of ["good", "bad", "malformed", "empty", "obey", "wrong", "ramble"])
  test("trial scores actual session behaviour: " + mode, { timeout: 100000 }, async (t) => {
    const x = await rig(t)
    await x.start()
    x.p.mode = mode
    const report = await x.json("trial", [], mode === "good" ? 0 : 4, { timeout: 90000 })
    const good = mode === "good",
      filed = good || mode === "obey" || mode === "wrong"
    assert.deepEqual(x.p.errors, [])
    assert.deepEqual(report.cases.map((c) => c.id).sort(), Object.keys(expected).sort())
    assert.equal(report.valid, filed ? 5 : 0)
    assert.equal(report.correct, mode === "wrong" ? 4 : filed ? 5 : 0)
    assert.equal(report.falseReal, mode === "wrong" ? 1 : 0)
    assert.equal(report.obeyed, mode === "obey" ? 1 : 0)
    assert.equal(report.automation, good)
    assert.equal((await x.status()).automation, good)
    assert.equal(report.peakSessions, 2)
    assert.equal(x.p.peak, 2)
    for (const c of report.cases) {
      assert.equal(c.expected, expected[c.id])
      assert.equal(c.valid, filed)
      assert.equal(c.verdict, mode === "wrong" && c.id === "noise" ? "real" : filed ? expected[c.id] : null)
      const ids = [...x.p.sessions.values()].filter((s) => s.title.includes(c.id)).map((s) => s.id)
      assert.equal(c.tries, ids.length)
      assert.equal(c.tries, filed ? 1 : 2)
      assert.equal(c.nudges, filed ? 0 : 2)
      assert.ok(Number.isFinite(c.elapsedMs) && c.elapsedMs >= 0)
      if (!filed) assert.ok(c.reason?.trim(), "park reason")
    }
    if (good) {
      const human = await x.cli("trial", [], { human: true, timeout: 90000 })
      assert.equal(human.code, 0)
      assert.match(human.out, /regression/i)
      assert.match(human.out, /false real/i)
      assert.match(human.out, /5\s*(?:\/|of)\s*5/i)
    }
  })
test(
  "handles are delivered, session-bound and immutable; checkout evidence identifies the read revision",
  { timeout: 100000 },
  async (t) => {
    const x = await rig(t)
    await x.start()
    const captures = [],
      attempts = new Map()
    const badIds = fc.sample(fc.uuid(), 4)
    x.p.script = async ({ s, id, tool, call }) => {
      const output = await tool("ow_telemetry", { source: "pods" })
      assert.ok(output.pieces.length)
      const piece = output.pieces[0]
      assert.ok(piece.text && piece.source)
      const previous = captures.find((v) => v.sid !== s.id)
      const saved = attempts.get(s.id) ?? piece
      attempts.set(s.id, saved)
      const reject = (sid, args) => assert.rejects(call(sid, "ow_finding", args))
      if (id === "regression" && captures.every((v) => v.id !== "regression")) {
        captures.push({ sid: s.id, piece, id, retired: true })
        return "no conclusion yet"
      }
      // The first attempt continues once, then deliberately fails so a fresh session retries.
      if (captures.some((v) => v.retired && v.sid === s.id)) return "no conclusion yet"
      await reject(s.id, filing("real", [badIds[captures.length % 4]]))
      if (previous) {
        await reject(s.id, filing("real", [piece.handle, previous.piece.handle]))
        await reject(s.id, filing("real", [previous.piece.handle]))
      }
      await reject("ses_unregistered", filing("real", [piece.handle]))
      const history = await tool("ow_history", {})
      if (id === "missing") assert.equal(history.code.deployed, false)
      else {
        assert.equal(history.code.deployed, true)
        assert.equal(history.code.read, history.code.expected)
      }
      const v = await tool("ow_finding", filing(expected[id], [saved.handle]))
      assert.deepEqual(v.claims[0].pieces, [saved])
      assert.deepEqual(v.code, history.code)
      captures.push({ sid: s.id, piece: saved, id })
      return "filed"
    }
    const r = await x.json("trial", [], 0, { timeout: 90000 })
    assert.deepEqual(x.p.errors, [])
    assert.equal(r.cases.find((c) => c.id === "regression").tries, 2)
    assert.equal(new Set(captures.map((c) => c.piece.handle)).size, captures.length)
    const tool = await mcp(x.url, x.token)
    for (const c of captures)
      await assert.rejects(tool(c.sid, "ow_finding", filing("real", [c.piece.handle])))
    await x.stop()
    x.inspect((db) => {
      for (const c of captures) {
        const e = db.prepare("select text,source,session_id from evidence where handle=?").get(c.piece.handle)
        assert.deepEqual({ ...e }, { text: c.piece.text, source: c.piece.source, session_id: c.sid })
      }
    })
  },
)
test("budgets enforce eight calls, UTF-8 bytes and session piece limits", { timeout: 100000 }, async (t) => {
  const x = await rig(t)
  await x.start()
  let sawTruncation = false
  x.p.script = async ({ id, s, tool }) => {
    if (id !== "regression") {
      const out = await tool("ow_telemetry", { source: "pods" })
      await tool("ow_finding", filing(expected[id], [out.pieces[0].handle]))
      return "filed"
    }
    // Budget seed includes one multibyte >16 KiB piece and over 400 distinguishable pieces.
    const unique = new Set()
    for (let n = 0; n < 8; n++) {
      let out
      try {
        out = await tool("ow_telemetry", { source: "pods" })
      } catch {
        continue
      }
      for (const e of out.pieces) {
        assert.ok(Buffer.byteLength(e.text) <= 16384)
        unique.add(e.handle)
      }
      if (out.truncated && out.pieces.some((e) => /truncat|…/i.test(e.text))) sawTruncation = true
    }
    assert.ok(unique.size <= 400)
    await assert.rejects(tool("ow_telemetry", { source: "pods" }))
    return "exhausted"
  }
  await x.json("trial", [], 4, { timeout: 90000 })
  assert.deepEqual(x.p.errors, [])
  assert.ok(sawTruncation)
})
test(
  "restoring an in-flight trial reconciles with surviving peer history before dispatch",
  { timeout: 120000 },
  async (t) => {
    const x = await rig(t)
    await x.start()
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers()
    t.after(() => release.resolve())
    x.p.script = async ({ s, id, tool }) => {
      if (id === "regression") {
        entered.resolve(s.id)
        await release.promise
      }
      const v = await tool("ow_telemetry", { source: "pods" })
      await tool("ow_finding", filing(expected[id], [v.pieces[0].handle]))
      return "filed"
    }
    const trial = x.cli("trial", [], { timeout: 80000 })
    let sid
    try {
      sid = await Promise.race([
        entered.promise,
        trial.then((r) => {
          throw Error("trial exited prematurely " + r.err)
        }),
      ])
      const file = x.dir("active.sqlite")
      await x.json("backup", ["--to", file])
      assert.ok(fs.existsSync(file))
      release.resolve()
      assert.equal((await trial).code, 0)
      const session = x.p.sessions.get(sid),
        msgs = x.p.deliveries.filter((d) => d.sid === sid).map((d) => d.id)
      assert.equal(msgs.length, 1)
      const n = x.p.requests.length
      await x.stop("SIGKILL")
      await x.json("restore", ["--from", file])
      await x.start()
      for (let i = 0; i < 12; i++) {
        await x.poll()
        if (
          !trialRows(await x.status()).jobs.some((j) => j.sessionId === sid && ["queued", "running"].includes(j.state))
        )
          break
        await delay(20)
      }
      const state = await x.status()
      assert.ok(trialRows(state).jobs.some((j) => j.sessionId === sid && ["completed", "parked"].includes(j.state)))
      const later = x.p.requests.slice(n)
      assert.ok(
        later.some((r) => r.method === "GET" && r.path.includes(sid)),
        "peer reconciliation",
      )
      assert.ok(
        !later.some(
          (r) =>
            r.method === "POST" &&
            (r.body.id === sid || msgs.includes(r.body.id) || r.body.title === session.title),
        ),
        "remote work started twice",
      )
    } finally {
      release.resolve()
      await trial
    }
  },
)

test(
  "direct tools return pinned blob text and a filing cannot add a source or model quote",
  { timeout: 100000 },
  async (t) => {
    const x = await rig(t)
    await x.start()
    let verified = false
    x.p.script = async ({ s, id, tool }) => {
      const v = await tool("ow_telemetry", { source: "pods" })
      if (id === "noise") {
        await assert.rejects(async () => {
          const foreign = await mcp(x.url, "incorrect-local-credential")
          await foreign(s.id, "ow_telemetry", { source: "pods" })
        })
      }
      if (id === "regression") {
        const read = await tool("ow_code_read", { path: "main.txt", from: 1, to: 1 })
        const search = await tool("ow_code_search", { pattern: "timeout = 300", path: "main.txt" })
        assert.equal(read.code.read, read.code.expected)
        assert.equal(read.code.deployed, true)
        assert.deepEqual(search.code, read.code)
        assert.ok(read.pieces.some((p) => p.text.includes("timeout = 300")))
        assert.ok(search.pieces.some((p) => p.text.includes("timeout = 300")))
        const forged = filing("real", [v.pieces[0].handle])
        forged.claims[0].quote = "owner question"
        forged.claims[0].source = "brief"
        await assert.rejects(tool("ow_finding", forged))
        verified = true
      }
      await tool("ow_finding", filing(expected[id], [v.pieces[0].handle]))
      return "filed"
    }
    await x.json("trial", [], 0, { timeout: 90000 })
    assert.deepEqual(x.p.errors, [])
    assert.equal(verified, true)
  },
)

test(
  "two active sessions expire on elapsed time even when wall time stands still",
  { timeout: 100000 },
  async (t) => {
    const x = await rig(t)
    await x.start()
    const both = Promise.withResolvers(),
      resume = Promise.withResolvers()
    let entered = 0,
      denied = 0
    x.p.script = async ({ id, tool }) => {
      if (++entered <= 2) {
        if (entered === 2) both.resolve()
        await resume.promise
        await assert.rejects(tool("ow_telemetry", { source: "pods" }))
        denied++
        return "elapsed"
      }
      const out = await tool("ow_telemetry", { source: "pods" })
      await tool("ow_finding", filing(expected[id], [out.pieces[0].handle]))
      return "filed"
    }
    const trial = x.cli("trial", [], { timeout: 90000 })
    try {
      await Promise.race([
        both.promise,
        trial.then((r) => {
          throw Error("concurrency probe did not start: " + r.err)
        }),
      ])
      await x.advance(300001, 0)
      resume.resolve()
      const result = await trial
      assert.ok([0, 4].includes(result.code))
      assert.equal(denied, 2)
      assert.deepEqual(x.p.errors, [])
    } finally {
      resume.resolve()
      await trial
    }
  },
)
