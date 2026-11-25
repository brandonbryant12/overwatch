import { generateDemoFleetSnapshots } from "@overwatch/connectors";
import {
  Action,
  ActionId,
  AssignRunSession,
  AttachSignal,
  Brief,
  BriefId,
  Catalog,
  CompleteRun,
  EvidenceId,
  GLOBAL_CATALOG_ID,
  Incident,
  IncidentId,
  InsightId,
  LinkRunToIncident,
  OpenIncident,
  PostIncidentChat,
  RecordFinding,
  RecordInsight,
  RecordProposal,
  RecordRollout,
  RecordRunUsage,
  RecordVerdict,
  RecordVerificationBundle,
  RequestAction,
  Run,
  RunId,
  SaveBriefDraft,
  ScoreRun,
  StartRun,
  UpdateUnderstanding,
} from "@overwatch/domain";
import * as Effect from "effect/Effect";
import { repoForApp, type DaemonContext } from "./context.ts";

/** Demo telemetry for every configured environment. Never called in live mode. */
export function seedDemoTelemetry(ctx: DaemonContext, nowMs: number) {
  const demo = generateDemoFleetSnapshots(nowMs);
  for (const blob of demo.evidence) ctx.telemetry.putEvidence(blob);
  for (const snapshot of demo.snapshots) ctx.telemetry.saveEnvironmentSnapshot(snapshot);
  return demo.snapshots;
}

/**
 * The demo story: one rollout regression mid-flight (INC-42) with a verified fix awaiting
 * approval, two overnight insights, a judge verdict, an improvement proposal and a draft brief.
 * Every command carries a fixed commandId, so re-running it is a no-op.
 */
export async function seedDemoScenario(ctx: DaemonContext, nowMs: number): Promise<void> {
  const { config, telemetry } = ctx;
  const repo = repoForApp(config, "checkout-api") ?? "example-org/checkout-api";
  const worktree = `${ctx.worktreeRoot}/checkout-api/inc-42`;

  await ctx.runEffect(
    Effect.gen(function* () {
      const catalog = yield* Catalog;
      const incidents = yield* Incident;
      const runs = yield* Run;
      const actions = yield* Action;
      const briefs = yield* Brief;

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
                worktreePath: worktree,
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
              worktreePath: worktree,
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
              repo,
              title: "Batch promo tier lookup in checkout confirm (INC-42)",
              body: "Replaces per-item pg.query loop with single IN query. Verified locally (42ms vs 890ms).",
              branch: "overwatch/inc-42-batch-promo-query",
              baseBranch: "main",
              worktreePath: worktree,
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
    }),
  );

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
