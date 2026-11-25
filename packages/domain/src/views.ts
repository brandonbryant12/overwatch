import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Action } from "./aggregates/Action.ts";
import { Ask, AskOptionSchema } from "./aggregates/Ask.ts";
import { Brief } from "./aggregates/Brief.ts";
import {
  Catalog,
  EnvironmentRecordSchema,
  InsightRecordSchema,
  ProposalRecordSchema,
  VerdictRecordSchema,
  WatchRuleRecordSchema,
} from "./aggregates/Catalog.ts";
import {
  FindingRecordSchema,
  Incident,
  IncidentChatEntrySchema,
  SignalRecordSchema,
  UnderstandingBulletSchema,
  VerificationBundleSchema,
} from "./aggregates/Incident.ts";
import { Run } from "./aggregates/Run.ts";
import {
  ActionId,
  ActionKind,
  ActionStatus,
  AgentRole,
  AskId,
  AskKind,
  AskStatus,
  BriefId,
  BriefKind,
  BriefStatus,
  ConnectorCoverage,
  GLOBAL_VIEW_KEY,
  IncidentId,
  IncidentStatus,
  omitUndefined,
  RunId,
  RunStatus,
  RunTrigger,
  Severity,
} from "./ids.ts";

const globalKey = () => GLOBAL_VIEW_KEY;

