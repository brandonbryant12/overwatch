/**
 * The service: one process that owns the database, runs the scheduler, and answers on IPv4 loopback, built from
 * Effect's HTTP server (`HttpRouter` on `NodeHttpServer`).
 *
 * Routes: GET / and the page's files from web/; GET /v2/status, GET /v2/changes (server-sent events: a snapshot, then
 * changes, and a heartbeat every five seconds that needs no request), GET /v2/inbox, /v2/items/:id, /v2/search,
 * /v2/focus; POST /v2/items/:id/action, /v2/ask, /v2/backup, /v2/doctor, /v2/trial, and POST /mcp (Streamable HTTP
 * MCP, from `src/mcp.ts`). Requests must come to a loopback host name, and from the same origin if they name one.
 */
import { NodeHttpServer, NodeSocket } from "@effect/platform-node";
import { Cause, Effect, FileSystem, Layer, Option, Path, Predicate, PubSub, Schedule, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { OpenCodeClient } from "./opencode.ts";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { Agents } from "./agents.ts";
import { brief } from "./brief.ts";
import { clock } from "./clock.ts";
import { Collector } from "./collect.ts";
import { AppConfig } from "./config.ts";
import { freshen } from "./demo.ts";
import { doctor } from "./doctor.ts";
import { ApiError, apiError, type Full } from "./errors.ts";
import { Fixes } from "./fixes.ts";
import { act, ask, basisOf, deadlines, focus, inbox, keyed, rebuild, search, type Plan } from "./inbox.ts";
import { itemOf, McpRoutes } from "./mcp.ts";
import { compare, comparisons, forecasts } from "./outlook.ts";
import { errorText } from "./redact.ts";
import { snapshot } from "./snapshot.ts";
import { Store, trace } from "./store.ts";
import { Tools } from "./tools.ts";
import { emptyFolder, reconcile, Trial } from "./trial.ts";

const HEARTBEAT_MS = 5_000;
const MAX_BODY = 1_000_000;

/** A refusal as the API states it: `{ error: { code, message } }` with the status. */
const refusal = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status, headers });
const CODES: Record<number, string> = { 404: "not_found", 409: "conflict", 503: "unavailable" };

/** Every handler's outcome as a response: a value as JSON, a known refusal with its status, a defect as 500. */
const respond = <A, R>(work: Effect.Effect<A, ApiError | Full, R>, status = 200) =>
  work.pipe(
    Effect.map((value) => HttpServerResponse.jsonUnsafe(value, { status })),
    Effect.catchTags({
      ApiError: (e) => Effect.succeed(refusal(e.status, CODES[e.status] ?? "bad_request", errorText(e))),
      Full: () => Effect.succeed(refusal(503, "paused", "collection is paused for disk space; see pausedFix in status")),}),
    Effect.catchDefect((defect) => Effect.as(Effect.logError(`http: ${errorText(defect)}`), HttpServerResponse.empty({ status: 500 }))));

/** The JSON body of a request, at most 1 MB; a refusal when it is larger or not JSON. */
const body = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const length = Number(request.headers["content-length"] ?? 0);
  if (length > MAX_BODY) return yield* apiError(413, "request too large");
  const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  if (text.length > MAX_BODY) return yield* apiError(413, "request too large");
  if (!text) return {} as Record<string, unknown>;
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(Effect.mapError(() => apiError(400, "the body is not JSON")));
  return (Predicate.isObject(value) && !Array.isArray(value) ? value : {}) as Record<string, unknown>; });

/** How a POST may change state. Every POST is declared in WRITES with exactly one of these. */
/** What a route handler may read: the database, the configuration, the services and the platform. */
type Needs = Store | AppConfig | Collector | Agents | Fixes | Trial | Tools | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient | OpenCodeClient;
type Guard<R> =
  | { readonly keyed: (params: Params, body: Record<string, unknown>) => Effect.Effect<Plan<any, any, R>, ApiError, R>; readonly code?: number }
  | { readonly fenced: (params: Params, body: Record<string, unknown>, basis: number | null) => Effect.Effect<unknown, ApiError | Full, R> }
  | { readonly command: (params: Params, body: Record<string, unknown>) => Effect.Effect<unknown, ApiError | Full, R> };
type Params = Readonly<Record<string, string | undefined>>;

