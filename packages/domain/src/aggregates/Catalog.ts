import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { OutputBudgetExceeded, validateInsightBudget } from "../budgets.ts";
import {
  CatalogId,
  ConnectorCoverage,
  EvidenceId,
  FeedbackReason,
  IncidentId,
  InsightId,
  RunId,
  Severity,
  WatchRuleId,
} from "../ids.ts";

export const EnvironmentRecordSchema = Schema.Struct({
  envKey: Schema.String, // `${appId}:${envId}`
  appId: Schema.String,
  envId: Schema.String,
  displayName: Schema.String,
  tags: Schema.Record(Schema.String, Schema.String),
  region: Schema.String,
  coverage: ConnectorCoverage,
  coverageDetail: Schema.String,
  activeRolloutId: Schema.optional(Schema.String),
  activeRolloutUntilMs: Schema.optional(Schema.Number),
  latestCommitSha: Schema.optional(Schema.String),
  latestBuildNumber: Schema.optional(Schema.Number),
  lastCollectedAtMs: Schema.optional(Schema.Number),
});
export type EnvironmentRecord = typeof EnvironmentRecordSchema.Type;

export const WatchRuleRecordSchema = Schema.Struct({
  ruleId: WatchRuleId,
  name: Schema.String,
  appId: Schema.String,
  envId: Schema.String,
  metric: Schema.String,
  operator: Schema.Literals(["gt", "gte", "ratio_gt"]),
  threshold: Schema.Number,
  hysteresisCount: Schema.Number,
  severity: Severity,
  sourceInsightId: Schema.optional(InsightId),
  enabled: Schema.Boolean,
});
export type WatchRuleRecord = typeof WatchRuleRecordSchema.Type;

export const InsightRecordSchema = Schema.Struct({
  insightId: InsightId,
  appId: Schema.String,
  envId: Schema.String,
  claim: Schema.String,
  whyItMatters: Schema.String,
  recurrenceCount: Schema.Number,
  evidenceIds: Schema.Array(EvidenceId),
  sourceMode: Schema.Literals(["trace_walk", "log_cluster", "resource_drift", "overnight_spike", "rollout_retro"]),
  status: Schema.Literals(["active", "watching", "promoted", "dismissed"]),
  promotedRuleId: Schema.optional(WatchRuleId),
  promotedIncidentId: Schema.optional(IncidentId),
  dismissReason: Schema.optional(FeedbackReason),
  recordedAtMs: Schema.Number,
});
export type InsightRecord = typeof InsightRecordSchema.Type;

export const VerdictRecordSchema = Schema.Struct({
  verdictId: Schema.String,
  runId: RunId,
  judgeModel: Schema.String,
  grounded: Schema.Boolean,
  concise: Schema.Boolean,
  actionable: Schema.Boolean,
  severityCalibrated: Schema.Boolean,
  scopeDisciplined: Schema.Boolean,
  score: Schema.Number,
  operatorAgreed: Schema.optional(Schema.Boolean),
  recordedAtMs: Schema.Number,
});
export type VerdictRecord = typeof VerdictRecordSchema.Type;

export const ProposalRecordSchema = Schema.Struct({
  proposalId: Schema.String,
  title: Schema.String,
  targetPath: Schema.String,
  rationale: Schema.String,
  diffPreview: Schema.String,
  beforeReplayScore: Schema.Number,
  afterReplayScore: Schema.Number,
  status: Schema.Literals(["pending", "approved", "rejected"]),
  createdAtMs: Schema.Number,
});
export type ProposalRecord = typeof ProposalRecordSchema.Type;

export const CatalogStateSchema = Schema.Struct({
  environments: Schema.Record(Schema.String, EnvironmentRecordSchema),
  watchRules: Schema.Record(Schema.String, WatchRuleRecordSchema),
  insights: Schema.Record(Schema.String, InsightRecordSchema),
  verdicts: Schema.Array(VerdictRecordSchema),
  proposals: Schema.Record(Schema.String, ProposalRecordSchema),
  lastWakeAtMs: Schema.optional(Schema.Number),
  lastWakeGapMs: Schema.optional(Schema.Number),
  wakeCount: Schema.Number,
});
export type CatalogState = typeof CatalogStateSchema.Type;

export class InsightNotFound extends Domain.Rejection("InsightNotFound", {
  insightId: InsightId,
}) {}

export class ProposalNotFound extends Domain.Rejection("ProposalNotFound", {
  proposalId: Schema.String,
}) {}

