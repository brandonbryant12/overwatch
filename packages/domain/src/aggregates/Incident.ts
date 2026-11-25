import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
  OutputBudgetExceeded,
  validateHeadline,
  validateUnderstanding,
} from "../budgets.ts";
import {
  ActionId,
  ConnectorCoverage,
  EvidenceId,
  FeedbackReason,
  FindingKind,
  IncidentId,
  IncidentStatus,
  omitUndefined,
  RunId,
  Severity,
} from "../ids.ts";

export const UnderstandingBulletSchema = Schema.Struct({
  text: Schema.String,
  evidenceIds: Schema.Array(EvidenceId),
});
export type UnderstandingBullet = typeof UnderstandingBulletSchema.Type;

export const SignalRecordSchema = Schema.Struct({
  signalId: Schema.String,
  watchRuleId: Schema.String,
  fingerprint: Schema.String,
  summary: Schema.String,
  severity: Severity,
  evidenceId: EvidenceId,
  observedAtMs: Schema.Number,
});
export type SignalRecord = typeof SignalRecordSchema.Type;

export const FindingRecordSchema = Schema.Struct({
  findingId: Schema.String,
  kind: FindingKind,
  summary: Schema.String,
  confidence: Schema.Number,
  evidenceIds: Schema.Array(EvidenceId),
  runId: Schema.optional(RunId),
  recordedAtMs: Schema.Number,
});
export type FindingRecord = typeof FindingRecordSchema.Type;

export const VerificationBundleSchema = Schema.Struct({
  runId: RunId,
  reproducedLocally: Schema.Boolean,
  commandsRun: Schema.Array(Schema.String),
  exitCodes: Schema.Array(Schema.Number),
  beforeAfterSummary: Schema.String,
  diffStat: Schema.String,
  unknowns: Schema.Array(Schema.String),
  worktreePath: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
});
export type VerificationBundle = typeof VerificationBundleSchema.Type;

export const IncidentChatEntrySchema = Schema.Struct({
  id: Schema.String,
  author: Schema.Literals(["operator", "agent"]),
  text: Schema.String,
  delivery: Schema.Literals(["steer", "queue", "reply"]),
  evidenceIds: Schema.Array(EvidenceId),
  createdAtMs: Schema.Number,
});
export type IncidentChatEntry = typeof IncidentChatEntrySchema.Type;