/** The page: the built files in web/dist/ (`pnpm run build:web`), the entry at /. Nothing outside that folder is served. */
const WEB = fileURLToPath(new URL("../web/dist/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",};
const page = (pathname: string) => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    const type = TYPES[path.extname(name)];
    const file = path.join(WEB, name);
    const isFile = yield* fs.stat(file).pipe(Effect.map((info) => info.type === "File"), Effect.orElseSucceed(() => false));
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || !type || !isFile) return refusal(404, "not_found", `no page file ${pathname}`);
    const bytes = yield* fs.readFile(file).pipe(Effect.orDie);
    return HttpServerResponse.uint8Array(bytes, { contentType: type, headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" } }); });

/** The addresses of this machine's network interfaces: a change wakes failing sources. */
const networkKey = () => {
  try {
    const { networkInterfaces } = process.getBuiltinModule("node:os");
    return JSON.stringify(Object.values(networkInterfaces()) .flat() .filter((a) => a && !a.internal) .map((a) => a!.address) .sort());
  } catch {
    return "";
  }};

/**
 * Serves until interrupted. `demo` seeds nothing here (the caller did) but contacts nothing: no collection, agents or
 * fixes. `ready` is told the address once the server listens and the discovery record is written.
 */
export const serve = (options: { readonly demo: boolean; readonly ready: (url: string) => Effect.Effect<void> }) => Effect.gen(function* () {
    const config = yield* AppConfig;
    const collect = !options.demo;

    const Routes = HttpRouter.use(
      Effect.fn(function* (router) {
        const store = yield* Store;
        const collector = yield* Collector;
        const agents = yield* Agents;
        const fixes = yield* Fixes;
        const trial = yield* Trial;
        const empty = yield* emptyFolder(config.dataDir);
        /** The services a long-lived response stream reads after its handler has returned. */
        const services = yield* Effect.context<Needs>();
        const current = snapshot(collector.view, true);
        /** The state after a decision: taken once the decision is written, so it includes it. */
        const decided = (action: { seq: number | null }) => Effect.map(current, (s) => ({ ...s, action }));

        // ---- reads
        const get = (path: HttpRouter.PathInput, handler: (request: HttpServerRequest.HttpServerRequest, url: URL, params: Params) => Effect.Effect<unknown, ApiError | Full, Needs>) =>
          router.add("GET", path, (request) =>
            Effect.flatMap(HttpRouter.params, (params) => respond(handler(request, new URL(request.url, "http://localhost"), params)).pipe(Effect.provideContext(services))),
          );
        yield* get("/v2/status", () => current);
        yield* get("/v2/inbox", () => inbox);
        yield* get("/v2/search", (_, url) => search(url.searchParams.get("q") ?? "", url.searchParams.get("cursor")));
        yield* get("/v2/focus", (_, url) => focus(url.searchParams.get("subject") ?? ""));
        yield* get("/v2/items/:id", (_, __, p) => itemOf(p.id!));
        yield* get("/v2/fixes/:id", (_, __, p) => fixes.view(p.id!));
        yield* get("/v2/jobs/:id", (_, __, p) => agents.job(p.id!));
        yield* get("/v2/notifications", () => agents.notifications);
        yield* get("/v2/outlook", () => Effect.all({ forecasts, comparisons }));
        yield* get("/v2/brief", (_, url) => {
          const q = url.searchParams, num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
          return brief(q.get("audience") ?? "owner", num("afterSeq"), num("throughSeq")); });

        // ---- server-sent events: a snapshot on connect, a change after each commit, a heartbeat on its own clock.
        const frame = (event: string, data: unknown, id?: number) => `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        // One heartbeat clock for every open stream, checked every 200 ms against the service's monotonic clock.
        const beats = yield* PubSub.unbounded<{ seq: number; atMs: number }>();
        let lastBeat = clock.mono();
        yield* Effect.gen(function* () {
          if (clock.mono() < lastBeat) lastBeat = clock.mono(); // the clock was replaced: count from there
          if (clock.mono() - lastBeat < HEARTBEAT_MS) return;
          lastBeat = clock.mono();
          yield* PubSub.publish(beats, { seq: yield* store.seq, atMs: clock.now() });
        }).pipe(Effect.repeat(Schedule.spaced("200 millis")), Effect.forkScoped);
        const heartbeats = Stream.fromPubSub(beats).pipe(Stream.map((beat) => frame("heartbeat", beat)));
        // Commits that arrive while a change is being prepared are coalesced into the next one.
        const changes = store.changes.pipe(Stream.chunks, Stream.mapEffect(() => Effect.map(current, (s) => frame("change", s, s.seq))));
        yield* router.add("GET", "/v2/changes", () =>
          Effect.map(current, (s) =>
            HttpServerResponse.stream(Stream.concat(Stream.make(frame("snapshot", s, s.seq)), Stream.merge(changes, heartbeats)).pipe(Stream.encodeText, Stream.provideContext(services)), {
              contentType: "text/event-stream",
              headers: { "cache-control": "no-store", connection: "keep-alive" },})));

        // ---- writes. Every POST is declared here, and only here, with its guard: `keyed` (the router takes the
        // request key and wraps the change in its receipt), `fenced` (the router hands over the basisSeq the owner was
        // shown; a decision made since refuses it) or `command` (changes no item: backup, doctor, trial). Anything
        // else is refused before it runs. MCP is its own route, from src/mcp.ts.
        const WRITES: ReadonlyArray<readonly [HttpRouter.PathInput, Guard<Needs>]> = [
          ["/v2/ask", { keyed: (_, b) => ask(b) }],
          ["/v2/open", { keyed: (_, b) => agents.open(String(b.subject ?? "")) }],
          ["/v2/items/:id/investigate", { keyed: (p) => agents.investigate(p.id!), code: 202 }],
          ["/v2/items/:id/corrections", { keyed: (p, b) => agents.correct(p.id!, b) }],
          ["/v2/items/:id/fix", { keyed: (p, b) => fixes.request(p.id!, b), code: 202 }],
          ["/v2/fixes/:id/publish", { keyed: (p, b) => Effect.flatMap(basisOf(b), (basis) => fixes.publication(p.id!, basis)) }],
          ["/v2/notifications/:id/retry", { keyed: (p) => agents.retry(p.id!) }],
          ["/v2/items/:id/action", { fenced: (p, b, basis) => Effect.flatMap(act(p.id!, b, basis), decided) }],
          ["/v2/backup", { command: (_, b) => (Predicate.isString(b.file) ? store.backup(b.file).pipe(Effect.mapError((e) => apiError(409, e.message))) : apiError(400, "file is required")) }],
          ["/v2/doctor", { command: () => doctor(store, empty) }],
          [
            "/v2/trial",
            {
              command: (_, b) => Effect.gen(function* () {
                  const report = yield* trial.run.pipe(Effect.catchCause((cause) => Effect.fail(apiError(503, errorText(Cause.squash(cause))))));
                  return b.fixes === true ? { ...report, fixGate: yield* fixes.calibrate(report.automation).pipe(Effect.catchTag("Unavailable", (e) => Effect.fail(apiError(503, e.message)))) } : report; }),}]];
        for (const [path, guard] of WRITES) {
          yield* router.add("POST", path, (request) => Effect.gen(function* () {
              const params = yield* HttpRouter.params;
              const b = yield* body;
              if ("keyed" in guard) {
                const key = request.headers["idempotency-key"];
                return HttpServerResponse.jsonUnsafe(yield* keyed(key, yield* guard.keyed(params, b)), { status: guard.code ?? 200 });
              }
              if ("fenced" in guard) return HttpServerResponse.jsonUnsafe(yield* guard.fenced(params, b, yield* basisOf(b)));
              if ("command" in guard) return HttpServerResponse.jsonUnsafe(yield* guard.command(params, b));
              return yield* Effect.die(new Error(`POST ${path} is declared without a guard: it must be keyed, fenced or a command`));
            }).pipe(
              Effect.catchTags({
                ApiError: (e) => Effect.succeed(refusal(e.status, CODES[e.status] ?? "bad_request", errorText(e))),
                Full: () => Effect.succeed(refusal(503, "paused", "collection is paused for disk space; see pausedFix in status")),}),
              Effect.catchDefect((defect) => Effect.as(Effect.logError(`http: ${errorText(defect)}`), HttpServerResponse.empty({ status: 500 }))),
              Effect.provideContext(services)));
        }

        // ---- the page, and everything else.
        yield* router.add("GET", "/*", (request) => {
          const pathname = new URL(request.url, "http://localhost").pathname;
          return pathname.startsWith("/v2/") || pathname === "/mcp" ? Effect.succeed(refusal(404, "not_found", `no route GET ${pathname}`)) : page(pathname); });
        // Every other method on any path (GET /* is the page, above): the router's "*" would claim GET too.
        for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS", "POST"] as const)
          yield* router.add(method, "/*", (request) => Effect.succeed(refusal(404, "not_found", `no route ${request.method} ${new URL(request.url, "http://localhost").pathname}`)));
      }));

    /** Requests must come to a loopback host name, and from the same origin if they name one. */
    const Loopback = HttpRouter.middleware(
      (app) => Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const host = request.headers.host ?? "";
          if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return refusal(403, "forbidden", "Overwatch answers on loopback only");
          if (request.headers.origin && request.headers.origin !== `http://${host}`) return refusal(403, "forbidden", "cross-origin requests are refused");
          return yield* app; }),
      { global: true });

    /** One scheduler pass: reconcile work from another timeline, collect what is due, then give agents their work. */
    const Scheduler = Layer.effectDiscard(Effect.gen(function* () {
        const store = yield* Store;
        const collector = yield* Collector;
        const agents = yield* Agents;
        const fixes = yield* Fixes;
        const trial = yield* Trial;
        yield* rebuild;
        const pass = Effect.gen(function* () {
          yield* reconcile(trial.driving).pipe(Effect.catchCause((cause) => Effect.logError(`reconcile: ${errorText(Cause.squash(cause))}`)));
          if (collect) yield* collector.pass;
          yield* Effect.gen(function* () {
            if (collect) yield* compare;
            yield* store.expire(clock.now());
            yield* deadlines;
            if (collect) yield* agents.tick; // the demo contacts nothing
            if (collect) yield* fixes.tick;
            if (options.demo) yield* freshen;
          }).pipe(Effect.catchTag("Full", () => Effect.void)); // paused for disk: deadlines wait for room like every write
        });
        if (collect) yield* agents.start(1000); // notices left waiting go out first ("retried at start")

        if (process.env.OW_TEST_FD) {
          // ---- under the test descriptor, scheduling happens only when told, over the control descriptor.
          const fd = Number(process.env.OW_TEST_FD);
          const socket = yield* NodeSocket.fromDuplex(Effect.sync(() => new Socket({ fd, readable: true, writable: true })));
          const { write } = yield* socket.writer;
          const Control = Schema.Struct({ id: Schema.optional(Schema.Unknown), op: Schema.String, nowMs: Schema.optional(Schema.Number), monoMs: Schema.optional(Schema.Number), freeBytes: Schema.optional(Schema.Number), dbBytes: Schema.optional(Schema.Number), killAfter: Schema.optional(Schema.NullOr(Schema.Number)) });
          const handle = (line: string) => Effect.gen(function* () {
              const message = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Control))(line).pipe(Effect.option);
              if (Option.isNone(message)) return;
              const m = message.value;
              const answer = (result: Record<string, unknown>) => write(JSON.stringify({ id: m.id, ...result }) + "\n").pipe(Effect.ignore);
              const outcome = yield* Effect.exit(Effect.gen(function* () {
                  if (m.op === "clock") clock.set(Number(m.nowMs), Number(m.monoMs));
                  else if (m.op === "wake") yield* collector.wake;
                  else if (m.op === "space") yield* collector.setSpace({ freeBytes: Number(m.freeBytes), dbBytes: Number(m.dbBytes) });
                  else if (m.op === "trace") {
                    trace.count = 0;
                    trace.killAfter = m.killAfter === null || m.killAfter === undefined ? null : Number(m.killAfter);
                  } else if (m.op === "poll") {
                    yield* pass;
                    return { writes: trace.count };
                  }
                  return { ok: true }; }));
              yield* answer(outcome._tag === "Success" ? outcome.value : { error: errorText(Cause.squash(outcome.cause)) }); });
          const reader = yield* socket.reader;
          yield* Stream.fromEffectRepeat(reader.pull).pipe(
            Stream.flattenIterable,
            Stream.map((chunk) => (Predicate.isString(chunk) ? chunk : new TextDecoder().decode(chunk as Uint8Array))),
            Stream.splitLines,
            Stream.runForEach((line) => Effect.forkDetach(handle(line))),
            Effect.ignore,
            Effect.forkScoped);
        } else {
          // ---- on its own in production: a pass every second, never two at once. Waking from sleep (the clock
          // jumped) or a network change probes failing sources after a few seconds.
          let lastMono = clock.mono();
          let network = networkKey();
          yield* Effect.gen(function* () {
            const jumped = clock.mono() - lastMono > 30_000;
            lastMono = clock.mono();
            const key = networkKey();
            if (jumped || key !== network) yield* collector.wake;
            network = key;
            yield* pass.pipe(Effect.catchCause((cause) => Effect.logError(`collect: ${errorText(Cause.squash(cause))}`)));
          }).pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped);
        }}));

    /** The discovery record, written once listening and removed at stop; then the caller is told the address. */
    const Discovery = Layer.effectDiscard(Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const port = server.address._tag === "UnixPathAddress" ? config.port : server.address.port;
        const url = `http://127.0.0.1:${port}`;
        const file = path.join(config.dataDir, "service.json");
        yield* Effect.acquireRelease(fs.writeFileString(file, JSON.stringify({ url, pid: process.pid, version: 2 }), { mode: 0o600 }).pipe(Effect.orDie), () =>
          fs.remove(file, { force: true }).pipe(Effect.ignore));
        yield* options.ready(url); }));

    const Services = Layer.mergeAll(Collector.layer, Tools.layer, Agents.layer, Fixes.layer, Trial.layer, OpenCodeClient.layer, FetchHttpClient.layer);
    const App = Layer.mergeAll(Routes, McpRoutes, Loopback);
    const Listener = NodeHttpServer.layer(createServer, { port: config.port, host: "127.0.0.1", gracefulShutdownTimeout: "100 millis" });
    const Http = Layer.mergeAll(HttpRouter.serve(App, { disableLogger: true, disableListenLog: true }), Discovery).pipe(Layer.provide(Listener));
    return yield* Layer.launch(Layer.mergeAll(Http, Scheduler).pipe(Layer.provide(Services))); });