export class EnvironmentRegistered extends Domain.Event("EnvironmentRegistered", {
  env: EnvironmentRecordSchema,
}) {}

export class ConnectorCoverageUpdated extends Domain.Event("ConnectorCoverageUpdated", {
  envKey: Schema.String,
  coverage: ConnectorCoverage,
  detail: Schema.String,
  collectedAtMs: Schema.Number,
}) {}

export class RolloutRecorded extends Domain.Event("RolloutRecorded", {
  envKey: Schema.String,
  rolloutId: Schema.String,
  commitSha: Schema.String,
  buildNumber: Schema.optional(Schema.Number),
  watchUntilMs: Schema.Number,
}) {}

export class WatchRuleUpserted extends Domain.Event("WatchRuleUpserted", {
  rule: WatchRuleRecordSchema,
}) {}

export class InsightRecorded extends Domain.Event("InsightRecorded", {
  insight: InsightRecordSchema,
}) {}

export class InsightPromotedToWatch extends Domain.Event("InsightPromotedToWatch", {
  insightId: InsightId,
  rule: WatchRuleRecordSchema,
}) {}

export class InsightPromotedToIncident extends Domain.Event("InsightPromotedToIncident", {
  insightId: InsightId,
  incidentId: IncidentId,
}) {}

export class InsightDismissed extends Domain.Event("InsightDismissed", {
  insightId: InsightId,
  reason: FeedbackReason,
}) {}

export class VerdictRecorded extends Domain.Event("VerdictRecorded", {
  verdict: VerdictRecordSchema,
}) {}

export class ProposalRecorded extends Domain.Event("ProposalRecorded", {
  proposal: ProposalRecordSchema,
}) {}

export class ProposalDecided extends Domain.Event("ProposalDecided", {
  proposalId: Schema.String,
  status: Schema.Literals(["approved", "rejected"]),
}) {}

export class HostWakeRecorded extends Domain.Event("HostWakeRecorded", {
  sleptAtMs: Schema.Number,
  wokeAtMs: Schema.Number,
  gapMs: Schema.Number,
  tier: Schema.Literals(["short_nap", "overnight", "extended_offline"]),
}) {}

export class RegisterEnvironment extends Domain.Command("RegisterEnvironment", {
  target: CatalogId,
  input: { env: EnvironmentRecordSchema },
  events: [EnvironmentRegistered],
}) {}

export class UpdateConnectorCoverage extends Domain.Command("UpdateConnectorCoverage", {
  target: CatalogId,
  input: {
    envKey: Schema.String,
    coverage: ConnectorCoverage,
    detail: Schema.String,
  },
  events: [ConnectorCoverageUpdated],
}) {}

export class RecordRollout extends Domain.Command("RecordRollout", {
  target: CatalogId,
  input: {
    envKey: Schema.String,
    rolloutId: Schema.String,
    commitSha: Schema.String,
    buildNumber: Schema.optional(Schema.Number),
    watchDurationMs: Schema.optional(Schema.Number),
  },
  events: [RolloutRecorded],
}) {}

export class UpsertWatchRule extends Domain.Command("UpsertWatchRule", {
  target: CatalogId,
  input: { rule: WatchRuleRecordSchema },
  events: [WatchRuleUpserted],
}) {}

export class RecordInsight extends Domain.Command("RecordInsight", {
  target: CatalogId,
  input: {
    insightId: InsightId,
    appId: Schema.String,
    envId: Schema.String,
    claim: Schema.String,
    whyItMatters: Schema.String,
    recurrenceCount: Schema.Number,
    evidenceIds: Schema.Array(EvidenceId),
    sourceMode: Schema.Literals([
      "trace_walk",
      "log_cluster",
      "resource_drift",
      "overnight_spike",
      "rollout_retro",
    ]),
  },
  events: [InsightRecorded],
  rejects: [OutputBudgetExceeded],
}) {}

export class PromoteInsightToWatch extends Domain.Command("PromoteInsightToWatch", {
  target: CatalogId,
  input: {
    insightId: InsightId,
    ruleId: WatchRuleId,
    name: Schema.String,
    metric: Schema.String,
    operator: Schema.Literals(["gt", "gte", "ratio_gt"]),
    threshold: Schema.Number,
    severity: Severity,
  },
  events: [InsightPromotedToWatch],
  rejects: [InsightNotFound],
}) {}

export class PromoteInsightToIncident extends Domain.Command("PromoteInsightToIncident", {
  target: CatalogId,
  input: {
    insightId: InsightId,
    incidentId: IncidentId,
  },
  events: [InsightPromotedToIncident],
  rejects: [InsightNotFound],
}) {}

