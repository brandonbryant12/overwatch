import * as crypto from "node:crypto";
import {
  Action,
  ActionId,
  AnswerAsk,
  ApproveBrief,
  Ask,
  AskId,
  AssignRunSession,
  Brief,
  BriefId,
  BriefKind,
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
  NowView,
  OpenIncident,
  PostIncidentChat,
  PromoteInsightToIncident,
  PromoteInsightToWatch,
  RecordCleanWindow,
  RecordIncidentFeedback,
  RecordInsight,
  RecordRunUsage,
  RecordVerificationBundle,
  RequestAction,
  ResolveIncident,
  Run,
  RunId,
  SaveBriefDraft,
  StartRun,
  WatchRuleId,
  type AutonomyLevel,
  type EnvAutonomy,
  type RunBudget,
} from "@overwatch/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { findEnvironmentConfig, repoForApp, type DaemonContext } from "./context.ts";
import type { DemoSimulator } from "./demo-simulator.ts";
import type { Monitor } from "./monitor.ts";
import { compileSessionPermissions, createOpenCodeSessionId } from "./opencode-bridge.ts";
import type { WakeEvent } from "./wake-coordinator.ts";

/** A request the daemon understood but will not carry out. Maps to an HTTP status. */
export class IntentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type IntentInput = Readonly<Record<string, unknown>>;
export type IntentHandler = (input: IntentInput, commandId: string) => Promise<Record<string, unknown>>;

export interface IntentDeps {
  readonly ctx: DaemonContext;
  readonly monitor: Monitor;
  readonly simulator: DemoSimulator;
  readonly handleWake: (wake: WakeEvent) => Promise<void>;
}

const requireString = (input: IntentInput, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IntentError(400, `"${key}" is required`);
  }
  return value.trim();
};

const optionalString = (input: IntentInput, key: string): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const FEEDBACK_REASONS: ReadonlyArray<FeedbackReason> = [
  "wrong_cause",
  "noisy",
  "too_verbose",
  "missing_evidence",
  "bad_severity",
  "unnecessary_ask",
  "accurate",
];

const feedbackReason = (input: IntentInput, fallback: FeedbackReason): FeedbackReason => {
  const value = input.reason;
  return FEEDBACK_REASONS.includes(value as FeedbackReason) ? (value as FeedbackReason) : fallback;
};

/** Run budgets always carry a tool-call ceiling, even when the config leaves it out. */
const runBudget = (budget: RunBudget) => ({
  ...budget,
  maxTotalToolCalls: budget.maxTotalToolCalls ?? budget.maxConnectorCalls * 3,
});

const shortHash = (text: string): string =>
  crypto.createHash("sha256").update(text).digest().readUInt32BE(0).toString(36).toUpperCase().padStart(6, "0").slice(-6);

/**
 * Operator intents: every dashboard button and palette command lands here.
 *
 * Handlers translate an intent into domain commands and return a small JSON receipt. Three
 * handlers (`incident-chat` replies, `prepare-fix`, `trace-walk`, `draft-brief`) stand in for an
 * agent with scripted output. They only run in demo mode: in live mode they refuse, because a
 * scripted "verified fix" next to real telemetry would be a lie.
 */
