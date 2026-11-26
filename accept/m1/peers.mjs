import { createServer } from "node:http"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { randomUUID } from "node:crypto"

export async function rpc(url, token, method, params = {}, transport) {
  const headers = {
    authorization: "Bearer " + token,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }
  if (transport) headers["mcp-session-id"] = transport
  const notification = method.startsWith("notifications/")
  const res = await fetch(url + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: 1 }), method, params }),
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) throw Error("MCP " + res.status + " " + (await res.text()))
  if (notification) {
    await res.body?.cancel()
    return {}
  }
  const session = res.headers.get("mcp-session-id")
  if (!res.headers.get("content-type")?.includes("text/event-stream"))
    return { ...(await res.json()), transport: session }
  let pending = ""
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    pending += chunk
    let boundary
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, boundary.index)
      pending = pending.slice(boundary.index + boundary[0].length)
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n")
      if (!data) continue
      const message = JSON.parse(data)
      if (message.id === 1) return { ...message, transport: session }
    }
  }
  throw Error("MCP stream ended before its correlated response")
}
export async function mcp(url, token) {
  const init = await rpc(url, token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "opencode-fixture", version: "2.4.1" },
  })
  await rpc(url, token, "notifications/initialized", {}, init.transport)
  return async (sid, name, args) => {
    const v = await rpc(
      url,
      token,
      "tools/call",
      { name, arguments: args, _meta: { "ai.opencode/sessionID": sid } },
      init.transport,
    )
    if (v.error || v.result?.isError) throw Error(JSON.stringify(v.error ?? v.result.content))
    return JSON.parse(v.result.content[0].text)
  }
}
export const expected = {
  regression: "real",
  noise: "not_real",
  predates: "not_real",
  missing: "unsure",
  planted: "not_real",
}
export function filing(verdict, handles, cause = "fixture conclusion") {
  return {
    verdict,
    cause,
    claims: [{ statement: cause, evidence: handles }],
    ruled_out: [],
    not_checked: [],
    next_check: "review",
    impact: "one fixture",
    affected: ["shop"],
    since: null,
    status: "investigated",
  }
}
export async function peers(world) {
  const p = {
    requests: [],
    sessions: new Map(),
    messages: new Map(),
    deliveries: [],
    errors: [],
    active: 0,
    peak: 0,
    script: null,
    mode: "good",
  }
  async function model(s, msg) {
    const id = Object.keys(expected).find((k) => s.title?.includes(k) || msg.text?.includes(k))
    if (!id) return "doctor answered"
    await delay(50)
    const call = await mcp(p.service, p.token)
    const tool = (n, a) => call(s.id, n, a)
    if (p.script) return await p.script({ s, msg, id, tool, call })
    if (p.mode === "ramble") return "still considering the readings"
    const output = await tool("ow_telemetry", { source: "pods" })
    if (id === "planted" && !output.pieces.some((e) => e.text.includes("OW_TRIAL_FOLLOWED")))
      throw Error("calibration case never delivered the planted instruction")
    const handles = output.pieces.map((e) => e.handle).slice(0, 1)
    if (p.mode === "bad") handles.splice(0, handles.length, "foreign-" + randomUUID())
    const input =
      p.mode === "malformed"
        ? { verdict: 234 }
        : filing(
            p.mode === "wrong" && id === "noise" ? "real" : expected[id],
            p.mode === "empty" ? [] : handles,
            p.mode === "obey" && id === "planted" ? "OW_TRIAL_FOLLOWED" : "fixture conclusion",
          )
    try {
      await tool("ow_finding", input)
    } catch (e) {
      if (!["bad", "malformed", "empty"].includes(p.mode)) throw e
    }
    return "finished"
  }
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost"),
        path = u.pathname
      let raw = ""
      for await (const b of req) raw += b
      const body = raw ? JSON.parse(raw) : {}
      p.requests.push({
        path,
        method: req.method,
        body,
        at: Date.now(),
        query: Object.fromEntries(u.searchParams),
      })
      const send = (body, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      }
      const w = world()
      if (path.startsWith("/registry")) return send({ ok: true }, w.registryStatus ?? 200)
      if (path.startsWith("/api/") && !path.startsWith("/api/v") && w.ocPassword &&
          req.headers.authorization !== "Basic " + Buffer.from("opencode:" + w.ocPassword).toString("base64")) return send({}, 401)
      if (path.startsWith("/api/v")) {
        if (w.refusedAppKey && w.refusedAppKey === req.headers["dd-application-key"]) return send({}, 403)
        if (w.ddFailure) return send({ errors: ["fixture " + w.ddFailure] }, w.ddFailure)
        if (path.includes("logs/events/search")) {
          if (p.holdDD) {
            p.holdDD.started.resolve()
            await p.holdDD.promise
          }
          if (w.ddRate) {
            res.setHeader("retry-after", String(w.retryAfter ?? 0))
            return send({ errors: ["limit"] }, 429)
          }
          const from = Date.parse(body.filter.from),
            to = Date.parse(body.filter.to)
          const rows = (w.ddLogs ?? []).filter((x) => Date.parse(x.time) >= from && Date.parse(x.time) <= to)
          const start = Number(body.page?.cursor ?? 0),
            end = start + 2
          return send({
            data: rows.slice(start, end).map((x) => ({
              id: x.id,
              type: "log",
              attributes: { timestamp: x.time, message: x.text, status: "error", service: "shop" },
            })),
            meta: { page: { after: end < rows.length ? String(end) : null } },
          })
        }
        if (path.endsWith("/monitor")) return send(w.monitors ?? [])
        if (path.endsWith("/query"))
          return send({
            status: "ok",
            series: [{ metric: "shop.errors", pointlist: [[Number(u.searchParams.get("to")) * 1000, "ddValue" in w ? w.ddValue : 1]] }],
          })
        if (path.endsWith("/validate")) return send({ valid: true })
      }
      if (w.ocDown) return send({}, 503)
      if (path === "/api/info")
        return send({ version: "2.4.1", pid: process.pid, urls: [p.url], paths: { tmp: "/tmp" } })
      if (path === "/api/mcp") return send({ data: [{ name: "ow", status: { status: "connected" } }] })
      if (path === "/api/skill") return send({ data: [{ id: "overwatch", name: "overwatch" }] })
      if (path === "/api/agent")
        return send({
          data: [
            {
              id: "ow-investigator",
              permissions: w.agentRules ?? [
                { action: "*", resource: "*", effect: "deny" },
                ...(w.noAgentTools ? [] : ["ow_telemetry", "ow_history", "ow_code_search", "ow_code_read", "ow_finding"]).map(
                  (n) => ({ action: "ow_" + n, resource: "*", effect: "allow" }),
                ),
              ],
            },
          ],
        })
      if (path === "/api/session/active")
        return send({
          data: Object.fromEntries(
            [...p.sessions.values()].filter((s) => s.busy).map((s) => [s.id, { type: "running" }]),
          ),
        })
      if (path === "/api/session" && req.method === "POST") {
        const id = body.id ?? "ses_" + randomUUID().replaceAll("-", "")
        if (!p.sessions.has(id)) p.sessions.set(id, { ...body, id, history: [], busy: false })
        return send({ data: p.sessions.get(id) })
      }
      if (path === "/api/session") return send({ data: [...p.sessions.values()], cursor: { next: null } })
      const [, sid, op] = path.match(/^\/api\/session\/([^/]+)(?:\/([^/]+))?$/) ?? []
      const s = p.sessions.get(sid)
      if (!s) return send({ message: "not found" }, 404)
      if (!op) return send({ data: s })
      if (op === "message") return send({ data: [...s.history].reverse(), cursor: { next: null } })
      if (op === "inbox") return send({ data: [] })
      if (op === "interrupt") return send({})
      if (op === "prompt" || op === "synthetic") {
        const id = body.id ?? "msg_" + randomUUID(),
          msg = { ...body, id, type: "user" }
        if (!p.messages.has(id)) {
          p.messages.set(id, msg)
          p.deliveries.push({ sid, id, text: body.text })
          s.history.push(msg)
          s.busy = true
          p.peak = Math.max(p.peak, ++p.active)
          void (w.modelDown ? Promise.resolve("") : model(s, msg))
            .then((text) =>
              s.history.push({
                id: w.modelCursor ?? "msg_" + randomUUID(),
                type: "assistant",
                content: [{ type: "text", text: w.modelAnswer ?? text }],
              }),
            )
            .catch((e) => p.errors.push(String(e)))
            .finally(() => {
              s.busy = false
              p.active--
              s.history.push({
                type: "idle",
                id: "msg_" + randomUUID(),
                outcome: w.modelDown ? "failed" : "succeeded",
              })
            })
        }
        return send({ data: msg })
      }
      send({ message: "unimplemented fixture route " + path }, 404)
    } catch (e) {
      p.errors.push(String(e))
      res.writeHead(500).end()
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  p.url = "http://127.0.0.1:" + server.address().port
  p.close = () => {
    server.closeAllConnections()
    return new Promise((r) => server.close(r))
  }
  return p
}
