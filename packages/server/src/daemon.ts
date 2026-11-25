import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as DomainHttp from "@alchemy.run/domain/Http";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import {
  BriefListView,
  Catalog,
  EvidenceId,
  GLOBAL_CATALOG_ID,
  GLOBAL_VIEW_KEY,
  Incident,
  IncidentDetailView,
  IncidentId,
  InsightFeedView,
  InsightId,
  NeedsMeView,
  NotifierExternal,
  NowView,
  OperatorApi,
  OverwatchHandlersLive,
  OverwatchModel,
  RecordHostWake,
  RecordInsight,
  RegisterEnvironment,
  RunListView,
  ScorecardView,
  UpsertWatchRule,
  WatchRuleId,
  type OverwatchConfig,
} from "@overwatch/domain";
import {
  GitHubLiveLayer,
  MacOsNotifierLive,
  makeDemoGitHubLayer,
  SilentNotifierLive,
  type EnvironmentTelemetrySnapshot,
} from "@overwatch/connectors";
import { makeSqlitePlatformLayer } from "@overwatch/sqlite-platform";
import { makeCollector } from "./collector.ts";
import type { DaemonContext, RunEffect } from "./context.ts";
import { seedDemoScenario, seedDemoTelemetry } from "./demo-seed.ts";
import { DemoSimulator } from "./demo-simulator.ts";
import { EventHub, type StreamEvent } from "./event-hub.ts";
import { makeRequestGuard, resolveStaticPath } from "./http-guard.ts";
import { IntentError, makeIntentHandlers } from "./intents.ts";
import { Monitor, type MonitorStatus, type OperatorNotification } from "./monitor.ts";
import { buildSessionHandoff, makeOpenCodeExternalLayer } from "./opencode-bridge.ts";
import { TelemetryStore } from "./telemetry-store.ts";
import { WakeCoordinator, type WakeEvent } from "./wake-coordinator.ts";

export type { StreamEvent } from "./event-hub.ts";

export interface OverwatchDaemonOptions {
  readonly config: OverwatchConfig;
  readonly dbPath: string;
  readonly host?: string;
  readonly port?: number;
  readonly webDistDir?: string;
  readonly silentNotifications?: boolean;
  /** Runs the monitor schedule and sleep detection. Tests turn this off and sweep by hand. */
  readonly enableBackgroundTimers?: boolean;
  /** Replaces every environment's collection cadence. */
  readonly cadenceOverrideSeconds?: number;
  /** Extra hostnames this daemon may be reached under, besides loopback. */
  readonly allowedHosts?: ReadonlyArray<string>;
  /** Where per-run git worktrees live. Defaults to a directory beside the database. */
  readonly worktreeRoot?: string;
}

