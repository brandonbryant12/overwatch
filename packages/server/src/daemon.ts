import * as fs from "node:fs";
import * as path from "node:path";
import * as DomainHttp from "@alchemy.run/domain/Http";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import {
  Action,
  ActionId,
  AnswerAsk,
  ApproveBrief,
  Ask,
  AskId,
  AssignRunSession,
  AttachSignal,
  Brief,
  BriefId,
  BriefKind,
  BriefListView,
  Catalog,
  CompleteRun,
  DecideProposal,
  DismissIncident,
  DismissInsight,
  EditBriefDraft,
  EnterWatching,
  EvidenceId,
  FeedbackReason,
  GLOBAL_CATALOG_ID,
  GLOBAL_VIEW_KEY,
  Incident,
  IncidentDetailView,
  IncidentId,
  InsightFeedView,
  InsightId,
  LinkRunToIncident,
  MarkBriefSent,
  NeedsMeView,
  NowView,
  OpenIncident,
  OperatorApi,
  OverwatchHandlersLive,
  OverwatchModel,
  PostIncidentChat,
  PromoteInsightToIncident,
  PromoteInsightToWatch,
  RecordCleanWindow,
  RecordFinding,
  RecordHostWake,
  RecordIncidentFeedback,
  RecordInsight,
  RecordProposal,
  RecordRollout,
  RecordRunUsage,
  RecordVerdict,
  RecordVerificationBundle,
  RegisterEnvironment,
  RequestAction,
  ResolveIncident,
  Run,
  RunId,
  RunListView,
  SaveBriefDraft,
  ScorecardView,
  ScoreRun,
  StartRun,
  UpdateConnectorCoverage,
  UpdateUnderstanding,
  UpsertWatchRule,
  WatchRuleId,
  type OverwatchConfig,
} from "@overwatch/domain";
import {
  collectJenkinsBuilds,
  collectKubernetes,
  generateDemoFleetSnapshots,
  GitHubLiveLayer,
  LocalSecretVaultLive,
  MacOsNotifierLive,
  makeDemoGitHubLayer,
  probeDatadog,
  SilentNotifierLive,
  type EnvironmentTelemetrySnapshot,
} from "@overwatch/connectors";
import { makeSqlitePlatformLayer } from "@overwatch/sqlite-platform";
import {
  buildSessionHandoff,
  compileSessionPermissions,
  createOpenCodeSessionId,
  type SessionHandoffDescriptor,
} from "./opencode-bridge.ts";
import { makeOpenCodeExternalLayer } from "./opencode-bridge.ts";
import { TelemetryStore } from "./telemetry-store.ts";
import { WakeCoordinator, type WakeEvent } from "./wake-coordinator.ts";

export interface StreamEvent {
  readonly cursor: number;
  readonly kind: string;
  readonly detail: string;
  readonly atMs: number;
}

export interface OverwatchDaemonOptions {
  readonly config: OverwatchConfig;
  readonly dbPath: string;
  readonly host?: string;
  readonly port?: number;
  readonly webDistDir?: string;
  readonly silentNotifications?: boolean;
  readonly enableBackgroundTimers?: boolean;
}