export const IncidentSummarySchema = Schema.Struct({
  incidentId: IncidentId,
  appId: Schema.String,
  envId: Schema.String,
  headline: Schema.String,
  severity: Severity,
  status: IncidentStatus,
  signalCount: Schema.Number,
  recoveryCleanWindows: Schema.Number,
  recoveryTargetK: Schema.Number,
  rolloutId: Schema.optional(Schema.String),
  commitSha: Schema.optional(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  openedAtMs: Schema.Number,
  lastAnomalyAtMs: Schema.Number,
  resolvedAtMs: Schema.optional(Schema.Number),
  activeRunId: Schema.optional(RunId),
});
export type IncidentSummary = typeof IncidentSummarySchema.Type;

export const AskSummarySchema = Schema.Struct({
  askId: AskId,
  kind: AskKind,
  status: AskStatus,
  question: Schema.String,
  whyItMatters: Schema.String,
  options: Schema.Array(AskOptionSchema),
  recommendedOptionId: Schema.String,
  incidentId: Schema.optional(IncidentId),
  runId: Schema.optional(RunId),
  actionId: Schema.optional(ActionId),
  sessionId: Schema.optional(Schema.String),
  selectedOptionId: Schema.optional(Schema.String),
  resolvedVia: Schema.optional(Schema.Literals(["dashboard", "opencode_tui", "chat"])),
  openedAtMs: Schema.Number,
  resolvedAtMs: Schema.optional(Schema.Number),
});
export type AskSummary = typeof AskSummarySchema.Type;

export const RunSummarySchema = Schema.Struct({
  runId: RunId,
  role: AgentRole,
  trigger: RunTrigger,
  appId: Schema.String,
  envId: Schema.String,
  incidentId: Schema.optional(IncidentId),
  model: Schema.String,
  status: RunStatus,
  sessionId: Schema.optional(Schema.String),
  worktreePath: Schema.optional(Schema.String),
  awakeElapsedMs: Schema.Number,
  maxAwakeMs: Schema.Number,
  connectorCalls: Schema.Number,
  maxConnectorCalls: Schema.Number,
  totalToolCalls: Schema.Number,
  spentUsd: Schema.Number,
  maxUsd: Schema.Number,
  summary: Schema.optional(Schema.String),
  judgeScore: Schema.optional(Schema.Number),
  startedAtMs: Schema.Number,
  completedAtMs: Schema.optional(Schema.Number),
});
export type RunSummary = typeof RunSummarySchema.Type;

export const ActionSummarySchema = Schema.Struct({
  actionId: ActionId,
  kind: ActionKind,
  status: ActionStatus,
  appId: Schema.String,
  envId: Schema.String,
  repo: Schema.String,
  title: Schema.String,
  branch: Schema.optional(Schema.String),
  incidentId: Schema.optional(IncidentId),
  artifactUrl: Schema.optional(Schema.String),
  artifactNumber: Schema.optional(Schema.Number),
  reconciled: Schema.Boolean,
  requestedAtMs: Schema.Number,
  completedAtMs: Schema.optional(Schema.Number),
});
export type ActionSummary = typeof ActionSummarySchema.Type;

export const NowViewStateSchema = Schema.Struct({
  environments: Schema.Record(Schema.String, EnvironmentRecordSchema),
  incidents: Schema.Record(Schema.String, IncidentSummarySchema),
  pendingAsks: Schema.Record(Schema.String, AskSummarySchema),
  activeRuns: Schema.Record(Schema.String, RunSummarySchema),
  actions: Schema.Record(Schema.String, ActionSummarySchema),
  activeInsightCount: Schema.Number,
  watchRuleCount: Schema.Number,
  dailySpendUsd: Schema.Number,
  wakeCount: Schema.Number,
  lastWakeAtMs: Schema.optional(Schema.Number),
  lastWakeGapMs: Schema.optional(Schema.Number),
});
export type NowViewState = typeof NowViewStateSchema.Type;

export class NowView extends Domain.View("NowView", {
  from: [Incident, Ask, Run, Catalog, Action],
  key: Schema.String,
  keyOf: {
    Incident: globalKey,
    Ask: globalKey,
    Run: globalKey,
    Catalog: globalKey,
    Action: globalKey,
  },
  state: NowViewStateSchema,
  initial: {
    environments: {},
    incidents: {},
    pendingAsks: {},
    activeRuns: {},
    actions: {},
    activeInsightCount: 0,
    watchRuleCount: 0,
    dailySpendUsd: 0,
    wakeCount: 0,
  },
  evolve: {
    EnvironmentRegistered: (s, ev) => ({
      ...s,
      environments: { ...s.environments, [ev.env.envKey]: ev.env },
    }),
    ConnectorCoverageUpdated: (s, ev) => {
      const prev = s.environments[ev.envKey];
      if (!prev) return s;
      return {
        ...s,
        environments: {
          ...s.environments,
          [ev.envKey]: {
            ...prev,
            coverage: ev.coverage,
            coverageDetail: ev.detail,
            lastCollectedAtMs: ev.collectedAtMs,
          },
        },
      };
    },
    RolloutRecorded: (s, ev) => {
      const prev = s.environments[ev.envKey];
      if (!prev) return s;
      return {
        ...s,
        environments: {
          ...s.environments,
          [ev.envKey]: {
            ...prev,
            activeRolloutId: ev.rolloutId,
            activeRolloutUntilMs: ev.watchUntilMs,
            latestCommitSha: ev.commitSha,
            latestBuildNumber: ev.buildNumber ?? prev.latestBuildNumber,
          },
        },
      };
    },
    WatchRuleUpserted: (s) => ({ ...s, watchRuleCount: s.watchRuleCount + 1 }),
    InsightRecorded: (s) => ({ ...s, activeInsightCount: s.activeInsightCount + 1 }),
    InsightPromotedToWatch: (s) => ({
      ...s,
      activeInsightCount: Math.max(0, s.activeInsightCount - 1),
      watchRuleCount: s.watchRuleCount + 1,
    }),
    InsightPromotedToIncident: (s) => ({
      ...s,
      activeInsightCount: Math.max(0, s.activeInsightCount - 1),
    }),
    InsightDismissed: (s) => ({
      ...s,
      activeInsightCount: Math.max(0, s.activeInsightCount - 1),
    }),
    HostWakeRecorded: (s, ev) => ({
      ...s,
      wakeCount: s.wakeCount + 1,
      lastWakeAtMs: ev.wokeAtMs,
      lastWakeGapMs: ev.gapMs,
    }),
    IncidentOpened: (s, ev, ctx) => {
      const id = ctx.source.id as IncidentId;
      return {
        ...s,
        incidents: {
          ...s.incidents,
          [id]: {
            incidentId: id,
            appId: ev.appId,
            envId: ev.envId,
            headline: ev.headline,
            severity: ev.severity,
            status: "investigating" as const,
            signalCount: 1,
            recoveryCleanWindows: 0,
            recoveryTargetK: ev.recoveryTargetK,
            rolloutId: ev.rolloutId,
            commitSha: ev.commitSha,
            tags: ev.tags,
            openedAtMs: ev.openedAtMs,
            lastAnomalyAtMs: ev.signal.observedAtMs,
          },
        },
      };
    },
    SignalAttached: (s, ev, ctx) => {
      const id = ctx.source.id;
      const prev = s.incidents[id];
      if (!prev) return s;
      return {
        ...s,
        incidents: {
          ...s.incidents,
          [id]: {
            ...prev,
            severity: ev.escalatedSeverity ?? prev.severity,
            status: ev.reopened ? ("investigating" as const) : prev.status,
            signalCount: prev.signalCount + 1,
            recoveryCleanWindows: 0,
            lastAnomalyAtMs: Math.max(prev.lastAnomalyAtMs, ev.signal.observedAtMs),
          },
        },
      };
    },
    UnderstandingUpdated: (s, ev, ctx) => {
      const id = ctx.source.id;
      const prev = s.incidents[id];
      if (!prev || !ev.headline) return s;
      return {
        ...s,
        incidents: { ...s.incidents, [id]: { ...prev, headline: ev.headline } },
      };
    },
    IncidentEnteredMitigating: (s, _ev, ctx) => {
      const id = ctx.source.id;
      const prev = s.incidents[id];
      if (!prev) return s;
      return {
        ...s,
        incidents: { ...s.incidents, [id]: { ...prev, status: "mitigating" as const } },
      };
    },
    IncidentEnteredWatching: (s, _ev, ctx) => {
      const id = ctx.source.id;
      const prev = s.incidents[id];
      if (!prev) return s;
      return {
        ...s,
        incidents: {
          ...s.incidents,
          [id]: { ...prev, status: "watching" as const, recoveryCleanWindows: 0 },
        },
      };
    },
    CleanWindowRecorded: (s, ev, ctx) => {
      const id = ctx.source.id;
      const prev = s.incidents[id];
      if (!prev) return s;
      return {
        ...s,
        incidents: {
          ...s.incidents,
          [id]: { ...prev, recoveryCleanWindows: ev.cleanWindows },
        },
      };
    },
    RecoveryWindowReset: (s, _ev, ctx) => {
      const id = ctx.source.id;
      const prev = s.incidents[id];
      if (!prev) return s;
      return {
        ...s,
        incidents: { ...s.incidents, [id]: { ...prev, recoveryCleanWindows: 0 } },
      };
    },
    IncidentResolved: (s, ev, ctx) => {
      const id = ctx.source.id;
      const prev = s.incidents[id];
      if (!prev) return s;
      return {
        ...s,
        incidents: {
          ...s.incidents,
          [id]: { ...prev, status: "resolved" as const, resolvedAtMs: ev.resolvedAtMs },
        },
      };
    },
    IncidentDismissed: (s, ev, ctx) => {
      const id = ctx.source.id;
      const prev = s.incidents[id];
      if (!prev) return s;
      return {
        ...s,
        incidents: {
          ...s.incidents,
          [id]: { ...prev, status: "dismissed" as const, resolvedAtMs: ev.dismissedAtMs },
        },
      };
    },
    AskOpened: (s, ev, ctx) => {
      const askId = ctx.source.id as AskId;
      return {
        ...s,
        pendingAsks: {
          ...s.pendingAsks,
          [askId]: {
            askId,
            kind: ev.kind,
            status: "pending" as const,
            question: ev.question,
            whyItMatters: ev.whyItMatters,
            options: [...ev.options],
            recommendedOptionId: ev.recommendedOptionId,
            incidentId: ev.incidentId,
            runId: ev.runId,
            actionId: ev.actionId,
            sessionId: ev.sessionId,
            openedAtMs: ev.openedAtMs,
          },
        },
      };
    },
    AskAnswered: (s, _ev, ctx) => {
      const next = { ...s.pendingAsks };
      delete next[ctx.source.id];
      return { ...s, pendingAsks: next };
    },
    AskSupersededByChat: (s, _ev, ctx) => {
      const next = { ...s.pendingAsks };
      delete next[ctx.source.id];
      return { ...s, pendingAsks: next };
    },
    RunStarted: (s, ev, ctx) => {
      const runId = ctx.source.id as RunId;
      const nextIncidents =
        ev.incidentId && s.incidents[ev.incidentId]
          ? {
              ...s.incidents,
              [ev.incidentId]: { ...s.incidents[ev.incidentId]!, activeRunId: runId },
            }
          : s.incidents;
      return {
        ...s,
        incidents: nextIncidents,
        activeRuns: {
          ...s.activeRuns,
          [runId]: {
            runId,
            role: ev.role,
            trigger: ev.trigger,
            appId: ev.appId,
            envId: ev.envId,
            incidentId: ev.incidentId,
            model: ev.model,
            status: "running" as const,
            awakeElapsedMs: 0,
            maxAwakeMs: ev.budget.maxAwakeMs,
            connectorCalls: 0,
            maxConnectorCalls: ev.budget.maxConnectorCalls,
            totalToolCalls: 0,
            spentUsd: 0,
            maxUsd: ev.budget.maxUsd,
            startedAtMs: ev.startedAtMs,
          },
        },
      };
    },
    RunSessionAssigned: (s, ev, ctx) => {
      const prev = s.activeRuns[ctx.source.id];
      if (!prev) return s;
      return {
        ...s,
        activeRuns: {
          ...s.activeRuns,
          [ctx.source.id]: {
            ...prev,
            sessionId: ev.sessionId,
            worktreePath: ev.worktreePath ?? prev.worktreePath,
          },
        },
      };
    },
    RunUsageRecorded: (s, ev, ctx) => {
      const prev = s.activeRuns[ctx.source.id];
      const nextDaily = Number((s.dailySpendUsd + ev.usdDelta).toFixed(6));
      if (!prev) return { ...s, dailySpendUsd: nextDaily };
      return {
        ...s,
        dailySpendUsd: nextDaily,
        activeRuns: {
          ...s.activeRuns,
          [ctx.source.id]: {
            ...prev,
            connectorCalls: prev.connectorCalls + ev.connectorCallsDelta,
            totalToolCalls: prev.totalToolCalls + ev.toolCallsDelta,
            spentUsd: Number((prev.spentUsd + ev.usdDelta).toFixed(6)),
            awakeElapsedMs: prev.awakeElapsedMs + ev.awakeDeltaMs,
          },
        },
      };
    },
    RunSuspendedForAsk: (s, _ev, ctx) => {
      const prev = s.activeRuns[ctx.source.id];
      if (!prev) return s;
      return {
        ...s,
        activeRuns: {
          ...s.activeRuns,
          [ctx.source.id]: { ...prev, status: "awaiting_ask" as const },
        },
      };
    },
    RunResumed: (s, _ev, ctx) => {
      const prev = s.activeRuns[ctx.source.id];
      if (!prev) return s;
      return {
        ...s,
        activeRuns: {
          ...s.activeRuns,
          [ctx.source.id]: { ...prev, status: "running" as const },
        },
      };
    },
    RunCompleted: (s, _ev, ctx) => {
      const next = { ...s.activeRuns };
      delete next[ctx.source.id];
      return { ...s, activeRuns: next };
    },
    RunBudgetExhausted: (s, _ev, ctx) => {
      const next = { ...s.activeRuns };
      delete next[ctx.source.id];
      return { ...s, activeRuns: next };
    },
    RunFailed: (s, _ev, ctx) => {
      const next = { ...s.activeRuns };
      delete next[ctx.source.id];
      return { ...s, activeRuns: next };
    },
    ActionRequested: (s, ev, ctx) => {
      const actionId = ctx.source.id as ActionId;
      return {
        ...s,
        actions: {
          ...s.actions,
          [actionId]: {
            actionId,
            kind: ev.kind,
            status: ev.requiresApproval ? ("awaiting_approval" as const) : ("approved" as const),
            appId: ev.appId,
            envId: ev.envId,
            repo: ev.repo,
            title: ev.title,
            branch: ev.branch,
            incidentId: ev.incidentId,
            reconciled: false,
            requestedAtMs: ev.requestedAtMs,
          },
        },
      };
    },
    ActionApproved: (s, _ev, ctx) => {
      const prev = s.actions[ctx.source.id];
      if (!prev) return s;
      return {
        ...s,
        actions: { ...s.actions, [ctx.source.id]: { ...prev, status: "approved" as const } },
      };
    },
    ActionExecutionStarted: (s, _ev, ctx) => {
      const prev = s.actions[ctx.source.id];
      if (!prev) return s;
      return {
        ...s,
        actions: { ...s.actions, [ctx.source.id]: { ...prev, status: "executing" as const } },
      };
    },
    ActionCompleted: (s, ev, ctx) => {
      const prev = s.actions[ctx.source.id];
      if (!prev) return s;
      return {
        ...s,
        actions: {
          ...s.actions,
          [ctx.source.id]: {
            ...prev,
            status: "completed" as const,
            artifactUrl: ev.artifactUrl,
            artifactNumber: ev.artifactNumber,
            reconciled: ev.reconciled,
            completedAtMs: ev.completedAtMs,
          },
        },
      };
    },
    ActionRejected: (s, _ev, ctx) => {
      const prev = s.actions[ctx.source.id];
      if (!prev) return s;
      return {
        ...s,
        actions: { ...s.actions, [ctx.source.id]: { ...prev, status: "rejected" as const } },
      };
    },
    ActionFailed: (s, _ev, ctx) => {
      const prev = s.actions[ctx.source.id];
      if (!prev) return s;
      return {
        ...s,
        actions: { ...s.actions, [ctx.source.id]: { ...prev, status: "failed" as const } },
      };
    },
  },
}) {}

export const IncidentDetailStateSchema = Schema.Struct({
  exists: Schema.Boolean,
  incidentId: Schema.String,
  appId: Schema.String,
  envId: Schema.String,
  headline: Schema.String,
  severity: Severity,
  status: IncidentStatus,
  rolloutId: Schema.optional(Schema.String),
  commitSha: Schema.optional(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  signals: Schema.Array(SignalRecordSchema),
  understanding: Schema.Array(UnderstandingBulletSchema),
  findings: Schema.Array(FindingRecordSchema),
  verificationBundles: Schema.Array(VerificationBundleSchema),
  linkedRunIds: Schema.Array(RunId),
  actionIds: Schema.Array(ActionId),
  chat: Schema.Array(IncidentChatEntrySchema),
  recoveryCleanWindows: Schema.Number,
  recoveryTargetK: Schema.Number,
  lastCoverage: ConnectorCoverage,
  openedAtMs: Schema.Number,
  lastAnomalyAtMs: Schema.Number,
  resolvedAtMs: Schema.optional(Schema.Number),
  feedbackVote: Schema.optional(Schema.Literals(["up", "down"])),
  feedbackReason: Schema.optional(Schema.String),
});
export type IncidentDetailState = typeof IncidentDetailStateSchema.Type;

export class IncidentDetailView extends Domain.View("IncidentDetailView", {
  from: [Incident],
  key: Incident,
  state: IncidentDetailStateSchema,
  initial: {
    exists: false,
    incidentId: "",
    appId: "",
    envId: "",
    headline: "",
    severity: "info",
    status: "investigating" as const,
    tags: {},
    signals: [],
    understanding: [],
    findings: [],
    verificationBundles: [],
    linkedRunIds: [],
    actionIds: [],
    chat: [],
    recoveryCleanWindows: 0,
    recoveryTargetK: 3,
    lastCoverage: "healthy" as const,
    openedAtMs: 0,
    lastAnomalyAtMs: 0,
  },
  evolve: {
    IncidentOpened: (_s, ev, ctx) => ({
      exists: true,
      incidentId: ctx.source.id,
      appId: ev.appId,
      envId: ev.envId,
      headline: ev.headline,
      severity: ev.severity,
      status: "investigating" as const,
      rolloutId: ev.rolloutId,
      commitSha: ev.commitSha,
      tags: ev.tags,
      signals: [ev.signal],
      understanding: [],
      findings: [],
      verificationBundles: [],
      linkedRunIds: [],
      actionIds: [],
      chat: [],
      recoveryCleanWindows: 0,
      recoveryTargetK: ev.recoveryTargetK,
      lastCoverage: "healthy" as const,
      openedAtMs: ev.openedAtMs,
      lastAnomalyAtMs: ev.signal.observedAtMs,
    }),
    SignalAttached: (s, ev) => ({
      ...s,
      severity: ev.escalatedSeverity ?? s.severity,
      status: ev.reopened ? ("investigating" as const) : s.status,
      signals: [...s.signals, ev.signal],
      recoveryCleanWindows: 0,
      lastAnomalyAtMs: Math.max(s.lastAnomalyAtMs, ev.signal.observedAtMs),
    }),
    UnderstandingUpdated: (s, ev) => ({
      ...s,
      headline: ev.headline ?? s.headline,
      understanding: [...ev.bullets],
    }),
    FindingRecorded: (s, ev) => ({
      ...s,
      findings: [...s.findings, ev.finding],
    }),
    IncidentRunLinked: (s, ev) => ({
      ...s,
      linkedRunIds: s.linkedRunIds.includes(ev.runId)
        ? s.linkedRunIds
        : [...s.linkedRunIds, ev.runId],
    }),
    IncidentActionLinked: (s, ev) => ({
      ...s,
      actionIds: s.actionIds.includes(ev.actionId) ? s.actionIds : [...s.actionIds, ev.actionId],
    }),
    VerificationBundleRecorded: (s, ev) => ({
      ...s,
      verificationBundles: [...s.verificationBundles, ev.bundle],
    }),
    IncidentEnteredMitigating: (s) => ({ ...s, status: "mitigating" as const }),
    IncidentEnteredWatching: (s) => ({ ...s, status: "watching" as const, recoveryCleanWindows: 0 }),
    CleanWindowRecorded: (s, ev) => ({
      ...s,
      recoveryCleanWindows: ev.cleanWindows,
      lastCoverage: "healthy" as const,
    }),
    RecoveryWindowReset: (s, ev) => ({
      ...s,
      recoveryCleanWindows: 0,
      lastCoverage: ev.coverage,
    }),
    IncidentResolved: (s, ev) => ({
      ...s,
      status: "resolved" as const,
      resolvedAtMs: ev.resolvedAtMs,
    }),
    IncidentDismissed: (s, ev) => ({
      ...s,
      status: "dismissed" as const,
      resolvedAtMs: ev.dismissedAtMs,
    }),
    IncidentFeedbackRecorded: (s, ev) => ({
      ...s,
      feedbackVote: ev.vote,
      feedbackReason: ev.reason,
    }),
    IncidentChatPosted: (s, ev) => ({
      ...s,
      chat: [...s.chat, ev.entry],
    }),
  },
}) {}

export const NeedsMeViewStateSchema = Schema.Struct({
  pending: Schema.Array(AskSummarySchema),
  recent: Schema.Array(AskSummarySchema),
});
export type NeedsMeViewState = typeof NeedsMeViewStateSchema.Type;

export class NeedsMeView extends Domain.View("NeedsMeView", {
  from: [Ask],
  key: Schema.String,
  keyOf: { Ask: globalKey },
  state: NeedsMeViewStateSchema,
  initial: { pending: [], recent: [] },
  evolve: {
    AskOpened: (s, ev, ctx) => ({
      ...s,
      pending: [
        omitUndefined({
          askId: ctx.source.id as AskId,
          kind: ev.kind,
          status: "pending" as const,
          question: ev.question,
          whyItMatters: ev.whyItMatters,
          options: [...ev.options],
          recommendedOptionId: ev.recommendedOptionId,
          incidentId: ev.incidentId,
          runId: ev.runId,
          actionId: ev.actionId,
          sessionId: ev.sessionId,
          openedAtMs: ev.openedAtMs,
        }),
        ...s.pending.filter((a) => a.askId !== ctx.source.id),
      ],
    }),
    AskAnswered: (s, ev, ctx) => {
      const target = s.pending.find((a) => a.askId === ctx.source.id);
      const pending = s.pending.filter((a) => a.askId !== ctx.source.id);
      if (!target) return { ...s, pending };
      const updated: AskSummary = {
        ...target,
        status: "answered",
        selectedOptionId: ev.selectedOptionId,
        resolvedVia: ev.resolvedVia,
        resolvedAtMs: ev.resolvedAtMs,
      };
      return { pending, recent: [updated, ...s.recent].slice(0, 30) };
    },
    AskSupersededByChat: (s, ev, ctx) => {
      const target = s.pending.find((a) => a.askId === ctx.source.id);
      const pending = s.pending.filter((a) => a.askId !== ctx.source.id);
      if (!target) return { ...s, pending };
      const updated: AskSummary = {
        ...target,
        status: "superseded_by_chat",
        resolvedVia: "chat",
        resolvedAtMs: ev.resolvedAtMs,
      };
      return { pending, recent: [updated, ...s.recent].slice(0, 30) };
    },
  },
}) {}

export const InsightFeedStateSchema = Schema.Struct({
  insights: Schema.Array(InsightRecordSchema),
  watchRules: Schema.Array(WatchRuleRecordSchema),
});
export type InsightFeedState = typeof InsightFeedStateSchema.Type;

export class InsightFeedView extends Domain.View("InsightFeedView", {
  from: [Catalog],
  key: Schema.String,
  keyOf: { Catalog: globalKey },
  state: InsightFeedStateSchema,
  initial: { insights: [], watchRules: [] },
  evolve: {
    InsightRecorded: (s, ev) => ({
      ...s,
      insights: [ev.insight, ...s.insights.filter((i) => i.insightId !== ev.insight.insightId)],
    }),
    WatchRuleUpserted: (s, ev) => ({
      ...s,
      watchRules: [ev.rule, ...s.watchRules.filter((r) => r.ruleId !== ev.rule.ruleId)],
    }),
    InsightPromotedToWatch: (s, ev) => ({
      insights: s.insights.map((i) =>
        i.insightId === ev.insightId
          ? { ...i, status: "watching" as const, promotedRuleId: ev.rule.ruleId }
          : i,
      ),
      watchRules: [ev.rule, ...s.watchRules.filter((r) => r.ruleId !== ev.rule.ruleId)],
    }),
    InsightPromotedToIncident: (s, ev) => ({
      ...s,
      insights: s.insights.map((i) =>
        i.insightId === ev.insightId
          ? { ...i, status: "promoted" as const, promotedIncidentId: ev.incidentId }
          : i,
      ),
    }),
    InsightDismissed: (s, ev) => ({
      ...s,
      insights: s.insights.map((i) =>
        i.insightId === ev.insightId
          ? { ...i, status: "dismissed" as const, dismissReason: ev.reason }
          : i,
      ),
    }),
  },
}) {}

export const RunListStateSchema = Schema.Struct({
  runs: Schema.Array(RunSummarySchema),
});
export type RunListState = typeof RunListStateSchema.Type;

export class RunListView extends Domain.View("RunListView", {
  from: [Run],
  key: Schema.String,
  keyOf: { Run: globalKey },
  state: RunListStateSchema,
  initial: { runs: [] },
  evolve: {
    RunStarted: (s, ev, ctx) => ({
      runs: [
        {
          runId: ctx.source.id as RunId,
          role: ev.role,
          trigger: ev.trigger,
          appId: ev.appId,
          envId: ev.envId,
          incidentId: ev.incidentId,
          model: ev.model,
          status: "running" as const,
          awakeElapsedMs: 0,
          maxAwakeMs: ev.budget.maxAwakeMs,
          connectorCalls: 0,
          maxConnectorCalls: ev.budget.maxConnectorCalls,
          totalToolCalls: 0,
          spentUsd: 0,
          maxUsd: ev.budget.maxUsd,
          startedAtMs: ev.startedAtMs,
        },
        ...s.runs.filter((r) => r.runId !== ctx.source.id),
      ].slice(0, 100),
    }),
    RunSessionAssigned: (s, ev, ctx) => ({
      runs: s.runs.map((r) =>
        r.runId === ctx.source.id
          ? { ...r, sessionId: ev.sessionId, worktreePath: ev.worktreePath ?? r.worktreePath }
          : r,
      ),
    }),
    RunUsageRecorded: (s, ev, ctx) => ({
      runs: s.runs.map((r) =>
        r.runId === ctx.source.id
          ? {
              ...r,
              connectorCalls: r.connectorCalls + ev.connectorCallsDelta,
              totalToolCalls: r.totalToolCalls + ev.toolCallsDelta,
              spentUsd: Number((r.spentUsd + ev.usdDelta).toFixed(6)),
              awakeElapsedMs: r.awakeElapsedMs + ev.awakeDeltaMs,
            }
          : r,
      ),
    }),
    RunSuspendedForAsk: (s, _ev, ctx) => ({
      runs: s.runs.map((r) =>
        r.runId === ctx.source.id ? { ...r, status: "awaiting_ask" as const } : r,
      ),
    }),
    RunResumed: (s, _ev, ctx) => ({
      runs: s.runs.map((r) =>
        r.runId === ctx.source.id ? { ...r, status: "running" as const } : r,
      ),
    }),
    RunCompleted: (s, ev, ctx) => ({
      runs: s.runs.map((r) =>
        r.runId === ctx.source.id
          ? {
              ...r,
              status: "completed" as const,
              summary: ev.summary,
              completedAtMs: ev.completedAtMs,
            }
          : r,
      ),
    }),
    RunBudgetExhausted: (s, ev, ctx) => ({
      runs: s.runs.map((r) =>
        r.runId === ctx.source.id
          ? {
              ...r,
              status: "budget_exhausted" as const,
              completedAtMs: ev.completedAtMs,
            }
          : r,
      ),
    }),
    RunFailed: (s, ev, ctx) => ({
      runs: s.runs.map((r) =>
        r.runId === ctx.source.id
          ? {
              ...r,
              status: "failed" as const,
              summary: ev.reason,
              completedAtMs: ev.completedAtMs,
            }
          : r,
      ),
    }),
    RunJudgeScored: (s, ev, ctx) => ({
      runs: s.runs.map((r) =>
        r.runId === ctx.source.id ? { ...r, judgeScore: ev.score } : r,
      ),
    }),
  },
}) {}

export const ScorecardStateSchema = Schema.Struct({
  verdicts: Schema.Array(VerdictRecordSchema),
  proposals: Schema.Array(ProposalRecordSchema),
  feedbackUp: Schema.Number,
  feedbackDown: Schema.Number,
  incidentsOpened: Schema.Number,
  incidentsDismissed: Schema.Number,
  totalSpendUsd: Schema.Number,
  calibrationAgreementPct: Schema.Number,
});
export type ScorecardState = typeof ScorecardStateSchema.Type;

export class ScorecardView extends Domain.View("ScorecardView", {
  from: [Catalog, Incident, Run],
  key: Schema.String,
  keyOf: { Catalog: globalKey, Incident: globalKey, Run: globalKey },
  state: ScorecardStateSchema,
  initial: {
    verdicts: [],
    proposals: [],
    feedbackUp: 0,
    feedbackDown: 0,
    incidentsOpened: 0,
    incidentsDismissed: 0,
    totalSpendUsd: 0,
    calibrationAgreementPct: 100,
  },
  evolve: {
    VerdictRecorded: (s, ev) => {
      const verdicts = [ev.verdict, ...s.verdicts].slice(0, 100);
      const rated = verdicts.filter((v) => v.operatorAgreed !== undefined);
      const agreed = rated.filter((v) => v.operatorAgreed === true).length;
      const pct = rated.length === 0 ? 100 : Math.round((agreed / rated.length) * 100);
      return { ...s, verdicts, calibrationAgreementPct: pct };
    },
    ProposalRecorded: (s, ev) => ({
      ...s,
      proposals: [
        ev.proposal,
        ...s.proposals.filter((p) => p.proposalId !== ev.proposal.proposalId),
      ],
    }),
    ProposalDecided: (s, ev) => ({
      ...s,
      proposals: s.proposals.map((p) =>
        p.proposalId === ev.proposalId ? { ...p, status: ev.status } : p,
      ),
    }),
    IncidentOpened: (s) => ({ ...s, incidentsOpened: s.incidentsOpened + 1 }),
    IncidentDismissed: (s) => ({ ...s, incidentsDismissed: s.incidentsDismissed + 1 }),
    IncidentFeedbackRecorded: (s, ev) => ({
      ...s,
      feedbackUp: s.feedbackUp + (ev.vote === "up" ? 1 : 0),
      feedbackDown: s.feedbackDown + (ev.vote === "down" ? 1 : 0),
    }),
    RunUsageRecorded: (s, ev) => ({
      ...s,
      totalSpendUsd: Number((s.totalSpendUsd + ev.usdDelta).toFixed(6)),
    }),
  },
}) {}

export const BriefSummarySchema = Schema.Struct({
  briefId: BriefId,
  kind: BriefKind,
  status: BriefStatus,
  incidentId: Schema.optional(IncidentId),
  subject: Schema.String,
  body: Schema.String,
  recipients: Schema.Array(Schema.String),
  editDistanceChars: Schema.Number,
  createdAtMs: Schema.Number,
  sentAtMs: Schema.optional(Schema.Number),
});
export type BriefSummary = typeof BriefSummarySchema.Type;

export const BriefListStateSchema = Schema.Struct({
  briefs: Schema.Array(BriefSummarySchema),
});
export type BriefListState = typeof BriefListStateSchema.Type;

export class BriefListView extends Domain.View("BriefListView", {
  from: [Brief],
  key: Schema.String,
  keyOf: { Brief: globalKey },
  state: BriefListStateSchema,
  initial: { briefs: [] },
  evolve: {
    BriefDraftSaved: (s, ev, ctx) => ({
      briefs: [
        {
          briefId: ctx.source.id as BriefId,
          kind: ev.kind,
          status: "draft" as const,
          incidentId: ev.incidentId,
          subject: ev.subject,
          body: ev.body,
          recipients: [...ev.recipients],
          editDistanceChars: 0,
          createdAtMs: ev.createdAtMs,
        },
        ...s.briefs.filter((b) => b.briefId !== ctx.source.id),
      ],
    }),
    BriefDraftEdited: (s, ev, ctx) => ({
      briefs: s.briefs.map((b) =>
        b.briefId === ctx.source.id
          ? { ...b, body: ev.body, editDistanceChars: ev.editDistanceChars }
          : b,
      ),
    }),
    BriefApproved: (s, _ev, ctx) => ({
      briefs: s.briefs.map((b) =>
        b.briefId === ctx.source.id ? { ...b, status: "approved" as const } : b,
      ),
    }),
    BriefSent: (s, ev, ctx) => ({
      briefs: s.briefs.map((b) =>
        b.briefId === ctx.source.id
          ? { ...b, status: "sent" as const, sentAtMs: ev.sentAtMs }
          : b,
      ),
    }),
  },
}) {}