export function makeIntentHandlers(deps: IntentDeps): Readonly<Record<string, IntentHandler>> {
  const { ctx, monitor, simulator } = deps;
  const { config, runEffect } = ctx;

  const demoOnly = (what: string): void => {
    if (ctx.mode !== "demo") {
      throw new IntentError(
        501,
        `${what} needs an OpenCode agent run, which is not connected in live mode yet. It is scripted in demo mode only.`,
      );
    }
  };

  const readNow = async () =>
    Option.getOrUndefined(await runEffect(Effect.flatMap(NowView, (v) => v.get(GLOBAL_VIEW_KEY))));

  const requireIncident = async (incidentId: IncidentId) => {
    const summary = (await readNow())?.incidents[incidentId];
    if (!summary) throw new IntentError(404, `Incident ${incidentId} not found`);
    const detail = Option.getOrUndefined(
      await runEffect(Effect.flatMap(IncidentDetailView, (v) => v.get(Incident.ref(incidentId)))),
    );
    const evidenceIds = [
      ...new Set([
        ...(detail?.signals.map((s) => s.evidenceId) ?? []),
        ...(detail?.findings.flatMap((f) => f.evidenceIds) ?? []),
      ]),
    ];
    return { summary, detail, evidenceIds };
  };

  const requireRepo = (appId: string): string => {
    const repo = repoForApp(config, appId);
    if (!repo) throw new IntentError(400, `No githubRepo is configured for app "${appId}"`);
    return repo;
  };

  const autonomyFor = (appId: string, envId: string, key: keyof EnvAutonomy): AutonomyLevel =>
    findEnvironmentConfig(config, `${appId}:${envId}`)?.env.autonomy[key] ?? "propose";

  const modelFor = (role: "triage" | "investigator" | "explorer" | "fixer" | "scribe" | "judge"): string =>
    config.opencode.models?.[role] ?? "unconfigured";

  const sendIncident = (incidentId: IncidentId, command: Parameters<(typeof Incident)["Service"]["send"]>[1], commandId?: string) =>
    runEffect(
      Effect.flatMap(Incident, (inc) => inc.send(incidentId, command, commandId ? { commandId } : undefined)),
    );

  return {
    collect: async (input) => {
      const envKey = optionalString(input, "envKey");
      const outcomes = envKey ? [await monitor.sweep(envKey)] : await monitor.sweepAll("operator");
      return {
        collected: outcomes.filter((o) => o.collected).map((o) => o.envKey),
        opened: outcomes.flatMap((o) => (o.openedIncidentId ? [o.openedIncidentId] : [])),
      };
    },

    "answer-ask": async (input, commandId) => {
      const askId = requireString(input, "askId") as AskId;
      const selectedOptionId = requireString(input, "selectedOptionId");
      const note = optionalString(input, "note");
      const receipt = await runEffect(
        Effect.flatMap(Ask, (a) => a.send(askId, new AnswerAsk({ selectedOptionId, note }), { commandId })),
      );
      // Give the approval policy and the action saga a moment before the client refetches.
      await new Promise((r) => setTimeout(r, 80));
      ctx.events.publish("ask.answered", `${askId}:${selectedOptionId}`);
      return { stream: receipt.stream, version: receipt.version };
    },

    "incident-chat": async (input, commandId) => {
      const incidentId = requireString(input, "incidentId") as IncidentId;
      const text = requireString(input, "text");
      const { evidenceIds } = await requireIncident(incidentId);
      const stamp = ctx.now();
      const receipt = await sendIncident(
        incidentId,
        new PostIncidentChat({ id: `chat-${stamp}-op`, author: "operator", text, delivery: "steer" }),
        commandId,
      );

      let agentReplied = false;
      if (ctx.mode === "demo") {
        const lower = text.toLowerCase();
        const reply = lower.includes("rollback")
          ? "Rolling back to the previous build restores the earlier latency at once. The alternative is to approve the draft PR and patch forward."
          : lower.includes("pod") || lower.includes("memory") || lower.includes("oom")
            ? "New-revision pods are using more memory than the previous revision and one restarted with OOMKilled. Old-revision pods are steady."
            : "The slow requests share one database span that fans out per request on the new revision. The local fix is verified and waiting for approval.";
        await sendIncident(
          incidentId,
          new PostIncidentChat({
            id: `chat-${stamp}-ag`,
            author: "agent",
            text: reply,
            delivery: "reply",
            evidenceIds: evidenceIds.slice(0, 2),
          }),
        );
        agentReplied = true;
      }
      ctx.events.publish("incident.chat", incidentId);
      return {
        stream: receipt.stream,
        version: receipt.version,
        agentReplied,
        ...(agentReplied ? {} : { notice: "Saved to the timeline. No agent session is attached to answer it." }),
      };
    },

    "prepare-fix": async (input) => {
      demoOnly("Preparing a fix");
      const incidentId = requireString(input, "incidentId") as IncidentId;
      const { summary, evidenceIds } = await requireIncident(incidentId);
      const { appId, envId } = summary;
      const repo = requireRepo(appId);
      const stamp = ctx.now();
      const runId = `run-fix-${stamp}` as RunId;
      const actionId = `act-fix-${stamp}` as ActionId;
      const sessionId = createOpenCodeSessionId();
      const worktreePath = `${ctx.worktreeRoot}/${appId}/${runId}`;
      const branch = `overwatch/${incidentId.toLowerCase()}-${runId.slice(-4)}`;
      const envAutonomy = findEnvironmentConfig(config, `${appId}:${envId}`)?.env.autonomy;
      const permissions = compileSessionPermissions("fix", worktreePath, envAutonomy);

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
              appId,
              envId,
              incidentId,
              model: modelFor("fixer"),
              budget: runBudget(config.budgets.fix),
            }),
          );
          yield* runs.send(runId, new AssignRunSession({ sessionId, worktreePath }));
          yield* runs.send(
            runId,
            new RecordRunUsage({ connectorCallsDelta: 3, toolCallsDelta: 12, usdDelta: 0.41, awakeDeltaMs: 64_000 }),
          );
          yield* incidents.send(incidentId, new LinkRunToIncident({ runId }));
          yield* incidents.send(
            incidentId,
            new RecordVerificationBundle({
              bundle: {
                runId,
                reproducedLocally: true,
                commandsRun: [...(config.apps.find((a) => a.id === appId)?.verifyCommands ?? [])],
                exitCodes: (config.apps.find((a) => a.id === appId)?.verifyCommands ?? []).map(() => 0),
                beforeAfterSummary: "Reproduced locally and verified the fix in an isolated worktree",
                diffStat: "2 files changed, 28 insertions(+), 9 deletions(-)",
                unknowns: [`Production recovery still needs ${summary.recoveryTargetK} clean windows after deploy.`],
                worktreePath,
                branch,
              },
            }),
          );
          yield* actions.send(
            actionId,
            new RequestAction({
              kind: "open_draft_pr",
              appId,
              envId,
              repo,
              title: `Verified fix for ${incidentId}`,
              body: `Isolated worktree verification passed. Session ${sessionId}.`,
              branch,
              baseBranch: config.apps.find((a) => a.id === appId)?.defaultBranch ?? "main",
              worktreePath,
              evidenceIds: evidenceIds.slice(0, 3),
              incidentId,
              runId,
              autonomy: autonomyFor(appId, envId, "openDraftPr"),
            }),
          );
        }),
      );
      ctx.events.publish("fix.prepared", `${incidentId}:${runId}`);
      return { runId, sessionId, actionId, permissionCount: permissions.length };
    },

    "create-issue": async (input, commandId) => {
      const incidentId = optionalString(input, "incidentId") as IncidentId | undefined;
      const incident = incidentId ? await requireIncident(incidentId) : undefined;
      const appId = incident?.summary.appId ?? requireString(input, "appId");
      const envId = incident?.summary.envId ?? requireString(input, "envId");
      const explicitEvidence = optionalString(input, "evidenceId") as EvidenceId | undefined;
      const evidenceIds = explicitEvidence ? [explicitEvidence] : (incident?.evidenceIds.slice(0, 3) ?? []);
      const actionId = `act-issue-${shortHash(commandId)}` as ActionId;
      await runEffect(
        Effect.flatMap(Action, (a) =>
          a.send(
            actionId,
            new RequestAction({
              kind: "create_github_issue",
              appId,
              envId,
              repo: requireRepo(appId),
              title: optionalString(input, "title") ?? incident?.summary.headline ?? "Overwatch finding",
              body: optionalString(input, "body") ?? `Filed from Overwatch for ${appId}/${envId}.`,
              evidenceIds,
              incidentId,
              autonomy: autonomyFor(appId, envId, "createGithubIssue"),
            }),
            { commandId },
          ),
        ),
      );
      ctx.events.publish("action.requested", actionId);
      return { actionId };
    },

    "enter-watching": async (input, commandId) => {
      const incidentId = requireString(input, "incidentId") as IncidentId;
      await sendIncident(
        incidentId,
        new EnterWatching({ reason: optionalString(input, "reason") ?? "Deploy rolled out; monitoring recovery" }),
        commandId,
      );
      ctx.events.publish("incident.watching", incidentId);
      return {};
    },

    "record-clean-window": async (input, commandId) => {
      const incidentId = requireString(input, "incidentId") as IncidentId;
      await sendIncident(
        incidentId,
        new RecordCleanWindow({ coverage: "healthy", observedAtMs: ctx.now() }),
        commandId,
      );
      ctx.events.publish("incident.clean_window", incidentId);
      return {};
    },

    "resolve-incident": async (input, commandId) => {
      const incidentId = requireString(input, "incidentId") as IncidentId;
      await sendIncident(
        incidentId,
        new ResolveIncident({
          reason: optionalString(input, "reason") ?? "Operator verified recovery",
          operatorOverride: input.operatorOverride === true,
        }),
        commandId,
      );
      ctx.events.publish("incident.resolved", incidentId);
      return {};
    },

    "dismiss-incident": async (input, commandId) => {
      const incidentId = requireString(input, "incidentId") as IncidentId;
      await sendIncident(
        incidentId,
        new DismissIncident({ reason: optionalString(input, "reason") ?? "False positive" }),
        commandId,
      );
      ctx.events.publish("incident.dismissed", incidentId);
      return {};
    },

    feedback: async (input, commandId) => {
      const incidentId = requireString(input, "incidentId") as IncidentId;
      const vote = input.vote === "down" ? "down" : "up";
      await sendIncident(
        incidentId,
        new RecordIncidentFeedback({ vote, reason: feedbackReason(input, vote === "up" ? "accurate" : "noisy") }),
        commandId,
      );
      ctx.events.publish("feedback.recorded", `${incidentId}:${vote}`);
      return {};
    },

    "watch-insight": async (input, commandId) => {
      const insightId = requireString(input, "insightId") as InsightId;
      const ruleId = `rule-from-${insightId}` as WatchRuleId;
      const threshold = Number(input.threshold ?? 1000);
      if (!Number.isFinite(threshold)) throw new IntentError(400, '"threshold" must be a number');
      await runEffect(
        Effect.flatMap(Catalog, (cat) =>
          cat.send(
            GLOBAL_CATALOG_ID,
            new PromoteInsightToWatch({
              insightId,
              ruleId,
              name: optionalString(input, "name") ?? `Watch rule from ${insightId}`,
              metric: optionalString(input, "metric") ?? "p95_latency_ms",
              operator: "gt",
              threshold,
              severity: "warn",
            }),
            { commandId },
          ),
        ),
      );
      ctx.events.publish("insight.watched", insightId);
      return { ruleId };
    },

    "promote-insight": async (input) => {
      const insightId = requireString(input, "insightId") as InsightId;
      const feed = Option.getOrUndefined(
        await runEffect(Effect.flatMap(InsightFeedView, (v) => v.get(GLOBAL_VIEW_KEY))),
      );
      const found = feed?.insights.find((i) => i.insightId === insightId);
      if (!found) throw new IntentError(404, "Insight not found");
      const evidenceId = found.evidenceIds[0];
      if (!evidenceId) throw new IntentError(409, "Insight has no evidence to open an incident from");
      // Derived from the insight, so promoting twice lands on the same incident.
      const incidentId = `INC-${shortHash(`insight:${insightId}`)}` as IncidentId;
      await runEffect(
        Effect.gen(function* () {
          const incidents = yield* Incident;
          const catalog = yield* Catalog;
          yield* incidents.send(
            incidentId,
            new OpenIncident({
              appId: found.appId,
              envId: found.envId,
              headline: found.claim.slice(0, 80),
              severity: "warn",
              signal: {
                signalId: `sig-${insightId}`,
                watchRuleId: "promoted-insight",
                fingerprint: `fp:insight:${insightId}`,
                summary: found.whyItMatters,
                severity: "warn",
                evidenceId,
                observedAtMs: ctx.now(),
              },
            }),
            { commandId: `promote:${insightId}` },
          );
          yield* catalog.send(GLOBAL_CATALOG_ID, new PromoteInsightToIncident({ insightId, incidentId }), {
            commandId: `promote-link:${insightId}`,
          });
        }),
      );
      ctx.events.publish("insight.promoted", `${insightId}->${incidentId}`);
      return { incidentId };
    },

    "dismiss-insight": async (input, commandId) => {
      const insightId = requireString(input, "insightId") as InsightId;
      await runEffect(
        Effect.flatMap(Catalog, (cat) =>
          cat.send(
            GLOBAL_CATALOG_ID,
            new DismissInsight({ insightId, reason: feedbackReason(input, "noisy") }),
            { commandId },
          ),
        ),
      );
      ctx.events.publish("insight.dismissed", insightId);
      return {};
    },

    "trace-walk": async () => {
      demoOnly("A trace walk");
      const nowMs = ctx.now();
      const envKey = "identity-edge:prod";
      const found = findEnvironmentConfig(config, envKey);
      if (!found) throw new IntentError(409, `The demo trace walk needs ${envKey} in the config`);
      const evId = `ev_walk_${nowMs}` as EvidenceId;
      const insightId = `ins-walk-${nowMs}` as InsightId;
      const runId = `run-explore-${nowMs}` as RunId;
      const sessionId = createOpenCodeSessionId();
      ctx.telemetry.putEvidence({
        evidenceId: evId,
        source: "datadog",
        envKey,
        title: "Paired trace walk: JWKS cache refresh contention on /oauth2/token",
        query: "paired_trace_diff(POST /oauth2/token, p99 vs p50)",
        deepLink: "https://app.datadoghq.com/apm/service/identity-edge?env=prod",
        capturedAtMs: nowMs,
        excerpt:
          "Every 15m JWKS expiry causes 9 concurrent pods to refetch keys simultaneously (p99 spikes 62ms -> 310ms). Staggered jitter prevents thundering herd.",
      });
      ctx.telemetry.recordExploration({
        envKey,
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
              appId: found.appId,
              envId: found.envId,
              model: modelFor("explorer"),
              budget: runBudget(config.budgets.explore),
            }),
          );
          yield* runs.send(runId, new AssignRunSession({ sessionId }));
          yield* runs.send(
            runId,
            new RecordRunUsage({ connectorCallsDelta: 5, toolCallsDelta: 9, usdDelta: 0.19, awakeDeltaMs: 41_000 }),
          );
          yield* runs.send(
            runId,
            new CompleteRun({ summary: "Identified 15m JWKS cache thundering herd on /oauth2/token." }),
          );
          yield* catalog.send(
            GLOBAL_CATALOG_ID,
            new RecordInsight({
              insightId,
              appId: found.appId,
              envId: found.envId,
              claim: "JWKS cache expiry triggers synchronized refetch across 9 pods (p99 310ms)",
              whyItMatters: "Adding 10% TTL jitter eliminates periodic token latency tail spikes.",
              recurrenceCount: 4,
              evidenceIds: [evId],
              sourceMode: "trace_walk",
            }),
          );
        }),
      );
      ctx.events.publish("explore.completed", insightId);
      return { insightId, runId, sessionId };
    },

    "draft-brief": async (input, commandId) => {
      demoOnly("Drafting a brief");
      const kind = (optionalString(input, "kind") ?? "daily_digest_exec") as BriefKind;
      const incidentId = optionalString(input, "incidentId") as IncidentId | undefined;
      const subjectFor = incidentId ?? "the fleet";
      const briefId = `brief-${kind}-${ctx.now()}` as BriefId;
      const subject =
        kind === "daily_digest_tech"
          ? "Overwatch Daily Technical Brief"
          : kind === "daily_digest_exec"
            ? "Overwatch Executive Health Summary"
            : kind === "postmortem"
              ? `Postmortem Draft: ${subjectFor}`
              : kind === "engineer_update"
                ? `Engineering Update: ${subjectFor}`
                : `Stakeholder Status: ${subjectFor}`;
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
              recipients: kind === "daily_digest_exec" ? ["leadership@example.com"] : ["platform-eng@example.com"],
            }),
            { commandId },
          ),
        ),
      );
      ctx.events.publish("brief.drafted", briefId);
      return { briefId };
    },

    "edit-brief": async (input, commandId) => {
      const briefId = requireString(input, "briefId") as BriefId;
      await runEffect(
        Effect.flatMap(Brief, (b) =>
          b.send(briefId, new EditBriefDraft({ body: String(input.body ?? "") }), { commandId }),
        ),
      );
      ctx.events.publish("brief.edited", briefId);
      return {};
    },

    "send-brief": async (input) => {
      const briefId = requireString(input, "briefId") as BriefId;
      await runEffect(
        Effect.gen(function* () {
          const b = yield* Brief;
          yield* b.send(briefId, new ApproveBrief({}));
          yield* b.send(briefId, new MarkBriefSent({ messageId: `msg_${briefId}` }));
        }),
      );
      ctx.events.publish("brief.sent", briefId);
      return {};
    },

    "decide-proposal": async (input, commandId) => {
      const proposalId = requireString(input, "proposalId");
      const status = input.status === "approved" ? "approved" : "rejected";
      await runEffect(
        Effect.flatMap(Catalog, (cat) =>
          cat.send(GLOBAL_CATALOG_ID, new DecideProposal({ proposalId, status }), { commandId }),
        ),
      );
      ctx.events.publish("proposal.decided", `${proposalId}:${status}`);
      return {};
    },

    "simulate-wake": async (input) => {
      const gapMinutes = Math.max(20, Number(input.gapMinutes ?? 540) || 540);
      const wokeAtMs = ctx.now();
      const gapMs = gapMinutes * 60_000;
      await deps.handleWake({
        sleptAtMs: wokeAtMs - gapMs,
        wokeAtMs,
        gapMs,
        tier: gapMinutes > 72 * 60 ? "extended_offline" : "overnight",
      });
      return { gapMinutes };
    },

    "simulate-regression": async (input) => {
      demoOnly("Simulating a regression");
      const envKey = requireString(input, "envKey");
      const snapshot = ctx.telemetry.getEnvironmentSnapshot(envKey);
      if (!snapshot) throw new IntentError(404, `Unknown environment ${envKey}`);
      simulator.prime(envKey, snapshot.metrics);
      const baseline = simulator.baselineOf(envKey);
      if (!baseline) throw new IntentError(409, `No baseline for ${envKey} yet`);
      // Size the regression so it clears this environment's own latency limits by a clear margin.
      const feed = Option.getOrUndefined(
        await runEffect(Effect.flatMap(InsightFeedView, (v) => v.get(GLOBAL_VIEW_KEY))),
      );
      const watching = (feed?.watchRules ?? []).filter((r) => r.enabled && `${r.appId}:${r.envId}` === envKey);
      const latencyLimits = watching
        .filter((r) => r.metric === "p95_latency_ms" && r.operator !== "ratio_gt")
        .map((r) => r.threshold);
      const factor = Math.max(2.6, ...latencyLimits.map((limit) => (limit * 1.5) / Math.max(1, baseline.p95LatencyMs)));
      simulator.injectRegression(envKey, factor);
      await monitor.sweep(envKey);
      return { envKey, simulated: "regression", rulesWatching: watching.length };
    },

    "simulate-recovery": async (input) => {
      demoOnly("Simulating a recovery");
      const envKey = requireString(input, "envKey");
      const snapshot = ctx.telemetry.getEnvironmentSnapshot(envKey);
      if (!snapshot) throw new IntentError(404, `Unknown environment ${envKey}`);
      simulator.prime(envKey, snapshot.metrics);
      if (!simulator.recover(envKey)) throw new IntentError(409, `No baseline for ${envKey} yet`);
      await monitor.sweep(envKey);
      return { envKey, simulated: "recovery" };
    },
  };
}