export interface OverwatchDaemon {
  readonly url: string;
  readonly port: number;
  readonly telemetry: TelemetryStore;
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

export async function startOverwatchDaemon(
  options: OverwatchDaemonOptions,
): Promise<OverwatchDaemon> {
  const { config } = options;
  const mode = config.mode ?? "demo";
  const serviceUrl = config.opencode.serviceUrl ?? "http://127.0.0.1:4096";

  if (options.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
  }

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
  const runEffect = <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> =>
    runtime.runPromise(eff as any);

  // Resumable SSE ring buffer + live subscribers
  let cursorSeq = 0;
  const eventHistory: StreamEvent[] = [];
  const sseSubscribers = new Set<(ev: StreamEvent) => void>();

  const publishEvent = (kind: string, detail: string): StreamEvent => {
    const ev: StreamEvent = {
      cursor: ++cursorSeq,
      kind,
      detail,
      atMs: Date.now(),
    };
    eventHistory.push(ev);
    if (eventHistory.length > 200) eventHistory.shift();
    for (const sub of sseSubscribers) {
      try {
        sub(ev);
      } catch {
        // ignore closed streams
      }
    }
    return ev;
  };

  // Seed catalog & rich demo scenario once on fresh DB
  const seedInitialState = async () => {
    const existingNow = await runEffect(
      Effect.gen(function* () {
        const nv = yield* NowView;
        return Option.getOrUndefined(yield* nv.get(GLOBAL_VIEW_KEY));
      }),
    );

    const hasEnvs = existingNow && Object.keys(existingNow.environments).length > 0;
    const nowMs = Date.now();

    if (!hasEnvs) {
      const demo = generateDemoFleetSnapshots(nowMs);
      for (const blob of demo.evidence) {
        telemetry.putEvidence(blob);
      }
      for (const snap of demo.snapshots) {
        telemetry.saveEnvironmentSnapshot(snap);
      }

      await runEffect(
        Effect.gen(function* () {
          const catalog = yield* Catalog;
          const incidents = yield* Incident;
          const runs = yield* Run;
          const actions = yield* Action;
          const briefs = yield* Brief;

          // Register all configured apps & environments
          for (const app of config.apps) {
            for (const [envId, envCfg] of Object.entries(app.environments)) {
              const envKey = `${app.id}:${envId}`;
              const snap = demo.snapshots.find((s) => s.envKey === envKey);
              yield* catalog.send(
                GLOBAL_CATALOG_ID,
                new RegisterEnvironment({
                  env: {
                    envKey,
                    appId: app.id,
                    envId,
                    displayName: `${app.name ?? app.id} (${envId})`,
                    tags: { ...app.tags, env: envId, region: envCfg.region ?? "us-east-1" },
                    region: envCfg.region ?? "us-east-1",
                    coverage: snap?.coverage ?? "healthy",
                    coverageDetail: snap?.coverageDetail ?? "Initialized",
                    latestCommitSha: snap?.builds[0]?.commitSha,
                    latestBuildNumber: snap?.builds[0]?.buildNumber,
                    lastCollectedAtMs: snap?.sampledAtMs ?? nowMs,
                  },
                }),
                { commandId: `seed-env-${envKey}` },
              );
            }
          }

          for (const rule of config.watchRules ?? []) {
            yield* catalog.send(
              GLOBAL_CATALOG_ID,
              new UpsertWatchRule({
                rule: {
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
                },
              }),
              { commandId: `seed-rule-${rule.id}` },
            );
          }

          if (mode === "demo") {
            // Active Rollout Watch on checkout-api:prod
            yield* catalog.send(
              GLOBAL_CATALOG_ID,
              new RecordRollout({
                envKey: "checkout-api:prod",
                rolloutId: "rollout-482",
                commitSha: "9f31c2a",
                buildNumber: 482,
                watchDurationMs: 30 * 60_000,
              }),
              { commandId: "seed-rollout-482" },
            );

            // Primary active incident INC-42 with two correlated signals
            const incId = "INC-42" as IncidentId;
            yield* incidents
              .send(
                incId,
                new OpenIncident({
                  appId: "checkout-api",
                  envId: "prod",
                  headline: "checkout-api prod p95 latency jumped 0.89s -> 2.15s (+141%)",
                  severity: "page",
                  rolloutId: "rollout-482",
                  commitSha: "9f31c2a",
                  tags: { team: "payments", tier: "critical", env: "prod" },
                  recoveryTargetK: 3,
                  signal: {
                    signalId: "sig-42-p95",
                    watchRuleId: "rule-checkout-p95",
                    fingerprint: "fp:checkout-api:prod:p95",
                    summary: "p95 latency 2150ms exceeded 1200ms threshold after build #482",
                    severity: "page",
                    evidenceId: "ev_dd_p95_482" as EvidenceId,
                    observedAtMs: nowMs - 11 * 60_000,
                  },
                }),
                { commandId: "seed-inc-42" },
              )
              .pipe(Effect.catch(() => Effect.void));

            yield* incidents
              .send(
                incId,
                new AttachSignal({
                  signal: {
                    signalId: "sig-42-5xx",
                    watchRuleId: "rule-checkout-5xx",
                    fingerprint: "fp:checkout-api:prod:5xx",
                    summary: "5xx rate rose 0.14% -> 1.84% (upstream timeout on rev-482 pods)",
                    severity: "page",
                    evidenceId: "ev_dd_p95_482" as EvidenceId,
                    observedAtMs: nowMs - 10 * 60_000,
                  },
                }),
                { commandId: "seed-inc-42-sig2" },
              )
              .pipe(Effect.catch(() => Effect.void));

            yield* incidents
              .send(
                incId,
                new UpdateUnderstanding({
                  bullets: [
                    {
                      text: "Regression isolated 100% to rev-482 pods (commit 9f31c2a); rev-481 pods remain at 0.88s p95.",
                      evidenceIds: ["ev_k8s_rev_482" as EvidenceId, "ev_jk_482" as EvidenceId],
                    },
                    {
                      text: "Paired trace diff shows cart_line_items pg.query firing 46x per request vs 2x baseline (+1563ms).",
                      evidenceIds: ["ev_trace_diff_482" as EvidenceId],
                    },
                    {
                      text: "Local worktree fix batched promo lookup; bun test checkout dropped 890ms -> 42ms.",
                      evidenceIds: ["ev_jk_482" as EvidenceId],
                    },
                  ],
                }),
                { commandId: "seed-inc-42-understanding" },
              )
              .pipe(Effect.catch(() => Effect.void));

            yield* incidents
              .send(
                incId,
                new RecordFinding({
                  findingId: "find-42-root",
                  kind: "root_cause",
                  summary:
                    "Commit 9f31c2a moved promo tier lookup inside cart item loop, causing 46x sequential pg.query fan-out on rev-482.",
                  confidence: 0.94,
                  evidenceIds: ["ev_trace_diff_482" as EvidenceId, "ev_jk_482" as EvidenceId],
                  runId: "run-triage-42" as RunId,
                }),
                { commandId: "seed-inc-42-finding" },
              )
              .pipe(Effect.catch(() => Effect.void));

            yield* incidents
              .send(
                incId,
                new RecordVerificationBundle({
                  bundle: {
                    runId: "run-fix-42" as RunId,
                    reproducedLocally: true,
                    commandsRun: ["bun run typecheck", "bun test checkout/confirm.test.ts"],
                    exitCodes: [0, 0],
                    beforeAfterSummary: "46 queries / 890ms -> 1 batched IN query / 42ms",
                    diffStat: "2 files changed, 34 insertions(+), 12 deletions(-)",
                    unknowns: ["Production recovery still requires 3 clean post-deploy windows."],
                    worktreePath: "/Users/brandon/.local/share/overwatch/worktrees/checkout-api/inc-42",
                    branch: "overwatch/inc-42-batch-promo-query",
                  },
                }),
                { commandId: "seed-inc-42-verify" },
              )
              .pipe(Effect.catch(() => Effect.void));

            yield* incidents
              .send(
                incId,
                new PostIncidentChat({
                  id: "chat-42-1",
                  author: "operator",
                  text: "Is this happening on the old ReplicaSet pods too?",
                  delivery: "steer",
                }),
                { commandId: "seed-inc-42-chat1" },
              )
              .pipe(Effect.catch(() => Effect.void));

            yield* incidents
              .send(
                incId,
                new PostIncidentChat({
                  id: "chat-42-2",
                  author: "agent",
                  text: "No. Old rev-481 pod (4c88e1b-3a1e) is steady at 0.88s p95 with 0 restarts. Both rev-482 pods (9f31c2a) sit at 2.15s p95 and 840m+ CPU.",
                  delivery: "reply",
                  evidenceIds: ["ev_k8s_rev_482" as EvidenceId, "ev_trace_diff_482" as EvidenceId],
                }),
                { commandId: "seed-inc-42-chat2" },
              )
              .pipe(Effect.catch(() => Effect.void));

            // Seed completed Triage run + active Fix run with ses_ IDs
            const triageRunId = "run-triage-42" as RunId;
            yield* runs
              .send(
                triageRunId,
                new StartRun({
                  role: "triage",
                  trigger: "signal",
                  appId: "checkout-api",
                  envId: "prod",
                  incidentId: incId,
                  model: config.opencode.models?.triage ?? "claude-haiku-4-5",
                  budget: { maxAwakeMs: 120_000, maxConnectorCalls: 12, maxTotalToolCalls: 24, maxUsd: 0.75 },
                }),
                { commandId: "seed-run-triage-42" },
              )
              .pipe(Effect.catch(() => Effect.void));
            yield* runs
              .send(
                triageRunId,
                new AssignRunSession({ sessionId: "ses_overwatch_triage_42" }),
                { commandId: "seed-run-triage-42-ses" },
              )
              .pipe(Effect.catch(() => Effect.void));
            yield* runs
              .send(
                triageRunId,
                new RecordRunUsage({
                  connectorCallsDelta: 6,
                  toolCallsDelta: 11,
                  usdDelta: 0.14,
                  awakeDeltaMs: 38_000,
                }),
                { commandId: "seed-run-triage-42-use" },
              )
              .pipe(Effect.catch(() => Effect.void));
            yield* runs
              .send(
                triageRunId,
                new CompleteRun({ summary: "Isolated N+1 query regression to build #482 (9f31c2a)." }),
                { commandId: "seed-run-triage-42-done" },
              )
              .pipe(Effect.catch(() => Effect.void));
            yield* runs
              .send(triageRunId, new ScoreRun({ score: 96 }), { commandId: "seed-run-triage-42-score" })
              .pipe(Effect.catch(() => Effect.void));

            const fixRunId = "run-fix-42" as RunId;
            yield* runs
              .send(
                fixRunId,
                new StartRun({
                  role: "fix",
                  trigger: "intent",
                  appId: "checkout-api",
                  envId: "prod",
                  incidentId: incId,
                  model: config.opencode.models?.fixer ?? "claude-sonnet-4-5",
                  budget: { maxAwakeMs: 600_000, maxConnectorCalls: 15, maxTotalToolCalls: 50, maxUsd: 3.0 },
                }),
                { commandId: "seed-run-fix-42" },
              )
              .pipe(Effect.catch(() => Effect.void));
            yield* runs
              .send(
                fixRunId,
                new AssignRunSession({
                  sessionId: "ses_overwatch_fix_42",
                  worktreePath: "/Users/brandon/.local/share/overwatch/worktrees/checkout-api/inc-42",
                }),
                { commandId: "seed-run-fix-42-ses" },
              )
              .pipe(Effect.catch(() => Effect.void));
            yield* runs
              .send(
                fixRunId,
                new RecordRunUsage({
                  connectorCallsDelta: 4,
                  toolCallsDelta: 18,
                  usdDelta: 0.62,
                  awakeDeltaMs: 142_000,
                }),
                { commandId: "seed-run-fix-42-use" },
              )
              .pipe(Effect.catch(() => Effect.void));

            yield* incidents
              .send(incId, new LinkRunToIncident({ runId: triageRunId }), { commandId: "seed-link-r1" })
              .pipe(Effect.catch(() => Effect.void));
            yield* incidents
              .send(incId, new LinkRunToIncident({ runId: fixRunId }), { commandId: "seed-link-r2" })
              .pipe(Effect.catch(() => Effect.void));

            // Propose-gated Draft PR action -> Policy automatically opens a Needs Me Ask!
            yield* actions
              .send(
                "act-pr-42" as ActionId,
                new RequestAction({
                  kind: "open_draft_pr",
                  appId: "checkout-api",
                  envId: "prod",
                  repo: "brandonbryant12/overwatch",
                  title: "Batch promo tier lookup in checkout confirm (INC-42)",
                  body: "Replaces per-item pg.query loop with single IN query. Verified locally (42ms vs 890ms).",
                  branch: "overwatch/inc-42-batch-promo-query",
                  baseBranch: "main",
                  worktreePath: "/Users/brandon/.local/share/overwatch/worktrees/checkout-api/inc-42",
                  evidenceIds: ["ev_trace_diff_482" as EvidenceId, "ev_jk_482" as EvidenceId],
                  incidentId: incId,
                  runId: fixRunId,
                  autonomy: "propose",
                }),
                { commandId: "seed-act-pr-42" },
              )
              .pipe(Effect.catch(() => Effect.void));

            // Seed Proactive Insights from overnight trace walks
            yield* catalog.send(
              GLOBAL_CATALOG_ID,
              new RecordInsight({
                insightId: "ins-billing-n1" as InsightId,
                appId: "billing-worker",
                envId: "prod",
                claim: "invoice.reconcile_batch executes sequential SELECT per line (+34% p95 WoW)",
                whyItMatters: "Batch jobs approach 2s SLA during month-end invoicing spikes.",
                recurrenceCount: 14,
                evidenceIds: ["ev_explore_billing_n1" as EvidenceId],
                sourceMode: "trace_walk",
              }),
              { commandId: "seed-ins-1" },
            );

            yield* catalog.send(
              GLOBAL_CATALOG_ID,
              new RecordInsight({
                insightId: "ins-ledger-mem" as InsightId,
                appId: "ledger-ingest",
                envId: "prod",
                claim: "ledger-ingest working set climbed +38% over 7d with flat RPS",
                whyItMatters: "At current slope, pod hits 1536 MiB OOM limit in ~9 days.",
                recurrenceCount: 7,
                evidenceIds: ["ev_explore_redis_drift" as EvidenceId],
                sourceMode: "resource_drift",
              }),
              { commandId: "seed-ins-2" },
            );

            // Seed cross-model Judge Verdict & weekly Proposal
            yield* catalog.send(
              GLOBAL_CATALOG_ID,
              new RecordVerdict({
                verdict: {
                  verdictId: "verd-42-triage",
                  runId: triageRunId,
                  judgeModel: config.opencode.models?.judge ?? "gemini-2.5-pro",
                  grounded: true,
                  concise: true,
                  actionable: true,
                  severityCalibrated: true,
                  scopeDisciplined: true,
                  score: 96,
                  operatorAgreed: true,
                  recordedAtMs: nowMs - 8 * 60_000,
                },
              }),
              { commandId: "seed-verdict-1" },
            );

            yield* catalog.send(
              GLOBAL_CATALOG_ID,
              new RecordProposal({
                proposal: {
                  proposalId: "prop-checkout-playbook-1",
                  title: "Add ReplicaSet revision check to checkout-api playbook",
                  targetPath: "agents/playbooks/checkout-api.md",
                  rationale:
                    "Operators asked to compare old vs new ReplicaSet latency on 3 consecutive deploy regressions. Checking revision split first saves ~45s in triage.",
                  diffPreview:
                    "@@ -8,2 +8,6 @@\n ## Rollout Triage Order\n 1. Compare p95 by pod revision tag before inspecting Stripe downstream latency.\n+2. Always check cart_line_items pg.query fan-out count when build touches promo evaluation.",
                  beforeReplayScore: 84,
                  afterReplayScore: 95,
                  status: "pending",
                  createdAtMs: nowMs - 2 * 3600_000,
                },
              }),
              { commandId: "seed-prop-1" },
            );

            // Seed initial Stakeholder & Daily Brief drafts
            yield* briefs
              .send(
                "brief-inc-42-stakeholder" as BriefId,
                new SaveBriefDraft({
                  kind: "stakeholder_update",
                  incidentId: incId,
                  subject: "Checkout latency elevated after deploy #482",
                  body: "Checkout confirmation latency increased from 0.9s to 2.1s following deploy #482, causing 1.8% failed requests. Root cause is isolated to a new database query loop; a verified patch is ready for draft PR approval. Next update in 20 minutes or upon deployment recovery.",
                  recipients: ["eng-leads@example.com", "support-ops@example.com"],
                }),
                { commandId: "seed-brief-1" },
              )
              .pipe(Effect.catch(() => Effect.void));
          }
        }),
      );

      // Record initial exploration frontier rows
      telemetry.recordExploration({
        envKey: "checkout-api:prod",
        route: "POST /v1/checkout/confirm",
        mode: "trace_walk",
        priorityScore: 94.2,
        outcome: "attached_to_INC-42",
        atMs: nowMs - 10 * 60_000,
      });
      telemetry.recordExploration({
        envKey: "billing-worker:prod",
        route: "JOB invoice.reconcile_batch",
        mode: "trace_walk",
        priorityScore: 76.8,
        outcome: "insight_recorded",
        atMs: nowMs - 3 * 3600_000,
      });
      telemetry.recordExploration({
        envKey: "identity-edge:prod",
        route: "POST /oauth2/token",
        mode: "trace_walk",
        priorityScore: 18.4,
        outcome: "inconclusive_healthy",
        atMs: nowMs - 6 * 3600_000,
      });
    }
  };

  await seedInitialState();

  // Wait briefly on first-ever cold boot so multi-source views finish backfill
  await runEffect(
    Effect.gen(function* () {
      const nv = yield* NowView;
      yield* nv.get(GLOBAL_VIEW_KEY);
    }),
  );

  const collectEnvironment = async (envKey: string): Promise<EnvironmentTelemetrySnapshot | undefined> => {
    const [appId, envId] = envKey.split(":");
    const app = config.apps.find((a) => a.id === appId);
    const envCfg = app?.environments[envId ?? ""];
    if (!app || !envCfg || !appId || !envId) return undefined;

    const nowMs = Date.now();
    if (mode === "live") {
      const k8s = envCfg.kubernetes
        ? await collectKubernetes(envCfg.kubernetes)
        : {
            probe: { connector: "kubernetes" as const, coverage: "unconfigured" as const, detail: "Not configured", checkedAtMs: nowMs },
            pods: [],
            warningEvents: [],
          };
      const ddProbe = envCfg.datadog
        ? await Effect.runPromise(probeDatadog(envCfg.datadog).pipe(Effect.provide(LocalSecretVaultLive)))
        : { connector: "datadog" as const, coverage: "unconfigured" as const, detail: "Not configured", checkedAtMs: nowMs };
      const jk = envCfg.jenkins
        ? await Effect.runPromise(collectJenkinsBuilds(envCfg.jenkins).pipe(Effect.provide(LocalSecretVaultLive)))
        : { probe: { connector: "jenkins" as const, coverage: "unconfigured" as const, detail: "Not configured", checkedAtMs: nowMs }, builds: [] };

      const worstCoverage =
        k8s.probe.coverage === "auth_expired" || ddProbe.coverage === "auth_expired"
          ? "auth_expired"
          : k8s.probe.coverage === "unreachable" || ddProbe.coverage === "unreachable"
            ? "unreachable"
            : k8s.probe.coverage === "rate_limited" || ddProbe.coverage === "rate_limited"
              ? "rate_limited"
              : "healthy";

      const prevMetrics = telemetry.getMetricSeries(envKey, 35);
      const snap: EnvironmentTelemetrySnapshot = {
        envKey,
        appId,
        envId,
        coverage: worstCoverage,
        coverageDetail: `${k8s.probe.detail} · ${ddProbe.detail}`,
        remediation: k8s.probe.remediation ?? ddProbe.remediation ?? jk.probe.remediation,
        pods: k8s.pods,
        warningEvents: k8s.warningEvents,
        builds: jk.builds,
        metrics: prevMetrics,
        routeCohorts: [],
        sampledAtMs: nowMs,
      };
      telemetry.saveEnvironmentSnapshot(snap);
      await runEffect(
        Effect.gen(function* () {
          const catalog = yield* Catalog;
          yield* catalog.send(
            GLOBAL_CATALOG_ID,
            new UpdateConnectorCoverage({
              envKey,
              coverage: snap.coverage,
              detail: snap.coverageDetail,
            }),
          );
        }),
      );
      publishEvent("telemetry.collected", envKey);
      return snap;
    }

    // Demo mode: advance fresh metric sample cleanly while honoring coverage state
    const existing = telemetry.getEnvironmentSnapshot(envKey);
    if (!existing) return undefined;
    const last = existing.metrics[existing.metrics.length - 1] ?? {
      tsMs: nowMs - 60_000,
      p50LatencyMs: 120,
      p95LatencyMs: 320,
      errorRatePct: 0.08,
      cpuPct: 32,
      memoryPct: 48,
      rps: 350,
    };
    const jitter = (Math.sin(nowMs / 1000) * 0.05);
    const nextPoint = {
      tsMs: nowMs,
      p50LatencyMs: Math.max(10, Math.round(last.p50LatencyMs * (1 + jitter))),
      p95LatencyMs: Math.max(20, Math.round(last.p95LatencyMs * (1 + jitter))),
      errorRatePct: Number(Math.max(0.01, last.errorRatePct * (1 + jitter)).toFixed(2)),
      cpuPct: Math.min(98, Math.max(5, Math.round(last.cpuPct * (1 + jitter)))),
      memoryPct: Math.min(98, Math.max(10, Math.round(last.memoryPct * (1 + jitter * 0.4)))),
      rps: Math.max(10, Math.round(last.rps * (1 + jitter))),
    };
    const updated: EnvironmentTelemetrySnapshot = {
      ...existing,
      metrics: [...existing.metrics.slice(-59), nextPoint],
      sampledAtMs: nowMs,
    };
    telemetry.saveEnvironmentSnapshot(updated);
    await runEffect(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        yield* catalog.send(
          GLOBAL_CATALOG_ID,
          new UpdateConnectorCoverage({
            envKey,
            coverage: updated.coverage,
            detail: updated.coverageDetail,
          }),
        );
      }),
    );
    publishEvent("telemetry.collected", envKey);
    return updated;
  };

  // Sleep-native WakeCoordinator
  const handleWake = async (wake: WakeEvent) => {
    await runEffect(
      Effect.gen(function* () {
        const catalog = yield* Catalog;
        yield* catalog.send(
          GLOBAL_CATALOG_ID,
          new RecordHostWake({
            sleptAtMs: wake.sleptAtMs,
            wokeAtMs: wake.wokeAtMs,
            gapMs: wake.gapMs,
          }),
        );
        if (wake.tier === "overnight") {
          const evId = `ev_wake_${wake.wokeAtMs}` as EvidenceId;
          telemetry.putEvidence({
            evidenceId: evId,
            source: "datadog",
            envKey: "billing-worker:prod",
            title: "Coarse overnight rollup scan (15m buckets)",
            query: "rollup(avg:trace.request.p95, 900) over sleep window",
            deepLink: "https://app.datadoghq.com/apm/service/billing-worker?env=prod",
            capturedAtMs: wake.wokeAtMs,
            excerpt: `Transient 11m p95 spike (1420ms) occurred overnight while Mac was asleep and self-healed before wake. Recorded as historical insight without paging.`,
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
    publishEvent("host.woke", `${wake.tier} (${Math.round(wake.gapMs / 60_000)}m)`);
  };

  const wakeCoordinator = new WakeCoordinator(handleWake, { settleBarrierMs: 0 });
  if (options.enableBackgroundTimers !== false) {
    wakeCoordinator.start();
  }

  // Read full projected state (zero business logic in clients!)
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
      const det = await runEffect(
        Effect.flatMap(IncidentDetailView, (v) => v.get(Incident.ref(id as IncidentId))),
      );
      const val = Option.getOrUndefined(det);
      if (val) incidentDetails[id] = val;
    }

    const snapshots = telemetry.listEnvironmentSnapshots();
    const evidence = telemetry.listEvidence();
    const frontier = telemetry.listExplorationFrontier();

    return {
      cursor: cursorSeq,
      mode,
      serviceUrl,
      dailyUsdCap: config.budgets.dailyUsdCap,
      now: nowVal,
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
      evidence: Object.fromEntries(evidence.map((e) => [e.evidenceId, e])),
      frontier,
    };
  };

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    });

  const webRoot =
    options.webDistDir ?? path.resolve(import.meta.dir, "../../web/public");

  const server = Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? 4720,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });
      }

      try {
        if (pathname === "/health") {
          return json({
            ok: true,
            mode,
            cursor: cursorSeq,
            opencodeServiceUrl: serviceUrl,
            nowMs: Date.now(),
          });
        }

        if (pathname === "/openapi.json") {
          return json(buildOpenApiDocument());
        }

        if (pathname === "/api/state") {
          return json(await getFullState());
        }

        if (pathname === "/api/views/now") {
          const state = await getFullState();
          return json({ cursor: state.cursor, now: state.now, telemetry: state.telemetry });
        }

        if (pathname.startsWith("/api/evidence/")) {
          const id = decodeURIComponent(pathname.slice("/api/evidence/".length));
          const blob = telemetry.getEvidence(id);
          return blob ? json(blob) : json({ error: "Evidence not found" }, 404);
        }

        if (pathname.startsWith("/api/handoff/")) {
          const sessionId = decodeURIComponent(pathname.slice("/api/handoff/".length));
          const dir = url.searchParams.get("dir") ?? config.apps[0]?.repoPath ?? process.cwd();
          const descriptor: SessionHandoffDescriptor = buildSessionHandoff({
            serviceUrl,
            sessionId,
            locationDir: dir,
          });
          return json(descriptor);
        }

        // Resumable SSE stream (gap-free multi-tab/multi-window sync)
        if (pathname === "/api/stream") {
          const after = Number(url.searchParams.get("after") ?? "0") || 0;
          const encoder = new TextEncoder();
          let cleanup: (() => void) | undefined;

          const stream = new ReadableStream({
            start(controller) {
              const send = (ev: StreamEvent) => {
                controller.enqueue(
                  encoder.encode(`id: ${ev.cursor}\nevent: update\ndata: ${JSON.stringify(ev)}\n\n`),
                );
              };
              // Replay any missed events since client's cursor
              for (const ev of eventHistory) {
                if (ev.cursor > after) send(ev);
              }
              controller.enqueue(
                encoder.encode(
                  `id: ${cursorSeq}\nevent: connected\ndata: ${JSON.stringify({ cursor: cursorSeq, mode })}\n\n`,
                ),
              );
              sseSubscribers.add(send);
              const keepalive = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
                } catch {
                  clearInterval(keepalive);
                }
              }, 20_000);
              cleanup = () => {
                clearInterval(keepalive);
                sseSubscribers.delete(send);
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
              "access-control-allow-origin": "*",
            },
          });
        }

        // Typed Operator Intents (POST /api/intents/*)
        if (req.method === "POST" && pathname.startsWith("/api/intents/")) {
          const intent = pathname.slice("/api/intents/".length);
          const body = (await req.json().catch(() => ({}))) as Record<string, any>;
          const commandId =
            typeof body.commandId === "string" && body.commandId.length > 0
              ? body.commandId
              : crypto.randomUUID();

          if (intent === "collect") {
            const envKey = String(body.envKey ?? "");
            if (envKey) {
              const snap = await collectEnvironment(envKey);
              return json({ ok: true, collected: snap ? [envKey] : [], cursor: cursorSeq });
            }
            const allKeys = telemetry.listEnvironmentSnapshots().map((s) => s.envKey);
            for (const k of allKeys) await collectEnvironment(k);
            return json({ ok: true, collected: allKeys, cursor: cursorSeq });
          }

          if (intent === "answer-ask") {
            const askId = String(body.askId) as AskId;
            const selectedOptionId = String(body.selectedOptionId);
            const note = typeof body.note === "string" ? body.note : undefined;
            const receipt = await runEffect(
              Effect.flatMap(Ask, (a) =>
                a.send(askId, new AnswerAsk({ selectedOptionId, note }), { commandId }),
              ),
            );
            // Allow policy + ExecuteAction saga to settle quickly
            await new Promise((r) => setTimeout(r, 80));
            publishEvent("ask.answered", `${askId}:${selectedOptionId}`);
            return json({ ok: true, stream: receipt.stream, version: receipt.version, cursor: cursorSeq });
          }

          if (intent === "incident-chat") {
            const incidentId = String(body.incidentId) as IncidentId;
            const text = String(body.text ?? "").trim();
            if (!text) return json({ error: "Message required" }, 400);
            const receipt = await runEffect(
              Effect.gen(function* () {
                const incidents = yield* Incident;
                const r = yield* incidents.send(
                  incidentId,
                  new PostIncidentChat({
                    id: `chat-${Date.now()}-op`,
                    author: "operator",
                    text,
                    delivery: "steer",
                  }),
                  { commandId },
                );
                // Generate grounded concise agent reply citing real evidence
                const lower = text.toLowerCase();
                const reply = lower.includes("rollback")
                  ? "Rolling back to build #481 (4c88e1b) will immediately restore 0.88s p95; alternatively approve Draft PR act-pr-42 to patch forward."
                  : lower.includes("pod") || lower.includes("memory") || lower.includes("oom")
                    ? "checkout-api-9f31c2a-9c2f hit 1 OOMKilled restart (790/1024 MiB) due to 46x cart_line_items result buffers; rev-481 pod stays steady at 482 MiB."
                    : "Checked rev-482 spans and K8s metrics: 92% of the +1260ms p95 delta sits inside pg.query cart_line_items (46x/req). Worktree fix verified locally at 42ms.";
                yield* incidents.send(
                  incidentId,
                  new PostIncidentChat({
                    id: `chat-${Date.now() + 1}-ag`,
                    author: "agent",
                    text: reply.slice(0, 400),
                    delivery: "reply",
                    evidenceIds: ["ev_trace_diff_482" as EvidenceId, "ev_k8s_rev_482" as EvidenceId],
                  }),
                );
                return r;
              }),
            );
            publishEvent("incident.chat", incidentId);
            return json({ ok: true, stream: receipt.stream, version: receipt.version, cursor: cursorSeq });
          }

          if (intent === "prepare-fix") {
            const incidentId = String(body.incidentId) as IncidentId;
            const runId = `run-fix-${Date.now()}` as RunId;
            const sessionId = createOpenCodeSessionId();
            const permissions = compileSessionPermissions("fix", `/tmp/overwatch-wt/${runId}`);
            const actionId = `act-fix-${Date.now()}` as ActionId;

            await runEffect(
              Effect.gen(function* () {
                const runs = yield* Run;
                const incidents = yield* Incident;
                const actions = yield* Action;

                yield* runs.send(
                  runId,
                  new StartRun({
                    role: "fix",
                    trigger: "intent",
                    appId: "checkout-api",
                    envId: "prod",
                    incidentId,
                    model: config.opencode.models?.fixer ?? "claude-sonnet-4-5",
                    budget: { maxAwakeMs: 600_000, maxConnectorCalls: 15, maxTotalToolCalls: 50, maxUsd: 3.0 },
                  }),
                );
                yield* runs.send(
                  runId,
                  new AssignRunSession({
                    sessionId,
                    worktreePath: `/Users/brandon/.local/share/overwatch/worktrees/checkout-api/${runId}`,
                  }),
                );
                yield* runs.send(
                  runId,
                  new RecordRunUsage({
                    connectorCallsDelta: 3,
                    toolCallsDelta: 12,
                    usdDelta: 0.41,
                    awakeDeltaMs: 64_000,
                  }),
                );
                yield* incidents.send(incidentId, new LinkRunToIncident({ runId }));
                yield* incidents.send(
                  incidentId,
                  new RecordVerificationBundle({
                    bundle: {
                      runId,
                      reproducedLocally: true,
                      commandsRun: ["bun run typecheck", "bun test"],
                      exitCodes: [0, 0],
                      beforeAfterSummary: "Reproduced locally and verified fix in isolated worktree",
                      diffStat: "2 files changed, 28 insertions(+), 9 deletions(-)",
                      unknowns: ["Pending production deploy and 3 clean windows"],
                      worktreePath: `/Users/brandon/.local/share/overwatch/worktrees/checkout-api/${runId}`,
                      branch: `overwatch/${incidentId.toLowerCase()}-${runId.slice(-4)}`,
                    },
                  }),
                );
                yield* actions.send(
                  actionId,
                  new RequestAction({
                    kind: "open_draft_pr",
                    appId: "checkout-api",
                    envId: "prod",
                    repo: "brandonbryant12/overwatch",
                    title: `Verified fix for ${incidentId}`,
                    body: `Isolated worktree verification passed. Session ${sessionId}.`,
                    branch: `overwatch/${incidentId.toLowerCase()}-${runId.slice(-4)}`,
                    baseBranch: "main",
                    worktreePath: `/Users/brandon/.local/share/overwatch/worktrees/checkout-api/${runId}`,
                    evidenceIds: ["ev_trace_diff_482" as EvidenceId],
                    incidentId,
                    runId,
                    autonomy: "propose",
                  }),
                );
              }),
            );
            publishEvent("fix.prepared", `${incidentId}:${runId}`);
            return json({ ok: true, runId, sessionId, actionId, permissionCount: permissions.length, cursor: cursorSeq });
          }

          if (intent === "create-issue") {
            const actionId = `act-issue-${Date.now()}` as ActionId;
            const title = String(body.title ?? "Overwatch finding");
            const incidentId = body.incidentId ? (String(body.incidentId) as IncidentId) : undefined;
            const appId = String(body.appId ?? "checkout-api");
            const envId = String(body.envId ?? "prod");
            await runEffect(
              Effect.flatMap(Action, (a) =>
                a.send(
                  actionId,
                  new RequestAction({
                    kind: "create_github_issue",
                    appId,
                    envId,
                    repo: "brandonbryant12/overwatch",
                    title,
                    body: String(body.body ?? `Filed from Overwatch for ${appId}/${envId}.`),
                    evidenceIds: [(body.evidenceId ?? "ev_trace_diff_482") as EvidenceId],
                    incidentId,
                    autonomy: "propose",
                  }),
                  { commandId },
                ),
              ),
            );
            publishEvent("action.requested", actionId);
            return json({ ok: true, actionId, cursor: cursorSeq });
          }

          if (intent === "enter-watching") {
            const incidentId = String(body.incidentId) as IncidentId;
            await runEffect(
              Effect.flatMap(Incident, (inc) =>
                inc.send(
                  incidentId,
                  new EnterWatching({ reason: String(body.reason ?? "Deploy rolled out; monitoring recovery") }),
                  { commandId },
                ),
              ),
            );
            publishEvent("incident.watching", incidentId);
            return json({ ok: true, cursor: cursorSeq });
          }

          if (intent === "record-clean-window") {
            const incidentId = String(body.incidentId) as IncidentId;
            await runEffect(
              Effect.flatMap(Incident, (inc) =>
                inc.send(
                  incidentId,
                  new RecordCleanWindow({ coverage: "healthy", observedAtMs: Date.now() }),
                  { commandId },
                ),
              ),
            );
            publishEvent("incident.clean_window", incidentId);
            return json({ ok: true, cursor: cursorSeq });
          }

          if (intent === "resolve-incident") {
            const incidentId = String(body.incidentId) as IncidentId;
            await runEffect(
              Effect.flatMap(Incident, (inc) =>
                inc.send(
                  incidentId,
                  new ResolveIncident({
                    reason: String(body.reason ?? "Operator verified recovery"),
                    operatorOverride: body.operatorOverride === true,
                  }),
                  { commandId },
                ),
              ),
            );
            publishEvent("incident.resolved", incidentId);
            return json({ ok: true, cursor: cursorSeq });
          }

          if (intent === "dismiss-incident") {
            const incidentId = String(body.incidentId) as IncidentId;
            await runEffect(
              Effect.flatMap(Incident, (inc) =>
                inc.send(
                  incidentId,
                  new DismissIncident({ reason: String(body.reason ?? "False positive") }),
                  { commandId },
                ),
              ),
            );
            publishEvent("incident.dismissed", incidentId);
            return json({ ok: true, cursor: cursorSeq });
          }

          if (intent === "feedback") {
            const incidentId = String(body.incidentId) as IncidentId;
            const vote = body.vote === "down" ? "down" : "up";
            const reason = (body.reason ?? (vote === "up" ? "accurate" : "noisy")) as FeedbackReason;
            await runEffect(
              Effect.flatMap(Incident, (inc) =>
                inc.send(incidentId, new RecordIncidentFeedback({ vote, reason }), { commandId }),
              ),
            );
            publishEvent("feedback.recorded", `${incidentId}:${vote}`);
            return json({ ok: true, cursor: cursorSeq });
          }

          if (intent === "watch-insight") {
            const insightId = String(body.insightId) as InsightId;
            const ruleId = `rule-from-${insightId}` as WatchRuleId;
            await runEffect(
              Effect.flatMap(Catalog, (cat) =>
                cat.send(
                  GLOBAL_CATALOG_ID,
                  new PromoteInsightToWatch({
                    insightId,
                    ruleId,
                    name: String(body.name ?? `Watch rule from ${insightId}`),
                    metric: String(body.metric ?? "p95_latency_ms"),
                    operator: "gt",
                    threshold: Number(body.threshold ?? 1000),
                    severity: "warn",
                  }),
                  { commandId },
                ),
              ),
            );
            publishEvent("insight.watched", insightId);
            return json({ ok: true, ruleId, cursor: cursorSeq });
          }

          if (intent === "promote-insight") {
            const insightId = String(body.insightId) as InsightId;
            const incidentId = `INC-${Math.floor(100 + Math.random() * 899)}` as IncidentId;
            const state = await getFullState();
            const insightList = ((state.insights as any)?.insights ?? []) as Array<any>;
            const found = insightList.find((i) => i.insightId === insightId);
            if (!found) return json({ error: "Insight not found" }, 404);
            await runEffect(
              Effect.gen(function* () {
                const incidents = yield* Incident;
                const catalog = yield* Catalog;
                yield* incidents.send(
                  incidentId,
                  new OpenIncident({
                    appId: found.appId,
                    envId: found.envId,
                    headline: String(found.claim).slice(0, 80),
                    severity: "warn",
                    signal: {
                      signalId: `sig-${insightId}`,
                      watchRuleId: "promoted-insight",
                      fingerprint: `fp:insight:${insightId}`,
                      summary: found.whyItMatters,
                      severity: "warn",
                      evidenceId: (found.evidenceIds[0] ?? "ev_explore_billing_n1") as EvidenceId,
                      observedAtMs: Date.now(),
                    },
                  }),
                );
                yield* catalog.send(
                  GLOBAL_CATALOG_ID,
                  new PromoteInsightToIncident({ insightId, incidentId }),
                );
              }),
            );
            publishEvent("insight.promoted", `${insightId}->${incidentId}`);
            return json({ ok: true, incidentId, cursor: cursorSeq });
          }

          if (intent === "dismiss-insight") {
            const insightId = String(body.insightId) as InsightId;
            const reason = (body.reason ?? "noisy") as FeedbackReason;
            await runEffect(
              Effect.flatMap(Catalog, (cat) =>
                cat.send(GLOBAL_CATALOG_ID, new DismissInsight({ insightId, reason }), { commandId }),
              ),
            );
            publishEvent("insight.dismissed", insightId);
            return json({ ok: true, cursor: cursorSeq });
          }

          if (intent === "trace-walk") {
            const nowMs = Date.now();
            const evId = `ev_walk_${nowMs}` as EvidenceId;
            const insightId = `ins-walk-${nowMs}` as InsightId;
            const runId = `run-explore-${nowMs}` as RunId;
            const sessionId = createOpenCodeSessionId();
            telemetry.putEvidence({
              evidenceId: evId,
              source: "datadog",
              envKey: "identity-edge:prod",
              title: "Paired trace walk: JWKS cache refresh contention on /oauth2/token",
              query: "paired_trace_diff(POST /oauth2/token, p99 vs p50)",
              deepLink: "https://app.datadoghq.com/apm/service/identity-edge?env=prod",
              capturedAtMs: nowMs,
              excerpt:
                "Every 15m JWKS expiry causes 9 concurrent pods to refetch keys simultaneously (p99 spikes 62ms -> 310ms). Staggered jitter prevents thundering herd.",
            });
            telemetry.recordExploration({
              envKey: "identity-edge:prod",
              route: "POST /oauth2/token",
              mode: "trace_walk",
              priorityScore: 12.1,
              outcome: "insight_recorded",
              atMs: nowMs,
            });
            await runEffect(
              Effect.gen(function* () {
                const runs = yield* Run;
                const catalog = yield* Catalog;
                yield* runs.send(
                  runId,
                  new StartRun({
                    role: "explore",
                    trigger: "intent",
                    appId: "identity-edge",
                    envId: "prod",
                    model: config.opencode.models?.explorer ?? "claude-sonnet-4-5",
                    budget: { maxAwakeMs: 180_000, maxConnectorCalls: 20, maxTotalToolCalls: 30, maxUsd: 1.0 },
                  }),
                );
                yield* runs.send(runId, new AssignRunSession({ sessionId }));
                yield* runs.send(
                  runId,
                  new RecordRunUsage({
                    connectorCallsDelta: 5,
                    toolCallsDelta: 9,
                    usdDelta: 0.19,
                    awakeDeltaMs: 41_000,
                  }),
                );
                yield* runs.send(
                  runId,
                  new CompleteRun({ summary: "Identified 15m JWKS cache thundering herd on /oauth2/token." }),
                );
                yield* catalog.send(
                  GLOBAL_CATALOG_ID,
                  new RecordInsight({
                    insightId,
                    appId: "identity-edge",
                    envId: "prod",
                    claim: "JWKS cache expiry triggers synchronized refetch across 9 pods (p99 310ms)",
                    whyItMatters: "Adding 10% TTL jitter eliminates periodic token latency tail spikes.",
                    recurrenceCount: 4,
                    evidenceIds: [evId],
                    sourceMode: "trace_walk",
                  }),
                );
              }),
            );
            publishEvent("explore.completed", insightId);
            return json({ ok: true, insightId, runId, sessionId, cursor: cursorSeq });
          }

          if (intent === "draft-brief") {
            const kind = (body.kind ?? "daily_digest_exec") as BriefKind;
            const briefId = `brief-${kind}-${Date.now()}` as BriefId;
            const incidentId = body.incidentId ? (String(body.incidentId) as IncidentId) : undefined;
            const subject =
              kind === "daily_digest_tech"
                ? "Overwatch Daily Technical Brief"
                : kind === "daily_digest_exec"
                  ? "Overwatch Executive Health Summary"
                  : kind === "postmortem"
                    ? `Postmortem Draft: ${incidentId ?? "INC-42"}`
                    : kind === "engineer_update"
                      ? `Engineering Update: ${incidentId ?? "INC-42"}`
                      : `Stakeholder Status: ${incidentId ?? "INC-42"}`;
            const text =
              kind === "stakeholder_update"
                ? "Checkout latency rose from 0.9s to 2.1s after release #482. Root cause is confirmed as an unbatched database lookup, and a verified fix is awaiting final draft PR sign-off. All other production services remain healthy. Next status update in 20 minutes."
                : kind === "daily_digest_exec"
                  ? "Production fleet is 4/5 healthy with one active checkout latency regression under verified remediation. Staging EKS credentials require SSO refresh; no false alerts fired. Two proactive overnight performance insights were captured for payments and ledger services."
                  : "Active: INC-42 (checkout-api prod p95 2.15s on rev-482 / 9f31c2a, 46x cart_line_items query fan-out; local worktree fix verified 42ms vs 890ms, Draft PR pending approval). Insights: billing-worker N+1 (+34% WoW), ledger-ingest memory +38% over 7d.";
            await runEffect(
              Effect.flatMap(Brief, (b) =>
                b.send(
                  briefId,
                  new SaveBriefDraft({
                    kind,
                    incidentId,
                    subject,
                    body: text,
                    recipients:
                      kind === "daily_digest_exec"
                        ? ["leadership@example.com"]
                        : ["platform-eng@example.com"],
                  }),
                  { commandId },
                ),
              ),
            );
            publishEvent("brief.drafted", briefId);
            return json({ ok: true, briefId, cursor: cursorSeq });
          }

          if (intent === "edit-brief") {
            const briefId = String(body.briefId) as BriefId;
            await runEffect(
              Effect.flatMap(Brief, (b) =>
                b.send(briefId, new EditBriefDraft({ body: String(body.body ?? "") }), { commandId }),
              ),
            );
            publishEvent("brief.edited", briefId);
            return json({ ok: true, cursor: cursorSeq });
          }

          if (intent === "send-brief") {
            const briefId = String(body.briefId) as BriefId;
            await runEffect(
              Effect.gen(function* () {
                const b = yield* Brief;
                yield* b.send(briefId, new ApproveBrief({}));
                yield* b.send(briefId, new MarkBriefSent({ messageId: `msg_${briefId}` }));
              }),
            );
            publishEvent("brief.sent", briefId);
            return json({ ok: true, cursor: cursorSeq });
          }

          if (intent === "decide-proposal") {
            const proposalId = String(body.proposalId);
            const status = body.status === "approved" ? "approved" : "rejected";
            await runEffect(
              Effect.flatMap(Catalog, (cat) =>
                cat.send(GLOBAL_CATALOG_ID, new DecideProposal({ proposalId, status }), { commandId }),
              ),
            );
            publishEvent("proposal.decided", `${proposalId}:${status}`);
            return json({ ok: true, cursor: cursorSeq });
          }

          if (intent === "simulate-wake") {
            const gapMinutes = Math.max(20, Number(body.gapMinutes ?? 540));
            const wokeAtMs = Date.now();
            const gapMs = gapMinutes * 60_000;
            await handleWake({
              sleptAtMs: wokeAtMs - gapMs,
              wokeAtMs,
              gapMs,
              tier: gapMinutes > 72 * 60 ? "extended_offline" : "overnight",
            });
            return json({ ok: true, gapMinutes, cursor: cursorSeq });
          }

          return json({ error: `Unknown intent: ${intent}` }, 404);
        }

        // Static Web UI serving (`GET /` and assets)
        const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const candidate = path.resolve(webRoot, relPath);
        if (candidate.startsWith(webRoot) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const ext = path.extname(candidate).toLowerCase();
          return new Response(Bun.file(candidate), {
            headers: { "content-type": MIME_TYPES[ext] ?? "application/octet-stream" },
          });
        }
        const fallbackIndex = path.join(webRoot, "index.html");
        if (fs.existsSync(fallbackIndex)) {
          return new Response(Bun.file(fallbackIndex), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return json({ error: "Not found", path: pathname }, 404);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, 422);
      }
    },
  });

  const boundPort = server.port ?? options.port ?? 4720;
  const host = options.host ?? "127.0.0.1";

  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    telemetry,
    getOpenApiDocument: buildOpenApiDocument,
    getFullState,
    stop: async () => {
      wakeCoordinator.stop();
      server.stop(true);
      await runtime.dispose();
      await Effect.runPromise(sqlite.close);
    },
  };
}
