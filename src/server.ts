/**
 * The service: one process that owns the database, runs the scheduler, and answers on IPv4 loopback.
 *
 * Routes: GET / and the page's files from web/; GET /v2/status, GET /v2/changes (server-sent events: a snapshot, then
 * changes, and a heartbeat every five seconds that needs no request), GET /v2/inbox, /v2/items/:id, /v2/search,
 * /v2/focus; POST /v2/items/:id/action, /v2/ask, /v2/backup, /v2/doctor, /v2/trial, and POST /mcp (Streamable HTTP
 * MCP, JSON replies). Requests must come to a loopback host name, and from the same origin if they name one.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, ask, deadlines, detail, focus, HttpError, inbox, rebuild, search } from "./inbox.ts";
import { Agents } from "./agents.ts";
import { brief } from "./brief.ts";
import { connect } from "./opencode.ts";
import type { Config } from "./config.ts";
import { clock } from "./clock.ts";
import { Collector } from "./collect.ts";
import { doctor } from "./doctor.ts";
import { secret } from "./exec.ts";
import { errorText } from "./redact.ts";
import { snapshot } from "./snapshot.ts";
import { Full, trace, type Store } from "./store.ts";
import { Refusal, Tools } from "./tools.ts";
import { emptyFolder, reconcile, Trial } from "./trial.ts";

export interface Service {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const HEARTBEAT_MS = 5_000;

export async function serve(store: Store, config: Config, options: { scheduler: boolean; collect: boolean; log: (line: string) => void; tick?: () => void }): Promise<Service> {
  const collector = new Collector(store, config, config.dataDir);
  const tools = new Tools(store);
  const empty = emptyFolder(config.dataDir);
  const trial = new Trial(store, tools, config, empty);
  const token = config.mcpToken ? await secret(config.mcpToken) : null;
  const current = () => snapshot(store, config, collector, true);
  const agents = new Agents(store, tools, config, empty, options.log);
  const key = (req: IncomingMessage) => req.headers["idempotency-key"] as string | undefined;
  // The owner's tools in an ordinary OpenCode session call exactly what the page calls.
  tools.owner = {
    exists: async (sessionId) => Boolean(await connect(config.opencode)?.exists(sessionId)),
    inbox: () => inbox(store),
    get: (id) => detail(store, config, id),
    search: (text) => search(store, config, text),
    act: (id, body) => ({ ...current(), action: act(store, config, id, body) }),
  };

  /** One scheduler pass: reconcile work from another timeline, collect what is due, then give agents their work. */
  rebuild(store);
  const pass = async () => {
    await reconcile(store, config, trial.driving).catch((e) => options.log(`reconcile: ${errorText(e)}`));
    if (options.collect) await collector.pass();
    try {
      store.expire(clock.now());
      deadlines(store);
      if (options.collect) agents.tick(); // the demo contacts nothing
      options.tick?.();
    } catch (e) {
      if (!(e instanceof Full)) throw e; // paused for disk: deadlines wait for room like every write
    }
  };

  // ---- server-sent events: a snapshot on connect, a change after each commit, a heartbeat on its own clock.
  const streams = new Set<ServerResponse>();
  const send = (res: ServerResponse, event: string, data: unknown, id?: number) =>
    res.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let changePending = false;
  const offCommit = store.onCommit(() => {
    if (changePending || streams.size === 0) return;
    changePending = true;
    setImmediate(() => {
      changePending = false;
      const s = current();
      for (const res of streams) send(res, "change", s, s.seq);
    });
  });
  let lastBeat = clock.mono();
  const beat = setInterval(() => {
    if (clock.mono() < lastBeat) lastBeat = clock.mono(); // the clock was replaced: count from there
    if (clock.mono() - lastBeat < HEARTBEAT_MS) return;
    lastBeat = clock.mono();
    for (const res of streams) send(res, "heartbeat", { seq: store.seq(), atMs: clock.now() });
  }, 200);

  const sessions = new Set<string>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const error = (code: number, kind: string, message: string) => reply(code, { error: { code: kind, message } });
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return error(403, "forbidden", "Overwatch answers on loopback only");
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return error(403, "forbidden", "cross-origin requests are refused");
    const address = new URL(req.url ?? "/", "http://localhost");
    const path = address.pathname;
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return error(413, "too_large", "request too large");
    }
    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return error(400, "bad_request", "the body is not JSON");
      }
    }
    if (req.method === "GET" && path === "/v2/status") return reply(200, current());
    if (req.method === "GET" && !path.startsWith("/v2/") && path !== "/mcp") return page(path, res);
    try {
      if (req.method === "GET" && path === "/v2/inbox") return reply(200, inbox(store));
      if (req.method === "GET" && path === "/v2/search") return reply(200, search(store, config, address.searchParams.get("q") ?? "", address.searchParams.get("cursor")));
      if (req.method === "GET" && path === "/v2/focus") return reply(200, focus(store, config, address.searchParams.get("subject") ?? ""));
      const item = /^\/v2\/items\/([^/]+)(\/action)?$/.exec(path);
      if (item && req.method === "GET" && !item[2]) return reply(200, detail(store, config, decodeURIComponent(item[1]!)));
      if (item && req.method === "POST" && item[2]) {
        const done = act(store, config, decodeURIComponent(item[1]!), body);
        return reply(200, { ...current(), action: done });
      }
      if (req.method === "POST" && path === "/v2/ask") return reply(200, ask(store, config, body, key(req)));
      const own = /^\/v2\/items\/([^/]+)\/(investigate|corrections)$/.exec(path);
      if (own && req.method === "POST" && own[2] === "investigate") return reply(202, agents.investigate(decodeURIComponent(own[1]!), key(req)));
      if (own && req.method === "POST") return reply(200, agents.correct(decodeURIComponent(own[1]!), body, key(req)));
      const jobRoute = /^\/v2\/jobs\/([^/]+)$/.exec(path);
      if (jobRoute && req.method === "GET") return reply(200, agents.job(decodeURIComponent(jobRoute[1]!)));
      if (req.method === "POST" && path === "/v2/open") return reply(200, await agents.open(String(body.subject ?? ""), key(req)));
      if (req.method === "GET" && path === "/v2/notifications") return reply(200, agents.notifications());
      const retry = /^\/v2\/notifications\/([^/]+)\/retry$/.exec(path);
      if (retry && req.method === "POST") return reply(200, agents.retry(decodeURIComponent(retry[1]!), key(req)));
      if (req.method === "GET" && path === "/v2/brief") {
        const q = address.searchParams, num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
        return reply(200, brief(store, config, q.get("audience") ?? "owner", num("afterSeq"), num("throughSeq")));
      }
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, ({ 404: "not_found", 409: "conflict", 503: "unavailable" } as Record<number, string>)[e.status] ?? "bad_request", errorText(e));
      if (e instanceof Full) return error(503, "paused", "collection is paused for disk space; see pausedFix in status");
      throw e;
    }
    if (req.method === "GET" && path === "/v2/changes") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const s = current();
      send(res, "snapshot", s, s.seq);
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "POST" && path === "/v2/backup") {
      if (typeof body.file !== "string") return error(400, "bad_request", "file is required");
      try {
        return reply(200, store.backup(body.file));
      } catch (e) {
        return error(409, "conflict", errorText(e));
      }
    }
    if (req.method === "POST" && path === "/v2/doctor") return reply(200, await doctor(config, store, empty));
    if (req.method === "POST" && path === "/v2/trial") {
      try {
        return reply(200, await trial.run());
      } catch (e) {
        return error(503, "unavailable", errorText(e));
      }
    }
    if (req.method === "POST" && path === "/mcp") return mcp(req, res, body, reply);
    // No server-initiated stream: Streamable HTTP clients are told so with 405, and carry on.
    if (path === "/mcp") return reply(405, { error: { code: "method_not_allowed", message: "POST only" } }, { allow: "POST" });
    return error(404, "not_found", `no route ${req.method} ${path}`);
  };

  /** MCP over Streamable HTTP with JSON replies. The bearer credential and the OpenCode session ID decide access. */
  const mcp = async (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, reply: (code: number, body: unknown, headers?: Record<string, string>) => void) => {
    const given = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(token ? `Bearer ${token}` : "");
    if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(401, { error: { code: "unauthorized", message: "a valid bearer credential is required" } });
    const id = body.id, method = String(body.method ?? "");
    if (id === undefined || id === null) {
      res.writeHead(202);
      return res.end();
    }
    const ok = (result: unknown, headers: Record<string, string> = {}) => reply(200, { jsonrpc: "2.0", id, result }, headers);
    if (method === "initialize") {
      const session = randomBytes(16).toString("hex");
      sessions.add(session);
      const requested = String((body.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-03-26");
      return ok({ protocolVersion: requested >= "2025-03-26" ? requested : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ow", version: "2" } }, { "mcp-session-id": session });
    }
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools: tools.list() });
    if (method === "tools/call") {
      const params = (body.params ?? {}) as { name?: string; arguments?: unknown; _meta?: Record<string, unknown> };
      try {
        const value = await tools.call(params._meta?.["ai.opencode/sessionID"], String(params.name ?? ""), params.arguments ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(value) }] });
      } catch (e) {
        const known = e instanceof Refusal || e instanceof HttpError;
        const message = known ? errorText(e, 30_000) : "the tool failed";
        if (!known) options.log(`tool ${params.name}: ${errorText(e)}`);
        return ok({ content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true });
      }
    }
    return reply(200, { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      options.log(`http: ${errorText(e)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  if (options.collect) await agents.start(1000); // notices left waiting go out first ("retried at start")
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : config.port}`;
  writeFileSync(join(config.dataDir, "service.json"), JSON.stringify({ url, pid: process.pid, version: 2 }), { mode: 0o600 });

  // ---- scheduling: on its own in production; under the test descriptor, only when told.
  const timers: NodeJS.Timeout[] = [];
  let control: Socket | null = null;
  if (process.env.OW_TEST_FD) {
    control = new Socket({ fd: Number(process.env.OW_TEST_FD), readable: true, writable: true });
    control.on("error", () => undefined);
    createInterface({ input: control }).on("line", (line) => {
      void (async () => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        const answer = (result: Record<string, unknown>) => control?.write(JSON.stringify({ id: message.id, ...result }) + "\n");
        try {
          if (message.op === "clock") clock.set(Number(message.nowMs), Number(message.monoMs));
          else if (message.op === "wake") collector.wake();
          else if (message.op === "space") collector.setSpace({ freeBytes: Number(message.freeBytes), dbBytes: Number(message.dbBytes) });
          else if (message.op === "trace") {
            trace.count = 0;
            trace.killAfter = message.killAfter === null || message.killAfter === undefined ? null : Number(message.killAfter);
          } else if (message.op === "poll") {
            await pass();
            return answer({ writes: trace.count });
          }
          answer({ ok: true });
        } catch (e) {
          answer({ error: errorText(e) });
        }
      })();
    });
  } else if (options.scheduler) {
    let lastMono = clock.mono();
    let network = networkKey();
    let busy = false;
    timers.push(
      setInterval(() => {
        // Waking from sleep (the clock jumped) or a network change probes failing sources after a few seconds.
        const jumped = clock.mono() - lastMono > 30_000;
        lastMono = clock.mono();
        const key = networkKey();
        if (jumped || key !== network) collector.wake();
        network = key;
        if (busy) return;
        busy = true;
        pass()
          .catch((e) => options.log(`collect: ${errorText(e)}`))
          .finally(() => (busy = false));
      }, 1_000),
    );
  }

  return {
    url,
    close: async () => {
      for (const t of timers) clearInterval(t);
      clearInterval(beat);
      offCommit();
      for (const res of streams) res.end();
      control?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(join(config.dataDir, "service.json"), { force: true });
    },
  };
}

/** The page: plain files from web/, the entry at /. Nothing outside that folder is served. */
const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
function page(path: string, res: ServerResponse) {
  const name = path === "/" ? "index.html" : path.slice(1);
  const file = join(WEB, name);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || !TYPES[extname(name)] || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { code: "not_found", message: `no page file ${path}` } }));
  }
  res.writeHead(200, { "content-type": TYPES[extname(name)]!, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  res.end(readFileSync(file));
}

function networkKey(): string {
  try {
    const { networkInterfaces } = process.getBuiltinModule("node:os");
    return JSON.stringify(Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal).map((a) => a!.address).sort());
  } catch {
    return "";
  }
}
