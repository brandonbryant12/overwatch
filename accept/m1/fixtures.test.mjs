import test from "node:test"
import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { rig, stamp, iso, T, capture } from "./rig.mjs"
import { mcp } from "./peers.mjs"

test("isolated kubectl preserves duplicate physical lines and emits an unterminated tail", async (t) => {
  const x = await rig(t, { baseline: false })
  x.world({
    restart: 2,
    lines: [
      [stamp, "ERROR repeat"],
      [stamp, "ERROR repeat"],
    ],
    tail: "partial",
  })
  const k = (args) => capture(x.dir("bin/kubectl"), args, { env: x.env })
  assert.equal(
    JSON.parse((await k(["get", "pods", "-o", "json"])).out).items[0].status.containerStatuses[0]
      .restartCount,
    2,
  )
  const result = await k(["logs", "shop-000", "--since-time=" + iso(T - 60000), "--timestamps"])
  assert.equal(result.code, 0)
  assert.equal(result.out, [stamp + " ERROR repeat", stamp + " ERROR repeat", "partial"].join("\n"))
  assert.equal(x.calls().length, 2)
})
test("Datadog filters by time and paginates, OpenCode deduplicates messages by supplied ID", async (t) => {
  const x = await rig(t, { baseline: false })
  const post = async (path, body) => {
    const r = await fetch(x.p.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    assert.equal(r.status, 200)
    return r.json()
  }
  x.world({ ddLogs: [1, 2, 3, 4].map((n) => ({ time: iso(T + n), id: String(n), text: "ERROR test" })) })
  const filter = { from: iso(T + 1), to: iso(T + 3) },
    url = "/api/v2/logs/events/search"
  const page = await post(url, { filter, page: {} })
  assert.deepEqual(
    page.data.map((d) => d.id),
    ["1", "2"],
  )
  const last = await post(url, { filter, page: { cursor: page.meta.page.after } })
  assert.deepEqual(
    last.data.map((d) => d.id),
    ["3"],
  )
  await post("/api/session", { id: "ses_fixture", title: "doctor", location: { directory: x.root } })
  for (let n = 0; n < 2; n++)
    await post("/api/session/ses_fixture/prompt", { id: "msg_one", text: "doctor turn" })
  assert.equal(x.p.deliveries.length, 1)
  assert.deepEqual(x.p.errors, [])
})
test("scripted remote MCP client negotiates and sends session metadata separately from the transport ID", async (t) => {
  const requests = []
  const s = createServer(async (req, res) => {
    let raw = ""
    for await (const b of req) raw += b
    const body = JSON.parse(raw)
    requests.push([body, req.headers])
    if (!Object.hasOwn(body, "id")) return res.writeHead(202).end()
    res.setHeader("mcp-session-id", "transport-A")
    if (body.method === "tools/call") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n')
      res.write(
        "data: " +
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: '{"pieces":[]}' }] },
          }) +
          "\n\n",
      )
      return
    }
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "initialize"
            ? { protocolVersion: "2025-03-26" }
            : { content: [{ type: "text", text: '{"pieces":[]}' }] },
      }),
    )
  })
  s.listen(0, "127.0.0.1")
  await once(s, "listening")
  t.after(() => {
    s.closeAllConnections()
    return new Promise((r) => s.close(r))
  })
  const call = await mcp("http://127.0.0.1:" + s.address().port, "local-fixture")
  assert.deepEqual(await call("ses-A", "ow_telemetry", { source: "pods" }), { pieces: [] })
  assert.deepEqual(
    requests.map(([b]) => b.method),
    ["initialize", "notifications/initialized", "tools/call"],
  )
  const [b, h] = requests[2]
  assert.equal(h["mcp-session-id"], "transport-A")
  assert.equal(h.authorization, "Bearer local-fixture")
  assert.deepEqual(b.params, {
    name: "ow_telemetry",
    arguments: { source: "pods" },
    _meta: { "ai.opencode/sessionID": "ses-A" },
  })
})