export class DismissInsight extends Domain.Command("DismissInsight", {
  target: CatalogId,
  input: {
    insightId: InsightId,
    reason: FeedbackReason,
  },
  events: [InsightDismissed],
  rejects: [InsightNotFound],
}) {}

export class RecordVerdict extends Domain.Command("RecordVerdict", {
  target: CatalogId,
  input: {
    verdict: VerdictRecordSchema,
  },
  events: [VerdictRecorded],
}) {}

export class RecordProposal extends Domain.Command("RecordProposal", {
  target: CatalogId,
  input: {
    proposal: ProposalRecordSchema,
  },
  events: [ProposalRecorded],
}) {}

export class DecideProposal extends Domain.Command("DecideProposal", {
  target: CatalogId,
  input: {
    proposalId: Schema.String,
    status: Schema.Literals(["approved", "rejected"]),
  },
  events: [ProposalDecided],
  rejects: [ProposalNotFound],
}) {}

export class RecordHostWake extends Domain.Command("RecordHostWake", {
  target: CatalogId,
  input: {
    sleptAtMs: Schema.Number,
    wokeAtMs: Schema.Number,
    gapMs: Schema.Number,
  },
  events: [HostWakeRecorded],
}) {}

const initialCatalogState: CatalogState = {
  environments: {},
  watchRules: {},
  insights: {},
  verdicts: [],
  proposals: {},
  wakeCount: 0,
};

