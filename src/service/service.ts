/**
 * The Overwatch service: one process that owns time, state and the view.
 *
 * It hosts the model on the SQLite host, polls every watcher on its schedule whether or not OpenCode is open, keeps
 * the search projection, drives agent runs into OpenCode, and serves the typed Api, the MCP server and the page on
 * loopback.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import { exec as defaultExec, type Exec } from "../collect/exec.ts";
import { configureRedaction } from "../collect/redact.ts";
import { sleep, type Runtime } from "../collect/runtime.ts";
import { resolveSecret } from "../collect/secrets.ts";
import { IncidentId, ThreadId, WatcherId } from "../domain/ids.ts";
import { AskThread, Thread } from "../domain/thread.ts";
import { Incident, ReportSignal } from "../domain/incident.ts";
import { API_VERSION, handlers, Overwatch, OverwatchApi } from "../domain/model.ts";
import { CompleteRun, FailRun, MarkRunSent, NudgeRun, Run } from "../domain/run.ts";
import { SearchStore } from "../domain/search.ts";
import { IncidentPage, PendingRuns, RUNS } from "../domain/views.ts";
import { ConfigureWatcher, RecordGap, Watcher } from "../domain/watcher.ts";
import { layerSqlite, SqliteHost } from "../host/sqlite.ts";
import { runWatcher, type WatcherRunSummary } from "./collector.ts";
import type { ServiceConfig } from "./config.ts";
import { mcpLayer } from "./mcp.ts";
import { openCodePort, type OpenCodePort } from "./opencode.ts";
import { catchUp, search } from "./search.ts";
import { createServiceTables } from "./tables.ts";
import { makeWorker } from "./worker.ts";
import { ensureWorktree, removeWorktree } from "./worktree.ts";

export const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;

export interface ServiceDeps {
  readonly exec?: Exec;
  readonly fetch?: typeof fetch;
  readonly opencode?: OpenCodePort;
  readonly log?: (message: string) => void;
  /** Port to listen on; 0 picks a free one (tests). Defaults to the configured port. */
  readonly port?: number;
  /** How often the scheduler and the worker look for work. */
  readonly tickMs?: number;
  /** Start polling and the worker. Tests drive them by hand. */
  readonly background?: boolean;
  /** Where the page's built files are. */
  readonly webDir?: string;
}

export interface ServiceHandle {
  readonly url: string;
  readonly port: number;
  readonly runtime: ManagedRuntime.ManagedRuntime<any, never>;
  readonly read: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  readonly atomically: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  /** Run one watcher now. */
  readonly collect: (watcherId: string) => Promise<WatcherRunSummary>;
  /** Run every due watcher now. */
  readonly pollDue: () => Promise<ReadonlyArray<WatcherRunSummary>>;
  /** One pass of the agent worker. */
  readonly work: () => Promise<unknown>;
  readonly status: () => Promise<Record<string, unknown>>;
  readonly stop: () => Promise<void>;
}

const WEB_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

