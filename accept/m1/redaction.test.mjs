import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { DatabaseSync } from "node:sqlite"
import fc from "fast-check"
import { rig, stamp, trialRows } from "./rig.mjs"
import { expected, filing } from "./peers.mjs"

test(
  "generated secret forms through collection, identifiers, errors, model, finding, and restore",
  { timeout: 120000 },
  async (t) => {
    const x = await rig(t, { both: true })
    const suffixes = fc.sample(fc.hexaString({ minLength: 36, maxLength: 36 }), 8)
    const sentinels = suffixes.map((s, i) => (i % 2 ? "ghp_" + s : "sk-" + s))
    const [log, ddID, eventID, diagnostic, question, agent, field, backupText] = sentinels
    const suffix = fc.sample(fc.integer({ min: 111111, max: 999999 }), 1)[0]
    const secret = "TrainingOnly" + suffix
    const aws = "AKIA" + String(suffix).repeat(3).slice(0, 16)
    const jwt = ["eyJheader" + suffix, "eyJclaims" + suffix, "sigNature" + suffix].join(".")
    const slack = "xoxb-" + String(suffix).repeat(3)
    const shapes = [
      "Authorization: Bearer " + secret,
      "postgres://user:" + secret + "@fixture.invalid/shop",
      "Set-Cookie: session=" + secret,
      "-----BEGIN PRIVATE KEY-----\n" + secret + "\n-----END PRIVATE KEY-----",
      '{"client_secret":"' + secret + '"}',
      aws,
      jwt,
      slack,
    ]
    sentinels.push(secret, aws, jwt, slack, "ghp_" + suffixes[5])
    x.world({
      modelCursor: "ghp_" + suffixes[5],
      modelAnswer: "password=" + secret,
      lines: [[stamp, "ERROR payment token=" + log]],
      ddLogs: [{ time: stamp, id: ddID, text: "ERROR ledger api_key=" + log }],
      events: [
        {
          metadata: { uid: eventID },
          type: "Warning",
          reason: "BackOff",
          message: "ERROR payment token=" + log,
          count: 1,
          lastTimestamp: stamp,
        },
      ],
    })
    await x.start()
    await x.poll()
    const captured = []
    x.p.script = async ({ id, tool }) => {
      const v = await tool("ow_telemetry", { source: "pods", query: "api_key=" + question })
      captured.push(v)
      const e = await tool("ow_telemetry", { source: "pods" })
      captured.push(e)
      const body = filing(expected[id], [e.pieces[0].handle], "token=" + agent)
      body.ruled_out = ["password=" + field, ...shapes]
      body.impact = shapes[0]
      body.affected = shapes.slice(1)
      body.not_checked = shapes
      body.status = shapes[2]
      body.next_check = shapes[4]
      body.claims[0].statement = "api_key=" + agent
      const result = await tool("ow_finding", body)
      captured.push(result)
      return "filed"
    }
    await x.json("trial", [], 0, { timeout: 90000 })
    assert.deepEqual(x.p.errors, [])
    x.world({ kubeFailure: "Forbidden: token=" + diagnostic })
    await x.advance(60000)
    await x.poll()
    const s = await x.status()
    assert.ok(s.incidents.length)
    assert.ok(trialRows(s).findings.length)
    const messages = [
      JSON.stringify(captured),
      JSON.stringify(s),
      x.logs.join(""),
      JSON.stringify(x.p.deliveries),
      JSON.stringify(x.p.requests.filter((r) => r.path.includes("/session")).map((r) => r.body)),
    ]
    const backup = x.dir("safe.sqlite")
    await x.json("backup", ["--to", backup])
    await x.stop()
    function assertClean(data) {
      for (const forbidden of sentinels)
        assert.ok(!data.includes(forbidden), "unredacted fixture at observation boundary")
    }
    for (const data of messages) assertClean(data)
    for (const f of [
      backup,
      ...fs
        .readdirSync(x.dir("store"))
        .filter((n) => n.startsWith("overwatch.db"))
        .map((n) => x.dir("store/" + n)),
    ])
      assertClean(fs.readFileSync(f).toString("latin1"))
    x.inspect((db) => {
      const tables = db.prepare("select name from sqlite_schema where type='table'").all()
      const selects = tables.map(({ name }) => {
        const quoted = '"' + name.replaceAll('"', '""') + '"'
        return db.prepare("select * from " + quoted)
      })
      // Keep the statements reachable until their iterators have finished on Node 23.11.
      for (const select of selects) {
        for (const row of select.iterate())
          assertClean(JSON.stringify(row, (_, v) => (typeof v === "bigint" ? String(v) : v)))
      }
    })
    // Only the detached input copy is opened writable. The service database stays read-only to observers.
    const f = new DatabaseSync(backup)
    f.prepare("update incidents set title=?").run("password=" + backupText)
    f.close()
    const r = await x.cli("restore", ["--from", backup])
    assert.ok([0, 5].includes(r.code), r.err)
    if (r.code === 0) assertClean(JSON.stringify(await x.json("status")))
    assertClean(fs.readFileSync(x.dir("store/overwatch.db")).toString("latin1"))
  },
)