export interface OverwatchDaemon {
  readonly url: string;
  readonly port: number;
  readonly telemetry: TelemetryStore;
  readonly monitor: Monitor;
  readonly getOpenApiDocument: () => unknown;
  readonly getFullState: () => Promise<Record<string, unknown>>;
  readonly stop: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

export function buildOpenApiDocument(): unknown {
  const surface = DomainHttp.toHttpApi(OperatorApi, {
    expose: [
      "OpenIncident",
      "AttachSignal",
      "UpdateUnderstanding",
      "RecordFinding",
      "RecordVerificationBundle",
      "EnterWatching",
      "RecordCleanWindow",
      "ResolveIncident",
      "DismissIncident",
      "RecordIncidentFeedback",
      "PostIncidentChat",
      "OpenAsk",
      "AnswerAsk",
      "SyncExternalAskResolution",
      "RequestAction",
      "StartRun",
      "CompleteRun",
      "RecordInsight",
      "PromoteInsightToWatch",
      "PromoteInsightToIncident",
      "DismissInsight",
      "SaveBriefDraft",
      "EditBriefDraft",
      "ApproveBrief",
      "DecideProposal",
      "NowView.get",
      "IncidentDetailView.get",
      "NeedsMeView.get",
      "InsightFeedView.get",
      "RunListView.get",
      "ScorecardView.get",
      "BriefListView.get",
    ],
  });
  return OpenApi.fromApi(surface.api);
}

/**
 * Brings the catalog in line with the config file on every boot: new environments are registered
 * and changed watch rules are upserted. Command ids include a content hash, so an unchanged
 * config sends nothing new and an edited rule is not mistaken for a retry of the old one.
 */
async function reconcileCatalog(
  ctx: DaemonContext,
  seedSnapshots: ReadonlyArray<EnvironmentTelemetrySnapshot>,
): Promise<void> {
  const { config, runEffect } = ctx;
  const [nowOpt, feedOpt] = await runEffect(
    Effect.all([
      Effect.flatMap(NowView, (v) => v.get(GLOBAL_VIEW_KEY)),
      Effect.flatMap(InsightFeedView, (v) => v.get(GLOBAL_VIEW_KEY)),
    ]),
  );
  const knownEnvs = Option.getOrUndefined(nowOpt)?.environments ?? {};
  const knownRules = Option.getOrUndefined(feedOpt)?.watchRules ?? [];
  await runEffect(
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      for (const app of config.apps) {
        for (const [envId, envCfg] of Object.entries(app.environments)) {
          const envKey = `${app.id}:${envId}`;
          if (knownEnvs[envKey]) continue;
          const snap = seedSnapshots.find((s) => s.envKey === envKey);
          const region = envCfg.region ?? "us-east-1";
          yield* catalog.send(
            GLOBAL_CATALOG_ID,
            new RegisterEnvironment({
              env: {
                envKey,
                appId: app.id,
                envId,
                displayName: `${app.name ?? app.id} (${envId})`,
                tags: { ...app.tags, env: envId, region },
                region,
                // Until something is collected, coverage is unknown, not healthy.
                coverage: snap?.coverage ?? "unconfigured",
                coverageDetail: snap?.coverageDetail ?? "Waiting for first collection",
                latestCommitSha: snap?.builds[0]?.commitSha,
                latestBuildNumber: snap?.builds[0]?.buildNumber,
                lastCollectedAtMs: snap?.sampledAtMs,
              },
            }),
            { commandId: `register-env:${envKey}` },
          );
        }
      }

      for (const rule of config.watchRules ?? []) {
        const desired = {
          ruleId: rule.id as WatchRuleId,
          name: rule.name,
          appId: rule.appId,
          envId: rule.envId,
          metric: rule.metric,
          operator: rule.operator,
          threshold: rule.threshold,
          hysteresisCount: rule.hysteresisCount,
          severity: rule.severity,
          enabled: true,
        };
        const existing = knownRules.find((r) => r.ruleId === rule.id);
        const unchanged =
          existing !== undefined &&
          (Object.keys(desired) as Array<keyof typeof desired>).every((k) => existing[k] === desired[k]);
        if (unchanged) continue;
        const digest = crypto.createHash("sha256").update(JSON.stringify(desired)).digest("hex").slice(0, 12);
        yield* catalog.send(GLOBAL_CATALOG_ID, new UpsertWatchRule({ rule: desired }), {
          commandId: `rule:${rule.id}:${digest}`,
        });
      }
    }),
  );
}