export class Catalog extends Domain.Aggregate("Catalog", {
  id: CatalogId,
  state: CatalogStateSchema,
  initial: initialCatalogState,
  commands: [
    RegisterEnvironment,
    UpdateConnectorCoverage,
    RecordRollout,
    UpsertWatchRule,
    RecordInsight,
    PromoteInsightToWatch,
    PromoteInsightToIncident,
    DismissInsight,
    RecordVerdict,
    RecordProposal,
    DecideProposal,
    RecordHostWake,
  ],
  decide: {
    RegisterEnvironment: (_state, cmd) => [new EnvironmentRegistered({ env: cmd.env })],
    UpdateConnectorCoverage: (_state, cmd, ctx) => [
      new ConnectorCoverageUpdated({
        envKey: cmd.envKey,
        coverage: cmd.coverage,
        detail: cmd.detail,
        collectedAtMs: ctx.now.epochMilliseconds,
      }),
    ],
    RecordRollout: (_state, cmd, ctx) => [
      new RolloutRecorded({
        envKey: cmd.envKey,
        rolloutId: cmd.rolloutId,
        commitSha: cmd.commitSha,
        buildNumber: cmd.buildNumber,
        watchUntilMs: ctx.now.epochMilliseconds + (cmd.watchDurationMs ?? 30 * 60_000),
      }),
    ],
    UpsertWatchRule: (_state, cmd) => [new WatchRuleUpserted({ rule: cmd.rule })],
    RecordInsight: (_state, cmd, ctx) => {
      const err = validateInsightBudget({
        claim: cmd.claim,
        whyItMatters: cmd.whyItMatters,
        evidenceIds: cmd.evidenceIds,
      });
      if (err) return err;
      return [
        new InsightRecorded({
          insight: {
            insightId: cmd.insightId,
            appId: cmd.appId,
            envId: cmd.envId,
            claim: cmd.claim,
            whyItMatters: cmd.whyItMatters,
            recurrenceCount: cmd.recurrenceCount,
            evidenceIds: cmd.evidenceIds,
            sourceMode: cmd.sourceMode,
            status: "active",
            recordedAtMs: ctx.now.epochMilliseconds,
          },
        }),
      ];
    },
    PromoteInsightToWatch: (state, cmd) => {
      const existing = state.insights[cmd.insightId];
      if (!existing) return new InsightNotFound({ insightId: cmd.insightId });
      return [
        new InsightPromotedToWatch({
          insightId: cmd.insightId,
          rule: {
            ruleId: cmd.ruleId,
            name: cmd.name,
            appId: existing.appId,
            envId: existing.envId,
            metric: cmd.metric,
            operator: cmd.operator,
            threshold: cmd.threshold,
            hysteresisCount: 2,
            severity: cmd.severity,
            sourceInsightId: cmd.insightId,
            enabled: true,
          },
        }),
      ];
    },
    PromoteInsightToIncident: (state, cmd) => {
      if (!state.insights[cmd.insightId]) {
        return new InsightNotFound({ insightId: cmd.insightId });
      }
      return [
        new InsightPromotedToIncident({
          insightId: cmd.insightId,
          incidentId: cmd.incidentId,
        }),
      ];
    },
    DismissInsight: (state, cmd) => {
      if (!state.insights[cmd.insightId]) {
        return new InsightNotFound({ insightId: cmd.insightId });
      }
      return [new InsightDismissed({ insightId: cmd.insightId, reason: cmd.reason })];
    },
    RecordVerdict: (_state, cmd) => [new VerdictRecorded({ verdict: cmd.verdict })],
    RecordProposal: (_state, cmd) => [new ProposalRecorded({ proposal: cmd.proposal })],
    DecideProposal: (state, cmd) => {
      if (!state.proposals[cmd.proposalId]) {
        return new ProposalNotFound({ proposalId: cmd.proposalId });
      }
      return [new ProposalDecided({ proposalId: cmd.proposalId, status: cmd.status })];
    },
    RecordHostWake: (_state, cmd) => {
      const tier =
        cmd.gapMs <= 15 * 60_000
          ? "short_nap"
          : cmd.gapMs <= 72 * 60 * 60_000
            ? "overnight"
            : "extended_offline";
      return [
        new HostWakeRecorded({
          sleptAtMs: cmd.sleptAtMs,
          wokeAtMs: cmd.wokeAtMs,
          gapMs: cmd.gapMs,
          tier,
        }),
      ];
    },
  },
  evolve: {
    EnvironmentRegistered: (state, ev) => ({
      ...state,
      environments: { ...state.environments, [ev.env.envKey]: ev.env },
    }),
    ConnectorCoverageUpdated: (state, ev) => {
      const prev = state.environments[ev.envKey];
      if (!prev) return state;
      return {
        ...state,
        environments: {
          ...state.environments,
          [ev.envKey]: {
            ...prev,
            coverage: ev.coverage,
            coverageDetail: ev.detail,
            lastCollectedAtMs: ev.collectedAtMs,
          },
        },
      };
    },
    RolloutRecorded: (state, ev) => {
      const prev = state.environments[ev.envKey];
      if (!prev) return state;
      return {
        ...state,
        environments: {
          ...state.environments,
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
    WatchRuleUpserted: (state, ev) => ({
      ...state,
      watchRules: { ...state.watchRules, [ev.rule.ruleId]: ev.rule },
    }),
    InsightRecorded: (state, ev) => ({
      ...state,
      insights: { ...state.insights, [ev.insight.insightId]: ev.insight },
    }),
    InsightPromotedToWatch: (state, ev) => {
      const prev = state.insights[ev.insightId];
      return {
        ...state,
        watchRules: { ...state.watchRules, [ev.rule.ruleId]: ev.rule },
        insights: prev
          ? {
              ...state.insights,
              [ev.insightId]: {
                ...prev,
                status: "watching" as const,
                promotedRuleId: ev.rule.ruleId,
              },
            }
          : state.insights,
      };
    },
    InsightPromotedToIncident: (state, ev) => {
      const prev = state.insights[ev.insightId];
      if (!prev) return state;
      return {
        ...state,
        insights: {
          ...state.insights,
          [ev.insightId]: {
            ...prev,
            status: "promoted" as const,
            promotedIncidentId: ev.incidentId,
          },
        },
      };
    },
    InsightDismissed: (state, ev) => {
      const prev = state.insights[ev.insightId];
      if (!prev) return state;
      return {
        ...state,
        insights: {
          ...state.insights,
          [ev.insightId]: {
            ...prev,
            status: "dismissed" as const,
            dismissReason: ev.reason,
          },
        },
      };
    },
    VerdictRecorded: (state, ev) => ({
      ...state,
      verdicts: [...state.verdicts, ev.verdict],
    }),
    ProposalRecorded: (state, ev) => ({
      ...state,
      proposals: { ...state.proposals, [ev.proposal.proposalId]: ev.proposal },
    }),
    ProposalDecided: (state, ev) => {
      const prev = state.proposals[ev.proposalId];
      if (!prev) return state;
      return {
        ...state,
        proposals: {
          ...state.proposals,
          [ev.proposalId]: { ...prev, status: ev.status },
        },
      };
    },
    HostWakeRecorded: (state, ev) => ({
      ...state,
      lastWakeAtMs: ev.wokeAtMs,
      lastWakeGapMs: ev.gapMs,
      wakeCount: state.wakeCount + 1,
    }),
  },
}) {}