export async function startService(config: ServiceConfig, deps: ServiceDeps = {}): Promise<ServiceHandle> {
  const log = deps.log ?? ((message: string) => console.log(`[overwatch] ${message}`));
  const exec = deps.exec ?? defaultExec;
  const options = config.options;
  configureRedaction(options.redaction);
  mkdirSync(config.dataDir, { recursive: true });
  const file = join(config.dataDir, "overwatch.sqlite");

  // ------------------------------------------------------------ the model on SQLite
  const Host = layerSqlite({ file, log });
  const Search = Layer.effect(SearchStore)(
    Effect.map(Effect.service(SqliteHost), (host) => ({
      search: (text: string, limit: number) =>
        host.connection.use((db) => {
          catchUp(db);
          return search(db, text, limit);
        }),
    })),
  );
  const Model = Overwatch.layer(handlers({ autoInvestigate: config.opencode.autoInvestigate }));
  const Quiet = Layer.succeed(References.MinimumLogLevel, "Warn" as const);
  const ServiceLayer = Model.pipe(Layer.provideMerge(Search), Layer.provideMerge(Host), Layer.provideMerge(Quiet));
  const runtime = ManagedRuntime.make(ServiceLayer);
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => runtime.runPromise(effect as Effect.Effect<A, E, never>);
  const host = await run(Effect.service(SqliteHost));
  const connection = host.connection;
  await connection.runAtomically((db) => createServiceTables(db));
  const read = connection.run;
  const atomically = connection.runAtomically;

  // ------------------------------------------------------------ ports
  const collectRuntime: Runtime = {
    options,
    exec,
    fetch: deps.fetch ?? globalThis.fetch,
    now: Date.now,
    log,
    sleep,
  };
  const password = config.opencode.password ? await resolveSecret(config.opencode.password, exec).catch((e) => (log(`opencode.password: ${(e as Error).message}`), undefined)) : undefined;
  const opencode =
    deps.opencode ??
    openCodePort({
      ...(config.opencode.url ? { url: config.opencode.url } : {}),
      ...(config.opencode.username ? { username: config.opencode.username } : {}),
      ...(password ? { password } : {}),
    });
  const worktreePorts = { exec, dataDir: config.dataDir, atomically };

  const domain = {
    report: (report: Parameters<Parameters<typeof runWatcher>[0]["report"]>[0]) =>
      run(
        Effect.gen(function* () {
          const incidents = yield* Incident;
          const { incidentId, commandId, ...input } = report;
          yield* incidents.send(Incident.ref(incidentId), new ReportSignal({ ...input, watcher: WatcherId.make(input.watcher) }), { commandId });
        }),
      ),
    recordGap: (watcher: string, gap: { source: string; from: number; to: number; reason: string }) =>
      run(
        Effect.gen(function* () {
          const watchers = yield* Watcher;
          yield* watchers.send(Watcher.ref(WatcherId.make(watcher)), new RecordGap(gap), { commandId: `gap_${watcher}_${gap.source}_${gap.from}_${gap.to}` });
        }),
      ),
    pendingRuns: () =>
      run(
        Effect.gen(function* () {
          const views = yield* PendingRuns;
          return Option.match(yield* views.get(RUNS), { onNone: () => [], onSome: (v) => v.runs });
        }),
      ),
    /** The incident's page, at least as new as its last commit in the journal: views are eventually consistent. */
    incidentPage: async (id: string) => {
      const stream = `Incident/${id}`;
      const version = await read((db) => (db.prepare("SELECT max(version) AS v FROM journal WHERE stream = ?").get(stream) as { v: number | null }).v);
      return run(
        Effect.gen(function* () {
          const pages = yield* IncidentPage;
          const options = version ? { atLeast: { stream, version }, timeout: "15 seconds" as const } : {};
          return Option.getOrNull(yield* pages.get(Incident.ref(id as never), options).pipe(Effect.orElseSucceed(() => Option.none()))) ?? null;
        }),
      );
    },
    incident: (id: string) =>
      run(
        Effect.gen(function* () {
          const incidents = yield* Incident;
          const state = yield* incidents.get(Incident.ref(id as never));
          return state._tag === "Open" ? { app: state.app, environment: state.environment } : undefined;
        }),
      ),
    runStatus: (runId: string) =>
      run(
        Effect.gen(function* () {
          const runs = yield* Run;
          const state = yield* runs.get(Run.ref(runId as never));
          return state._tag === "Run" ? state.status : undefined;
        }),
      ),
    runCommand: (runId: string, command: MarkRunSent | NudgeRun | FailRun | CompleteRun, commandId: string) =>
      run(
        Effect.gen(function* () {
          const runs = yield* Run;
          yield* (runs.send(Run.ref(runId as never), command as MarkRunSent, { commandId }) as Effect.Effect<unknown, { readonly _tag: string }>).pipe(
            Effect.catchIf((e) => e._tag === "RunUnknown", () => Effect.void),
          );
        }),
      ),
  };

  // ------------------------------------------------------------ watchers
  for (const watcher of options.watchers) {
    await run(
      Effect.gen(function* () {
        const watchers = yield* Watcher;
        yield* watchers.send(
          Watcher.ref(WatcherId.make(watcher.id)),
          new ConfigureWatcher({ app: watcher.app, environment: watcher.environment, sources: [...watcher.sources], everyMs: watcher.everyMs }),
        );
      }),
    );
    await atomically((db) => db.prepare("INSERT OR IGNORE INTO watcher_runs (watcher, next_at) VALUES (?, ?)").run(watcher.id, Date.now()));
  }
  const collectorPorts = { runtime: collectRuntime, atomically, read, report: domain.report, recordGap: domain.recordGap };
  const running = new Set<string>();
  const collect = async (watcherId: string) => {
    const watcher = options.watchers.find((w) => w.id === watcherId);
    if (!watcher) throw new Error(`No watcher ${watcherId}`);
    if (running.has(watcherId)) throw new Error(`${watcherId} is already running`);
    running.add(watcherId);
    const started = Date.now();
    await atomically((db) => db.prepare("UPDATE watcher_runs SET last_started = ? WHERE watcher = ?").run(started, watcherId));
    try {
      const summary = await runWatcher(collectorPorts, watcher);
      await atomically((db) =>
        db
          .prepare("UPDATE watcher_runs SET last_finished = ?, next_at = ?, last_error = ?, last_summary = ? WHERE watcher = ?")
          .run(Date.now(), Date.now() + watcher.everyMs, summary.failed.length ? `failed: ${summary.failed.join(", ")}` : null, JSON.stringify({ reported: summary.reported, gaps: summary.gaps.length }), watcherId),
      );
      return summary;
    } catch (error) {
      await atomically((db) => db.prepare("UPDATE watcher_runs SET last_finished = ?, next_at = ?, last_error = ? WHERE watcher = ?").run(Date.now(), Date.now() + watcher.everyMs, (error as Error).message, watcherId));
      throw error;
    } finally {
      running.delete(watcherId);
    }
  };
  /** Runs each watcher that is due once, however many intervals it missed (a laptop asleep misses several). */
  const pollDue = async () => {
    if (config.errors.length) return [];
    const due = await read((db) => db.prepare("SELECT watcher FROM watcher_runs WHERE next_at <= ?").all(Date.now()) as Array<{ watcher: string }>);
    const summaries: WatcherRunSummary[] = [];
    for (const { watcher } of due) {
      if (!options.watchers.some((w) => w.id === watcher) || running.has(watcher)) continue;
      try {
        summaries.push(await collect(watcher));
      } catch (error) {
        log(`watcher ${watcher}: ${(error as Error).message}`);
      }
    }
    return summaries;
  };

  // ------------------------------------------------------------ agent worker
  const worker = makeWorker({
    opencode,
    atomically,
    pendingRuns: domain.pendingRuns,
    incidentPage: domain.incidentPage,
    checkoutOf: (app) => options.apps[app]?.checkout,
    worktree: (threadId, checkout) => ensureWorktree(worktreePorts, threadId, checkout),
    runStatus: domain.runStatus,
    markSent: (runId) => domain.runCommand(runId, new MarkRunSent({}), `sent_${runId}`),
    adopt: (input) =>
      run(
        Effect.gen(function* () {
          const threads = yield* Thread;
          const page = yield* Effect.promise(() => domain.incidentPage(input.subject));
          yield* threads
            .send(
              Thread.ref(ThreadId.make(input.threadId)),
              new AskThread({
                subject: IncidentId.make(input.subject),
                title: page?.title ?? input.subject,
                promptId: input.messageId,
                text: input.text,
                mode: "investigate",
                origin: "opencode",
                override: "here",
                inSession: input.sessionId,
              }),
              { commandId: `adopt_${input.messageId}` },
            )
            .pipe(Effect.catchTag("ThreadClosed", () => Effect.void));
        }),
      ),
    nudge: (runId, messageId) => domain.runCommand(runId, new NudgeRun({ messageId }), `nudge_${messageId}`),
    fail: (runId, reason) => domain.runCommand(runId, new FailRun({ reason }), `fail_${runId}`),
    now: Date.now,
    runTimeoutMs: config.opencode.runTimeoutMs,
    log,
  });

  // ------------------------------------------------------------ journal reactions: search and archived threads
  const react = async () => {
    await read((db) => catchUp(db));
    const archived = await read((db) => {
      const state = db.prepare("SELECT position FROM projections WHERE name = 'cleanup'").get() as { position: number } | undefined;
      const rows = db.prepare("SELECT position, stream FROM journal WHERE position > ? AND type = 'ThreadArchived' ORDER BY position").all(state?.position ?? 0) as Array<{ position: number; stream: string }>;
      const end = (db.prepare("SELECT max(position) AS p FROM journal").get() as { p: number | null }).p ?? 0;
      return { rows, end };
    });
    for (const row of archived.rows) {
      const threadId = row.stream.slice(row.stream.indexOf("/") + 1);
      await removeWorktree(worktreePorts, threadId);
      await atomically((db) => db.prepare("DELETE FROM shown WHERE thread_id = ?").run(threadId));
    }
    await atomically((db) =>
      db.prepare("INSERT INTO projections (name, position, version) VALUES ('cleanup', ?, 1) ON CONFLICT (name) DO UPDATE SET position = excluded.position").run(archived.end),
    );
  };
  let reacting: Promise<void> | undefined;
  const unlisten = connection.afterCommit(() => {
    reacting ??= react()
      .catch((error) => log(`journal reactions: ${(error as Error).message}`))
      .finally(() => (reacting = undefined));
  });
  await react();

  // ------------------------------------------------------------ MCP
  const mcp = HttpRouter.toWebHandler(
    mcpLayer(
      {
        options,
        runtime: collectRuntime,
        read,
        atomically,
        runStatus: domain.runStatus,
        incident: domain.incident,
        worktree: (threadId) => read((db) => (db.prepare("SELECT path FROM worktrees WHERE thread_id = ?").get(threadId) as { path: string } | undefined)?.path),
        complete: (runId, sessionId, finding) => domain.runCommand(runId, new CompleteRun({ sessionId, finding }), `complete_${runId}`),
        now: Date.now,
      },
      VERSION,
    ).pipe(Layer.provide(Layer.succeedContext(await run(Effect.context<any>())))) as never,
    { disableLogger: true },
  );

  // ------------------------------------------------------------ the typed Api
  const api = await run(
    Effect.gen(function* () {
      const served = yield* OverwatchApi;
      const context = yield* Effect.context<never>();
      return HttpEffect.toWebHandler((served as unknown as { fetch: Effect.Effect<any, never, any> }).fetch.pipe(Effect.provide(context)) as never);
    }),
  );

  const status = async () => {
    const watchers = await read((db) =>
      db.prepare("SELECT watcher, next_at, last_started, last_finished, last_error, last_summary FROM watcher_runs ORDER BY watcher").all(),
    );
    const checkpoints = await read((db) => db.prepare("SELECT watcher, source, at FROM checkpoints ORDER BY watcher, source").all());
    const w = worker.status();
    return {
      name: "overwatch",
      version: VERSION,
      apiVersion: API_VERSION,
      configErrors: config.errors,
      opencode: { connected: w.opencode !== undefined, url: w.opencode ?? null, checkedAt: w.checkedAt, waitingRuns: w.waiting, runningRuns: w.running },
      watchers: watchers.map((row) => ({ ...row })),
      checkpoints: checkpoints.map((row) => ({ ...row })),
    };
  };

  // ------------------------------------------------------------ HTTP
  const webDir = deps.webDir ?? WEB_DIR;
  let port = deps.port ?? config.port;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const hostHeader = req.headers.host ?? "";
    // Loopback only, and only for pages it served: a DNS-rebinding page or another site's form cannot drive it.
    if (!allowedHosts().has(hostHeader)) return void res.writeHead(403).end("Overwatch answers on loopback only");
    const origin = req.headers.origin;
    if (origin && origin !== `http://${hostHeader}`) return void res.writeHead(403).end("Cross-origin requests are refused");
    const url = new URL(req.url ?? "/", `http://${hostHeader}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ name: "overwatch", version: VERSION, apiVersion: API_VERSION }));
    }
    if (url.pathname === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(await status()));
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream);
    const forward = async (handler: (request: Request) => Promise<Response>, path: string) => {
      const response = await handler(
        new Request(`http://${hostHeader}${path}${url.search}`, { method: req.method ?? "GET", headers: req.headers as Record<string, string>, body, duplex: "half" } as RequestInit),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body as never).pipe(res);
      else res.end();
    };
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) return forward(mcp.handler as (r: Request) => Promise<Response>, url.pathname);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return forward(api, url.pathname.slice(4) || "/");
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = join(webDir, name);
    if (!name.includes("..") && existsSync(path) && TYPES[extname(path)]) {
      res.writeHead(200, { "content-type": TYPES[extname(path)]!, "cache-control": "no-store" });
      return void res.end(readFileSync(path));
    }
    res.writeHead(404).end("Not found");
  };
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`http ${req.method} ${req.url}: ${(error as Error).message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  // ------------------------------------------------------------ background work
  const tickMs = deps.tickMs ?? 5_000;
  const timers: NodeJS.Timeout[] = [];
  if (deps.background !== false) {
    let polling = false;
    timers.push(
      setInterval(() => {
        if (polling) return;
        polling = true;
        pollDue().finally(() => (polling = false));
      }, tickMs),
      setInterval(() => void worker.tick().catch((error) => log(`worker: ${(error as Error).message}`)), Math.min(tickMs, 2_000)),
    );
    void pollDue();
  }
  if (config.errors.length) log(`configuration errors; watchers do not run until they are fixed:\n- ${config.errors.join("\n- ")}`);
  log(`listening on ${url} (database ${file})`);

  return {
    url,
    port,
    runtime: runtime as never,
    read,
    atomically,
    collect,
    pollDue,
    work: () => worker.tick(),
    status,
    stop: async () => {
      for (const timer of timers) clearInterval(timer);
      unlisten();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await mcp.dispose();
      await reacting;
      await runtime.dispose();
    },
  };
}

void Exit;