export async function startOverwatchDaemon(options: OverwatchDaemonOptions): Promise<OverwatchDaemon> {
  const { config } = options;
  const mode = config.mode ?? "demo";
  const serviceUrl = config.opencode.serviceUrl ?? "http://127.0.0.1:4096";
  const inMemory = options.dbPath === ":memory:";

  if (!inMemory) fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });

  const sqlite = makeSqlitePlatformLayer({ dbPath: options.dbPath });
  const telemetry = new TelemetryStore(sqlite.db);

  const externalsLayer = Layer.mergeAll(
    makeOpenCodeExternalLayer({ serviceUrl, mode }),
    mode === "live" ? GitHubLiveLayer : makeDemoGitHubLayer(),
    options.silentNotifications || mode === "demo" ? SilentNotifierLive : MacOsNotifierLive,
  );
  const modelLayer = OverwatchModel.layer(OverwatchHandlersLive).pipe(
    Layer.provide(externalsLayer),
    Layer.provide(sqlite.layer),
  );
  const runtime = ManagedRuntime.make(modelLayer);
  const runEffect: RunEffect = (effect) => runtime.runPromise(effect as any) as Promise<any>;

  const events = new EventHub();
  const ctx: DaemonContext = {
    config,
    mode,
    serviceUrl,
    worktreeRoot:
      options.worktreeRoot ??
      path.join(inMemory ? os.tmpdir() : path.dirname(options.dbPath), "overwatch-worktrees"),
    telemetry,
    events,
    runEffect,
    now: Date.now,
  };

  // First boot on an empty store: register the catalog, and in demo mode load the demo story.
  // Live mode never receives demo telemetry or demo incidents.
  const existingNow = Option.getOrUndefined(
    await runEffect(Effect.flatMap(NowView, (v) => v.get(GLOBAL_VIEW_KEY))),
  );
  const firstBoot = !existingNow || Object.keys(existingNow.environments).length === 0;
  const bootMs = ctx.now();
  const demoSnapshots = firstBoot && mode === "demo" ? seedDemoTelemetry(ctx, bootMs) : [];
  await reconcileCatalog(ctx, demoSnapshots);
  if (firstBoot && mode === "demo") await seedDemoScenario(ctx, bootMs);

  // Detection notifications are the product, so they are native in demo mode too.
  const notifierLayer = options.silentNotifications ? SilentNotifierLive : MacOsNotifierLive;
  const notify = (notification: OperatorNotification): Promise<void> =>
    Effect.runPromise(
      Effect.flatMap(NotifierExternal, (n) => n.notifyOperator(notification)).pipe(
        Effect.provide(notifierLayer),
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      ),
    );

  const simulator = new DemoSimulator();
  const monitor = new Monitor(ctx, makeCollector(ctx, simulator), notify, {
    cadenceOverrideSeconds: options.cadenceOverrideSeconds,
  });

  const handleWake = async (wake: WakeEvent) => {
    await runEffect(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        yield* catalog.send(
          GLOBAL_CATALOG_ID,
          new RecordHostWake({ sleptAtMs: wake.sleptAtMs, wokeAtMs: wake.wokeAtMs, gapMs: wake.gapMs }),
        );
        if (mode === "demo" && wake.tier === "overnight") {
          const evId = `ev_wake_${wake.wokeAtMs}` as EvidenceId;
          telemetry.putEvidence({
            evidenceId: evId,
            source: "datadog",
            envKey: "billing-worker:prod",
            title: "Coarse overnight rollup scan (15m buckets)",
            query: "rollup(avg:trace.request.p95, 900) over sleep window",
            deepLink: "https://app.datadoghq.com/apm/service/billing-worker?env=prod",
            capturedAtMs: wake.wokeAtMs,
            excerpt:
              "Transient 11m p95 spike (1420ms) occurred overnight while Mac was asleep and self-healed before wake. Recorded as historical insight without paging.",
          });
          yield* catalog
            .send(
              GLOBAL_CATALOG_ID,
              new RecordInsight({
                insightId: `ins-wake-${wake.wokeAtMs}` as InsightId,
                appId: "billing-worker",
                envId: "prod",
                claim: "Overnight 11m p95 spike (1.42s) healed before wake; no page fired",
                whyItMatters: "Correlated with nightly DB vacuum window; consider scheduling offset.",
                recurrenceCount: 1,
                evidenceIds: [evId],
                sourceMode: "overnight_spike",
              }),
            )
            .pipe(Effect.catch(() => Effect.void));
        }
      }),
    );
    events.publish("host.woke", `${wake.tier} (${Math.round(wake.gapMs / 60_000)}m)`);
    // Collect once straight away: health is judged on post-wake data, never on what was true
    // before the lid closed.
    if (monitor.status().running) void monitor.sweepAll("wake");
  };

  const wakeCoordinator = new WakeCoordinator(handleWake, { settleBarrierMs: 0 });
  if (options.enableBackgroundTimers !== false) {
    wakeCoordinator.start();
    monitor.start();
  }

  const getFullState = async (): Promise<Record<string, unknown>> => {
    const [now, needsMe, insights, runs, scorecard, briefs] = await runEffect(
      Effect.all([
        Effect.flatMap(NowView, (v) => v.get(GLOBAL_VIEW_KEY)),
        Effect.flatMap(NeedsMeView, (v) => v.get(GLOBAL_VIEW_KEY)),
        Effect.flatMap(InsightFeedView, (v) => v.get(GLOBAL_VIEW_KEY)),
        Effect.flatMap(RunListView, (v) => v.get(GLOBAL_VIEW_KEY)),
        Effect.flatMap(ScorecardView, (v) => v.get(GLOBAL_VIEW_KEY)),
        Effect.flatMap(BriefListView, (v) => v.get(GLOBAL_VIEW_KEY)),
      ]),
    );

    const nowVal = Option.getOrUndefined(now) ?? {
      environments: {},
      incidents: {},
      pendingAsks: {},
      activeRuns: {},
      actions: {},
      activeInsightCount: 0,
      watchRuleCount: 0,
      dailySpendUsd: 0,
      wakeCount: 0,
    };

    const incidentDetails: Record<string, unknown> = {};
    for (const id of Object.keys(nowVal.incidents)) {
      const detail = Option.getOrUndefined(
        await runEffect(Effect.flatMap(IncidentDetailView, (v) => v.get(Incident.ref(id as IncidentId)))),
      );
      if (detail) incidentDetails[id] = detail;
    }

    const snapshots = telemetry.listEnvironmentSnapshots();
    const sampledAt = new Map(snapshots.map((s) => [s.envKey, s.sampledAtMs]));
    // Freshness comes from the telemetry store: collections are not domain events.
    const environments = Object.fromEntries(
      Object.entries(nowVal.environments).map(([envKey, env]) => [
        envKey,
        { ...env, lastCollectedAtMs: sampledAt.get(envKey) ?? env.lastCollectedAtMs },
      ]),
    );
    const monitorStatus: MonitorStatus = monitor.status();

    return {
      cursor: events.cursor,
      mode,
      serviceUrl,
      dailyUsdCap: config.budgets.dailyUsdCap,
      now: { ...nowVal, environments },
      needsMe: Option.getOrUndefined(needsMe) ?? { pending: [], recent: [] },
      insights: Option.getOrUndefined(insights) ?? { insights: [], watchRules: [] },
      runs: Option.getOrUndefined(runs) ?? { runs: [] },
      scorecard: Option.getOrUndefined(scorecard) ?? {
        verdicts: [],
        proposals: [],
        feedbackUp: 0,
        feedbackDown: 0,
        incidentsOpened: 0,
        incidentsDismissed: 0,
        totalSpendUsd: 0,
        calibrationAgreementPct: 100,
      },
      briefs: Option.getOrUndefined(briefs) ?? { briefs: [] },
      incidentDetails,
      telemetry: Object.fromEntries(snapshots.map((s) => [s.envKey, s])),
      evidence: Object.fromEntries(telemetry.listEvidence().map((e) => [e.evidenceId, e])),
      frontier: telemetry.listExplorationFrontier(),
      monitor: monitorStatus,
    };
  };

  const intents = makeIntentHandlers({ ctx, monitor, simulator, handleWake });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });

  const webRoot = options.webDistDir ?? path.resolve(import.meta.dir, "../../web/public");
  let guard: ReturnType<typeof makeRequestGuard> | undefined;

  const streamResponse = (after: number): Response => {
    const encoder = new TextEncoder();
    let cleanup: (() => void) | undefined;
    const stream = new ReadableStream({
      start(controller) {
        const send = (event: StreamEvent) =>
          controller.enqueue(
            encoder.encode(`id: ${event.cursor}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`),
          );
        // `connected` goes first so a client knows whether its cursor is still replayable.
        controller.enqueue(
          encoder.encode(
            `event: connected\ndata: ${JSON.stringify({
              cursor: events.cursor,
              oldestCursor: events.oldestCursor,
              mode,
            })}\n\n`,
          ),
        );
        for (const event of events.replayAfter(after)) send(event);
        const unsubscribe = events.subscribe(send);
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
          } catch {
            clearInterval(keepalive);
          }
        }, 20_000);
        cleanup = () => {
          clearInterval(keepalive);
          unsubscribe();
        };
      },
      cancel() {
        cleanup?.();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  };

  const server = Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? 4720,
    idleTimeout: 120,
    async fetch(req) {
      const verdict = guard?.(req) ?? { ok: false as const, status: 503, reason: "Starting" };
      if (!verdict.ok) return json({ error: verdict.reason }, verdict.status);

      const url = new URL(req.url);
      const pathname = url.pathname;

      try {
        if (req.method === "POST") {
          if (!pathname.startsWith("/api/intents/")) return json({ error: "Not found" }, 404);
          const name = pathname.slice("/api/intents/".length);
          const handler = Object.hasOwn(intents, name) ? intents[name] : undefined;
          if (!handler) return json({ error: `Unknown intent: ${name}` }, 404);
          const body = (await req.json().catch(() => undefined)) as unknown;
          if (body === null || typeof body !== "object" || Array.isArray(body)) {
            return json({ error: "Intent body must be a JSON object" }, 400);
          }
          const input = body as Record<string, unknown>;
          const commandId =
            typeof input.commandId === "string" && input.commandId.length > 0
              ? input.commandId
              : crypto.randomUUID();
          const receipt = await handler(input, commandId);
          return json({ ok: true, ...receipt, cursor: events.cursor });
        }

        if (pathname === "/health") {
          return json({ ok: true, mode, cursor: events.cursor, opencodeServiceUrl: serviceUrl, nowMs: Date.now() });
        }
        if (pathname === "/openapi.json") return json(buildOpenApiDocument());
        if (pathname === "/api/state") return json(await getFullState());
        if (pathname === "/api/views/now") {
          const state = await getFullState();
          return json({ cursor: state.cursor, now: state.now, telemetry: state.telemetry });
        }
        if (pathname === "/api/monitor") return json(monitor.status());
        if (pathname.startsWith("/api/evidence/")) {
          const blob = telemetry.getEvidence(decodeURIComponent(pathname.slice("/api/evidence/".length)));
          return blob ? json(blob) : json({ error: "Evidence not found" }, 404);
        }
        if (pathname.startsWith("/api/handoff/")) {
          const sessionId = decodeURIComponent(pathname.slice("/api/handoff/".length));
          const dir = url.searchParams.get("dir") ?? config.apps[0]?.repoPath ?? process.cwd();
          return json(buildSessionHandoff({ serviceUrl, sessionId, locationDir: dir }));
        }
        if (pathname === "/api/stream") {
          return streamResponse(Number(url.searchParams.get("after") ?? "0") || 0);
        }
        if (pathname.startsWith("/api/")) return json({ error: "Not found", path: pathname }, 404);

        const candidate = resolveStaticPath(webRoot, pathname, path.sep);
        if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const ext = path.extname(candidate).toLowerCase();
          return new Response(Bun.file(candidate), {
            headers: {
              "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
              "x-content-type-options": "nosniff",
              // Revalidate on every load so an upgraded daemon never runs against a stale UI.
              "cache-control": "no-cache",
            },
          });
        }
        const fallbackIndex = path.join(webRoot, "index.html");
        if (candidate && !path.extname(candidate) && fs.existsSync(fallbackIndex)) {
          return new Response(Bun.file(fallbackIndex), {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
          });
        }
        return json({ error: "Not found", path: pathname }, 404);
      } catch (err) {
        if (err instanceof IntentError) return json({ error: err.message }, err.status);
        // Domain rejections (budget exceeded, already resolved, not found) are the caller's to fix.
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, 422);
      }
    },
  });

  const boundPort = server.port ?? options.port ?? 4720;
  const host = options.host ?? "127.0.0.1";
  guard = makeRequestGuard({ port: boundPort, allowedHosts: options.allowedHosts });

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    telemetry,
    monitor,
    getOpenApiDocument: buildOpenApiDocument,
    getFullState,
    stop: async () => {
      monitor.stop();
      wakeCoordinator.stop();
      server.stop(true);
      await runtime.dispose();
      await Effect.runPromise(sqlite.close);
    },
  };
}