export const IncidentStateSchema = Schema.Struct({
  exists: Schema.Boolean,
  appId: Schema.String,
  envId: Schema.String,
  headline: Schema.String,
  severity: Severity,
  status: IncidentStatus,
  primaryFingerprint: Schema.String,
  fingerprints: Schema.Array(Schema.String),
  rolloutId: Schema.optional(Schema.String),
  commitSha: Schema.optional(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  signals: Schema.Array(SignalRecordSchema),
  signalCount: Schema.Number,
  understanding: Schema.Array(UnderstandingBulletSchema),
  findings: Schema.Array(FindingRecordSchema),
  linkedRunIds: Schema.Array(RunId),
  verificationBundles: Schema.Array(VerificationBundleSchema),
  actionIds: Schema.Array(ActionId),
  chat: Schema.Array(IncidentChatEntrySchema),
  recoveryCleanWindows: Schema.Number,
  recoveryTargetK: Schema.Number,
  lastCoverage: ConnectorCoverage,
  lastAnomalyAtMs: Schema.Number,
  openedAtMs: Schema.Number,
  resolvedAtMs: Schema.optional(Schema.Number),
  dismissReason: Schema.optional(Schema.String),
  feedbackVote: Schema.optional(Schema.Literals(["up", "down"])),
  feedbackReason: Schema.optional(FeedbackReason),
});
export type IncidentState = typeof IncidentStateSchema.Type;

// Rejections
export class IncidentAlreadyOpen extends Domain.Rejection("IncidentAlreadyOpen", {
  incidentId: IncidentId,
}) {}

export class IncidentNotFound extends Domain.Rejection("IncidentNotFound", {
  incidentId: IncidentId,
}) {}

export class IncidentClosed extends Domain.Rejection("IncidentClosed", {
  incidentId: IncidentId,
  status: IncidentStatus,
}) {}

export class PrematureRecovery extends Domain.Rejection("PrematureRecovery", {
  incidentId: IncidentId,
  cleanWindows: Schema.Number,
  requiredWindows: Schema.Number,
  coverage: ConnectorCoverage,
  reason: Schema.String,
}) {}

export class UncoveredTelemetry extends Domain.Rejection("UncoveredTelemetry", {
  incidentId: IncidentId,
  coverage: ConnectorCoverage,
}) {}

// Events
export class IncidentOpened extends Domain.Event("IncidentOpened", {
  appId: Schema.String,
  envId: Schema.String,
  headline: Schema.String,
  severity: Severity,
  signal: SignalRecordSchema,
  rolloutId: Schema.optional(Schema.String),
  commitSha: Schema.optional(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  recoveryTargetK: Schema.Number,
  openedAtMs: Schema.Number,
}) {}

export class SignalAttached extends Domain.Event("SignalAttached", {
  signal: SignalRecordSchema,
  escalatedSeverity: Schema.optional(Severity),
  reopened: Schema.Boolean,
}) {}

export class UnderstandingUpdated extends Domain.Event("UnderstandingUpdated", {
  bullets: Schema.Array(UnderstandingBulletSchema),
  headline: Schema.optional(Schema.String),
}) {}

export class FindingRecorded extends Domain.Event("FindingRecorded", {
  finding: FindingRecordSchema,
}) {}

export class IncidentRunLinked extends Domain.Event("IncidentRunLinked", {
  runId: RunId,
}) {}

export class IncidentActionLinked extends Domain.Event("IncidentActionLinked", {
  actionId: ActionId,
}) {}

export class VerificationBundleRecorded extends Domain.Event("VerificationBundleRecorded", {
  bundle: VerificationBundleSchema,
}) {}

export class IncidentEnteredMitigating extends Domain.Event("IncidentEnteredMitigating", {
  reason: Schema.String,
}) {}

export class IncidentEnteredWatching extends Domain.Event("IncidentEnteredWatching", {
  reason: Schema.String,
}) {}

export class CleanWindowRecorded extends Domain.Event("CleanWindowRecorded", {
  cleanWindows: Schema.Number,
  requiredWindows: Schema.Number,
  observedAtMs: Schema.Number,
}) {}

export class RecoveryWindowReset extends Domain.Event("RecoveryWindowReset", {
  reason: Schema.String,
  coverage: ConnectorCoverage,
}) {}

export class IncidentResolved extends Domain.Event("IncidentResolved", {
  resolvedAtMs: Schema.Number,
  byOperatorOverride: Schema.Boolean,
  reason: Schema.String,
}) {}

export class IncidentDismissed extends Domain.Event("IncidentDismissed", {
  reason: Schema.String,
  dismissedAtMs: Schema.Number,
}) {}

export class IncidentSplit extends Domain.Event("IncidentSplit", {
  targetIncidentId: IncidentId,
  movedSignalIds: Schema.Array(Schema.String),
  reason: Schema.String,
}) {}

export class IncidentFeedbackRecorded extends Domain.Event("IncidentFeedbackRecorded", {
  vote: Schema.Literals(["up", "down"]),
  reason: FeedbackReason,
}) {}

export class IncidentChatPosted extends Domain.Event("IncidentChatPosted", {
  entry: IncidentChatEntrySchema,
}) {}

// Commands
export class OpenIncident extends Domain.Command("OpenIncident", {
  target: IncidentId,
  input: {
    appId: Schema.String,
    envId: Schema.String,
    headline: Schema.String,
    severity: Severity,
    signal: SignalRecordSchema,
    rolloutId: Schema.optional(Schema.String),
    commitSha: Schema.optional(Schema.String),
    tags: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    recoveryTargetK: Schema.optional(Schema.Number),
  },
  events: [IncidentOpened],
  rejects: [IncidentAlreadyOpen, OutputBudgetExceeded],
}) {}

export class AttachSignal extends Domain.Command("AttachSignal", {
  target: IncidentId,
  input: {
    signal: SignalRecordSchema,
  },
  events: [SignalAttached],
  rejects: [IncidentNotFound, IncidentClosed],
}) {}

export class UpdateUnderstanding extends Domain.Command("UpdateUnderstanding", {
  target: IncidentId,
  input: {
    bullets: Schema.Array(UnderstandingBulletSchema),
    headline: Schema.optional(Schema.String),
  },
  events: [UnderstandingUpdated],
  rejects: [IncidentNotFound, OutputBudgetExceeded],
}) {}

export class RecordFinding extends Domain.Command("RecordFinding", {
  target: IncidentId,
  input: {
    findingId: Schema.String,
    kind: FindingKind,
    summary: Schema.String,
    confidence: Schema.Number,
    evidenceIds: Schema.Array(EvidenceId),
    runId: Schema.optional(RunId),
  },
  events: [FindingRecorded],
  rejects: [IncidentNotFound, OutputBudgetExceeded],
}) {}

export class LinkRunToIncident extends Domain.Command("LinkRunToIncident", {
  target: IncidentId,
  input: { runId: RunId },
  events: [IncidentRunLinked],
  rejects: [IncidentNotFound],
}) {}

export class LinkActionToIncident extends Domain.Command("LinkActionToIncident", {
  target: IncidentId,
  input: { actionId: ActionId },
  events: [IncidentActionLinked],
  rejects: [IncidentNotFound],
}) {}

export class RecordVerificationBundle extends Domain.Command("RecordVerificationBundle", {
  target: IncidentId,
  input: {
    bundle: VerificationBundleSchema,
  },
  events: [VerificationBundleRecorded, IncidentEnteredMitigating],
  rejects: [IncidentNotFound, IncidentClosed],
}) {}

export class EnterWatching extends Domain.Command("EnterWatching", {
  target: IncidentId,
  input: { reason: Schema.String },
  events: [IncidentEnteredWatching],
  rejects: [IncidentNotFound, IncidentClosed],
}) {}

export class RecordCleanWindow extends Domain.Command("RecordCleanWindow", {
  target: IncidentId,
  input: {
    coverage: ConnectorCoverage,
    observedAtMs: Schema.Number,
  },
  events: [CleanWindowRecorded, IncidentResolved],
  rejects: [IncidentNotFound, IncidentClosed, UncoveredTelemetry],
}) {}

export class ResetRecoveryWindow extends Domain.Command("ResetRecoveryWindow", {
  target: IncidentId,
  input: {
    reason: Schema.String,
    coverage: ConnectorCoverage,
  },
  events: [RecoveryWindowReset],
  rejects: [IncidentNotFound],
}) {}

export class ResolveIncident extends Domain.Command("ResolveIncident", {
  target: IncidentId,
  input: {
    reason: Schema.String,
    operatorOverride: Schema.optional(Schema.Boolean),
  },
  events: [IncidentResolved],
  rejects: [IncidentNotFound, IncidentClosed, PrematureRecovery],
}) {}

export class DismissIncident extends Domain.Command("DismissIncident", {
  target: IncidentId,
  input: { reason: Schema.String },
  events: [IncidentDismissed],
  rejects: [IncidentNotFound, IncidentClosed],
}) {}

export class SplitIncident extends Domain.Command("SplitIncident", {
  target: IncidentId,
  input: {
    targetIncidentId: IncidentId,
    movedSignalIds: Schema.Array(Schema.String),
    reason: Schema.String,
  },
  events: [IncidentSplit],
  rejects: [IncidentNotFound, IncidentClosed],
}) {}

export class RecordIncidentFeedback extends Domain.Command("RecordIncidentFeedback", {
  target: IncidentId,
  input: {
    vote: Schema.Literals(["up", "down"]),
    reason: FeedbackReason,
  },
  events: [IncidentFeedbackRecorded],
  rejects: [IncidentNotFound],
}) {}

export class PostIncidentChat extends Domain.Command("PostIncidentChat", {
  target: IncidentId,
  input: {
    id: Schema.String,
    author: Schema.Literals(["operator", "agent"]),
    text: Schema.String,
    delivery: Schema.Literals(["steer", "queue", "reply"]),
    evidenceIds: Schema.optional(Schema.Array(EvidenceId)),
  },
  events: [IncidentChatPosted],
  rejects: [IncidentNotFound, OutputBudgetExceeded],
}) {}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, page: 2 };

const initialIncidentState: IncidentState = {
  exists: false,
  appId: "",
  envId: "",
  headline: "",
  severity: "info",
  status: "investigating" as const,
  primaryFingerprint: "",
  fingerprints: [],
  tags: {},
  signals: [],
  signalCount: 0,
  understanding: [],
  findings: [],
  linkedRunIds: [],
  verificationBundles: [],
  actionIds: [],
  chat: [],
  recoveryCleanWindows: 0,
  recoveryTargetK: 3,
  lastCoverage: "healthy" as const,
  lastAnomalyAtMs: 0,
  openedAtMs: 0,
};

export class Incident extends Domain.Aggregate("Incident", {
  id: IncidentId,
  state: IncidentStateSchema,
  initial: initialIncidentState,
  commands: [
    OpenIncident,
    AttachSignal,
    UpdateUnderstanding,
    RecordFinding,
    LinkRunToIncident,
    LinkActionToIncident,
    RecordVerificationBundle,
    EnterWatching,
    RecordCleanWindow,
    ResetRecoveryWindow,
    ResolveIncident,
    DismissIncident,
    SplitIncident,
    RecordIncidentFeedback,
    PostIncidentChat,
  ],
  decide: {
    OpenIncident: (state, cmd, ctx) => {
      if (state.exists) return new IncidentAlreadyOpen({ incidentId: ctx.id });
      const headlineErr = validateHeadline(cmd.headline);
      if (headlineErr) return headlineErr;
      const nowMs = ctx.now.epochMilliseconds;
      return [
        new IncidentOpened(
          omitUndefined({
            appId: cmd.appId,
            envId: cmd.envId,
            headline: cmd.headline,
            severity: cmd.severity,
            signal: cmd.signal,
            rolloutId: cmd.rolloutId,
            commitSha: cmd.commitSha,
            tags: cmd.tags ?? {},
            recoveryTargetK: Math.max(1, cmd.recoveryTargetK ?? 3),
            openedAtMs: nowMs,
          }),
        ),
      ];
    },
    AttachSignal: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (state.status === "resolved" || state.status === "dismissed" || state.status === "merged") {
        return new IncidentClosed({ incidentId: ctx.id, status: state.status });
      }
      const escalatedSeverity =
        SEVERITY_RANK[cmd.signal.severity] > SEVERITY_RANK[state.severity]
          ? cmd.signal.severity
          : undefined;
      const reopened = state.status === "watching";
      return [
        new SignalAttached(
          omitUndefined({
            signal: cmd.signal,
            escalatedSeverity,
            reopened,
          }),
        ),
      ];
    },
    UpdateUnderstanding: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (cmd.headline !== undefined) {
        const headlineErr = validateHeadline(cmd.headline);
        if (headlineErr) return headlineErr;
      }
      const bulletErr = validateUnderstanding(cmd.bullets);
      if (bulletErr) return bulletErr;
      return [
        new UnderstandingUpdated(
          omitUndefined({
            bullets: cmd.bullets,
            headline: cmd.headline,
          }),
        ),
      ];
    },
    RecordFinding: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (cmd.evidenceIds.length === 0) {
        return new OutputBudgetExceeded({
          field: "evidenceIds",
          limit: 1,
          actual: 0,
          hint: "Every finding must cite at least one EvidenceId.",
        });
      }
      if (cmd.summary.length > 200) {
        return new OutputBudgetExceeded({
          field: "summary",
          limit: 200,
          actual: cmd.summary.length,
          hint: "Finding summary must be <= 200 characters.",
        });
      }
      return [
        new FindingRecorded({
          finding: omitUndefined({
            findingId: cmd.findingId,
            kind: cmd.kind,
            summary: cmd.summary,
            confidence: cmd.confidence,
            evidenceIds: cmd.evidenceIds,
            runId: cmd.runId,
            recordedAtMs: ctx.now.epochMilliseconds,
          }),
        }),
      ];
    },
    LinkRunToIncident: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (state.linkedRunIds.includes(cmd.runId)) return [];
      return [new IncidentRunLinked({ runId: cmd.runId })];
    },
    LinkActionToIncident: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (state.actionIds.includes(cmd.actionId)) return [];
      return [new IncidentActionLinked({ actionId: cmd.actionId })];
    },
    RecordVerificationBundle: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (state.status === "resolved" || state.status === "dismissed") {
        return new IncidentClosed({ incidentId: ctx.id, status: state.status });
      }
      const events: Array<VerificationBundleRecorded | IncidentEnteredMitigating> = [
        new VerificationBundleRecorded({ bundle: cmd.bundle }),
      ];
      if (state.status === "investigating") {
        events.push(
          new IncidentEnteredMitigating({ reason: "Local verification bundle recorded" }),
        );
      }
      return events;
    },
    EnterWatching: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (state.status === "resolved" || state.status === "dismissed") {
        return new IncidentClosed({ incidentId: ctx.id, status: state.status });
      }
      if (state.status === "watching") return [];
      return [new IncidentEnteredWatching({ reason: cmd.reason })];
    },
    RecordCleanWindow: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (state.status === "resolved" || state.status === "dismissed") {
        return new IncidentClosed({ incidentId: ctx.id, status: state.status });
      }
      if (cmd.coverage !== "healthy") {
        return new UncoveredTelemetry({ incidentId: ctx.id, coverage: cmd.coverage });
      }
      if (state.status !== "watching") {
        return [];
      }
      const nextCount = state.recoveryCleanWindows + 1;
      const events: Array<CleanWindowRecorded | IncidentResolved> = [
        new CleanWindowRecorded({
          cleanWindows: nextCount,
          requiredWindows: state.recoveryTargetK,
          observedAtMs: cmd.observedAtMs,
        }),
      ];
      if (nextCount >= state.recoveryTargetK) {
        events.push(
          new IncidentResolved({
            resolvedAtMs: ctx.now.epochMilliseconds,
            byOperatorOverride: false,
            reason: `Verified ${nextCount}/${state.recoveryTargetK} consecutive healthy post-anomaly windows`,
          }),
        );
      }
      return events;
    },
    ResetRecoveryWindow: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      return [new RecoveryWindowReset({ reason: cmd.reason, coverage: cmd.coverage })];
    },
    ResolveIncident: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (state.status === "resolved" || state.status === "dismissed") {
        return new IncidentClosed({ incidentId: ctx.id, status: state.status });
      }
      const operatorOverride = cmd.operatorOverride === true;
      const verified =
        state.status === "watching" &&
        state.recoveryCleanWindows >= state.recoveryTargetK &&
        state.lastCoverage === "healthy";
      if (!verified && !operatorOverride) {
        return new PrematureRecovery({
          incidentId: ctx.id,
          cleanWindows: state.recoveryCleanWindows,
          requiredWindows: state.recoveryTargetK,
          coverage: state.lastCoverage,
          reason:
            "Automated resolution requires K consecutive clean windows on healthy connectors.",
        });
      }
      return [
        new IncidentResolved({
          resolvedAtMs: ctx.now.epochMilliseconds,
          byOperatorOverride: operatorOverride,
          reason: cmd.reason,
        }),
      ];
    },
    DismissIncident: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (state.status === "resolved" || state.status === "dismissed") {
        return new IncidentClosed({ incidentId: ctx.id, status: state.status });
      }
      return [
        new IncidentDismissed({
          reason: cmd.reason,
          dismissedAtMs: ctx.now.epochMilliseconds,
        }),
      ];
    },
    SplitIncident: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (state.status === "resolved" || state.status === "dismissed") {
        return new IncidentClosed({ incidentId: ctx.id, status: state.status });
      }
      return [
        new IncidentSplit({
          targetIncidentId: cmd.targetIncidentId,
          movedSignalIds: cmd.movedSignalIds,
          reason: cmd.reason,
        }),
      ];
    },
    RecordIncidentFeedback: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      return [new IncidentFeedbackRecorded({ vote: cmd.vote, reason: cmd.reason })];
    },
    PostIncidentChat: (state, cmd, ctx) => {
      if (!state.exists) return new IncidentNotFound({ incidentId: ctx.id });
      if (cmd.author === "agent" && cmd.text.length > 400) {
        return new OutputBudgetExceeded({
          field: "chat.text",
          limit: 400,
          actual: cmd.text.length,
          hint: "Agent chat replies must be <= 400 characters.",
        });
      }
      return [
        new IncidentChatPosted({
          entry: {
            id: cmd.id,
            author: cmd.author,
            text: cmd.text,
            delivery: cmd.delivery,
            evidenceIds: cmd.evidenceIds ?? [],
            createdAtMs: ctx.now.epochMilliseconds,
          },
        }),
      ];
    },
  },
  evolve: {
    IncidentOpened: (_state, ev) => ({
      exists: true,
      appId: ev.appId,
      envId: ev.envId,
      headline: ev.headline,
      severity: ev.severity,
      status: "investigating" as const,
      primaryFingerprint: ev.signal.fingerprint,
      fingerprints: [ev.signal.fingerprint],
      rolloutId: ev.rolloutId,
      commitSha: ev.commitSha,
      tags: ev.tags,
      signals: [ev.signal],
      signalCount: 1,
      understanding: [],
      findings: [],
      linkedRunIds: [],
      verificationBundles: [],
      actionIds: [],
      chat: [],
      recoveryCleanWindows: 0,
      recoveryTargetK: ev.recoveryTargetK,
      lastCoverage: "healthy" as const,
      lastAnomalyAtMs: ev.signal.observedAtMs,
      openedAtMs: ev.openedAtMs,
    }),
    SignalAttached: (state, ev) => ({
      ...state,
      severity: ev.escalatedSeverity ?? state.severity,
      status: ev.reopened ? ("investigating" as const) : state.status,
      fingerprints: state.fingerprints.includes(ev.signal.fingerprint)
        ? state.fingerprints
        : [...state.fingerprints, ev.signal.fingerprint],
      signals: [...state.signals, ev.signal],
      signalCount: state.signalCount + 1,
      recoveryCleanWindows: 0,
      lastAnomalyAtMs: Math.max(state.lastAnomalyAtMs, ev.signal.observedAtMs),
    }),
    UnderstandingUpdated: (state, ev) => ({
      ...state,
      headline: ev.headline ?? state.headline,
      understanding: [...ev.bullets],
    }),
    FindingRecorded: (state, ev) => ({
      ...state,
      findings: [...state.findings, ev.finding],
    }),
    IncidentRunLinked: (state, ev) => ({
      ...state,
      linkedRunIds: state.linkedRunIds.includes(ev.runId)
        ? state.linkedRunIds
        : [...state.linkedRunIds, ev.runId],
    }),
    IncidentActionLinked: (state, ev) => ({
      ...state,
      actionIds: state.actionIds.includes(ev.actionId)
        ? state.actionIds
        : [...state.actionIds, ev.actionId],
    }),
    VerificationBundleRecorded: (state, ev) => ({
      ...state,
      verificationBundles: [...state.verificationBundles, ev.bundle],
    }),
    IncidentEnteredMitigating: (state) => ({
      ...state,
      status: "mitigating" as const,
    }),
    IncidentEnteredWatching: (state) => ({
      ...state,
      status: "watching" as const,
      recoveryCleanWindows: 0,
    }),
    CleanWindowRecorded: (state, ev) => ({
      ...state,
      recoveryCleanWindows: ev.cleanWindows,
      lastCoverage: "healthy" as const,
    }),
    RecoveryWindowReset: (state, ev) => ({
      ...state,
      recoveryCleanWindows: 0,
      lastCoverage: ev.coverage,
    }),
    IncidentResolved: (state, ev) => ({
      ...state,
      status: "resolved" as const,
      resolvedAtMs: ev.resolvedAtMs,
    }),
    IncidentDismissed: (state, ev) => ({
      ...state,
      status: "dismissed" as const,
      dismissReason: ev.reason,
      resolvedAtMs: ev.dismissedAtMs,
    }),
    IncidentSplit: (state, ev) => {
      const moved = new Set(ev.movedSignalIds);
      return {
        ...state,
        signals: state.signals.filter((s) => !moved.has(s.signalId)),
      };
    },
    IncidentFeedbackRecorded: (state, ev) => ({
      ...state,
      feedbackVote: ev.vote,
      feedbackReason: ev.reason,
    }),
    IncidentChatPosted: (state, ev) => ({
      ...state,
      chat: [...state.chat, ev.entry],
    }),
  },
}) {}
