import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
  AgentRole,
  AskId,
  IncidentId,
  omitUndefined,
  RunId,
  RunStatus,
  RunTrigger,
} from "../ids.ts";

export const RunBudgetStateSchema = Schema.Struct({
  maxAwakeMs: Schema.Number,
  maxConnectorCalls: Schema.Number,
  maxTotalToolCalls: Schema.Number,
  maxUsd: Schema.Number,
});

export const RunStateSchema = Schema.Struct({
  exists: Schema.Boolean,
  role: AgentRole,
  trigger: RunTrigger,
  appId: Schema.String,
  envId: Schema.String,
  incidentId: Schema.optional(IncidentId),
  model: Schema.String,
  status: RunStatus,
  sessionId: Schema.optional(Schema.String),
  worktreePath: Schema.optional(Schema.String),
  pendingAskId: Schema.optional(AskId),
  budget: RunBudgetStateSchema,
  awakeElapsedMs: Schema.Number,
  connectorCalls: Schema.Number,
  totalToolCalls: Schema.Number,
  spentUsd: Schema.Number,
  budgetWarningIssued: Schema.Boolean,
  summary: Schema.optional(Schema.String),
  startedAtMs: Schema.Number,
  completedAtMs: Schema.optional(Schema.Number),
  judgeScore: Schema.optional(Schema.Number),
});
export type RunState = typeof RunStateSchema.Type;

export class RunAlreadyStarted extends Domain.Rejection("RunAlreadyStarted", {
  runId: RunId,
}) {}

export class RunNotFound extends Domain.Rejection("RunNotFound", {
  runId: RunId,
}) {}

export class RunBudgetExhaustedError extends Domain.Rejection("RunBudgetExhaustedError", {
  runId: RunId,
  dimension: Schema.Literals(["awake_ms", "connector_calls", "total_tool_calls", "usd"]),
  used: Schema.Number,
  limit: Schema.Number,
}) {}

export class InvalidSessionId extends Domain.Rejection("InvalidSessionId", {
  sessionId: Schema.String,
}) {}

export class RunStarted extends Domain.Event("RunStarted", {
  role: AgentRole,
  trigger: RunTrigger,
  appId: Schema.String,
  envId: Schema.String,
  incidentId: Schema.optional(IncidentId),
  model: Schema.String,
  budget: RunBudgetStateSchema,
  startedAtMs: Schema.Number,
}) {}

export class RunSessionAssigned extends Domain.Event("RunSessionAssigned", {
  sessionId: Schema.String,
  worktreePath: Schema.optional(Schema.String),
}) {}

export class RunUsageRecorded extends Domain.Event("RunUsageRecorded", {
  connectorCallsDelta: Schema.Number,
  toolCallsDelta: Schema.Number,
  usdDelta: Schema.Number,
  awakeDeltaMs: Schema.Number,
  warningTriggered: Schema.Boolean,
}) {}

export class RunSuspendedForAsk extends Domain.Event("RunSuspendedForAsk", {
  askId: AskId,
}) {}

export class RunResumed extends Domain.Event("RunResumed", {
  reason: Schema.String,
}) {}

export class RunCompleted extends Domain.Event("RunCompleted", {
  summary: Schema.String,
  completedAtMs: Schema.Number,
}) {}

export class RunBudgetExhausted extends Domain.Event("RunBudgetExhausted", {
  dimension: Schema.Literals(["awake_ms", "connector_calls", "total_tool_calls", "usd"]),
  used: Schema.Number,
  limit: Schema.Number,
  completedAtMs: Schema.Number,
}) {}

export class RunFailed extends Domain.Event("RunFailed", {
  reason: Schema.String,
  completedAtMs: Schema.Number,
}) {}

export class RunJudgeScored extends Domain.Event("RunJudgeScored", {
  score: Schema.Number,
}) {}

export class StartRun extends Domain.Command("StartRun", {
  target: RunId,
  input: {
    role: AgentRole,
    trigger: RunTrigger,
    appId: Schema.String,
    envId: Schema.String,
    incidentId: Schema.optional(IncidentId),
    model: Schema.String,
    budget: RunBudgetStateSchema,
  },
  events: [RunStarted],
  rejects: [RunAlreadyStarted],
}) {}

export class AssignRunSession extends Domain.Command("AssignRunSession", {
  target: RunId,
  input: {
    sessionId: Schema.String,
    worktreePath: Schema.optional(Schema.String),
  },
  events: [RunSessionAssigned],
  rejects: [RunNotFound, InvalidSessionId],
}) {}

export class RecordRunUsage extends Domain.Command("RecordRunUsage", {
  target: RunId,
  input: {
    connectorCallsDelta: Schema.optional(Schema.Number),
    toolCallsDelta: Schema.optional(Schema.Number),
    usdDelta: Schema.optional(Schema.Number),
    awakeDeltaMs: Schema.optional(Schema.Number),
  },
  events: [RunUsageRecorded, RunBudgetExhausted],
  rejects: [RunNotFound, RunBudgetExhaustedError],
  reply: {
    budgetWarning: Schema.Boolean,
    exhausted: Schema.Boolean,
  },
}) {}

export class SuspendRunForAsk extends Domain.Command("SuspendRunForAsk", {
  target: RunId,
  input: { askId: AskId },
  events: [RunSuspendedForAsk],
  rejects: [RunNotFound],
}) {}

export class ResumeRun extends Domain.Command("ResumeRun", {
  target: RunId,
  input: { reason: Schema.String },
  events: [RunResumed],
  rejects: [RunNotFound],
}) {}

export class CompleteRun extends Domain.Command("CompleteRun", {
  target: RunId,
  input: { summary: Schema.String },
  events: [RunCompleted],
  rejects: [RunNotFound],
}) {}

export class FailRun extends Domain.Command("FailRun", {
  target: RunId,
  input: { reason: Schema.String },
  events: [RunFailed],
  rejects: [RunNotFound],
}) {}

export class ScoreRun extends Domain.Command("ScoreRun", {
  target: RunId,
  input: { score: Schema.Number },
  events: [RunJudgeScored],
  rejects: [RunNotFound],
}) {}

const initialRunState: RunState = {
  exists: false,
  role: "triage",
  trigger: "signal",
  appId: "",
  envId: "",
  model: "",
  status: "queued",
  budget: {
    maxAwakeMs: 120_000,
    maxConnectorCalls: 12,
    maxTotalToolCalls: 24,
    maxUsd: 0.75,
  },
  awakeElapsedMs: 0,
  connectorCalls: 0,
  totalToolCalls: 0,
  spentUsd: 0,
  budgetWarningIssued: false,
  startedAtMs: 0,
};

export class Run extends Domain.Aggregate("Run", {
  id: RunId,
  state: RunStateSchema,
  initial: initialRunState,
  commands: [
    StartRun,
    AssignRunSession,
    RecordRunUsage,
    SuspendRunForAsk,
    ResumeRun,
    CompleteRun,
    FailRun,
    ScoreRun,
  ],
  decide: {
    StartRun: (state, cmd, ctx) => {
      if (state.exists) return new RunAlreadyStarted({ runId: ctx.id });
      return [
        new RunStarted(
          omitUndefined({
            role: cmd.role,
            trigger: cmd.trigger,
            appId: cmd.appId,
            envId: cmd.envId,
            incidentId: cmd.incidentId,
            model: cmd.model,
            budget: cmd.budget,
            startedAtMs: ctx.now.epochMilliseconds,
          }),
        ),
      ];
    },
    AssignRunSession: (state, cmd, ctx) => {
      if (!state.exists) return new RunNotFound({ runId: ctx.id });
      if (!cmd.sessionId.startsWith("ses")) {
        return new InvalidSessionId({ sessionId: cmd.sessionId });
      }
      if (state.sessionId === cmd.sessionId) return [];
      return [
        new RunSessionAssigned(
          omitUndefined({
            sessionId: cmd.sessionId,
            worktreePath: cmd.worktreePath,
          }),
        ),
      ];
    },
    RecordRunUsage: (state, cmd, ctx) => {
      if (!state.exists) return new RunNotFound({ runId: ctx.id });
      const connDelta = cmd.connectorCallsDelta ?? 0;
      const toolDelta = cmd.toolCallsDelta ?? 0;
      const usdDelta = cmd.usdDelta ?? 0;
      const awakeDelta = cmd.awakeDeltaMs ?? 0;

      const nextConn = state.connectorCalls + connDelta;
      const nextTool = state.totalToolCalls + toolDelta;
      const nextUsd = Number((state.spentUsd + usdDelta).toFixed(6));
      const nextAwake = state.awakeElapsedMs + awakeDelta;

      const warn =
        nextConn >= state.budget.maxConnectorCalls * 0.8 ||
        nextTool >= state.budget.maxTotalToolCalls * 0.8 ||
        nextUsd >= state.budget.maxUsd * 0.8 ||
        nextAwake >= state.budget.maxAwakeMs * 0.8;

      const events: Array<RunUsageRecorded | RunBudgetExhausted> = [
        new RunUsageRecorded({
          connectorCallsDelta: connDelta,
          toolCallsDelta: toolDelta,
          usdDelta,
          awakeDeltaMs: awakeDelta,
          warningTriggered: warn && !state.budgetWarningIssued,
        }),
      ];

      if (nextAwake > state.budget.maxAwakeMs) {
        events.push(
          new RunBudgetExhausted({
            dimension: "awake_ms",
            used: nextAwake,
            limit: state.budget.maxAwakeMs,
            completedAtMs: ctx.now.epochMilliseconds,
          }),
        );
      } else if (nextConn > state.budget.maxConnectorCalls) {
        events.push(
          new RunBudgetExhausted({
            dimension: "connector_calls",
            used: nextConn,
            limit: state.budget.maxConnectorCalls,
            completedAtMs: ctx.now.epochMilliseconds,
          }),
        );
      } else if (nextTool > state.budget.maxTotalToolCalls) {
        events.push(
          new RunBudgetExhausted({
            dimension: "total_tool_calls",
            used: nextTool,
            limit: state.budget.maxTotalToolCalls,
            completedAtMs: ctx.now.epochMilliseconds,
          }),
        );
      } else if (nextUsd > state.budget.maxUsd) {
        events.push(
          new RunBudgetExhausted({
            dimension: "usd",
            used: nextUsd,
            limit: state.budget.maxUsd,
            completedAtMs: ctx.now.epochMilliseconds,
          }),
        );
      }

      return events;
    },
    SuspendRunForAsk: (state, cmd, ctx) => {
      if (!state.exists) return new RunNotFound({ runId: ctx.id });
      return [new RunSuspendedForAsk({ askId: cmd.askId })];
    },
    ResumeRun: (state, cmd, ctx) => {
      if (!state.exists) return new RunNotFound({ runId: ctx.id });
      return [new RunResumed({ reason: cmd.reason })];
    },
    CompleteRun: (state, cmd, ctx) => {
      if (!state.exists) return new RunNotFound({ runId: ctx.id });
      return [
        new RunCompleted({
          summary: cmd.summary,
          completedAtMs: ctx.now.epochMilliseconds,
        }),
      ];
    },
    FailRun: (state, cmd, ctx) => {
      if (!state.exists) return new RunNotFound({ runId: ctx.id });
      return [
        new RunFailed({
          reason: cmd.reason,
          completedAtMs: ctx.now.epochMilliseconds,
        }),
      ];
    },
    ScoreRun: (state, cmd, ctx) => {
      if (!state.exists) return new RunNotFound({ runId: ctx.id });
      return [new RunJudgeScored({ score: cmd.score })];
    },
  },
  reply: {
    RecordRunUsage: (state) => ({
      budgetWarning: state.budgetWarningIssued,
      exhausted: state.status === "budget_exhausted",
    }),
  },
  evolve: {
    RunStarted: (_state, ev) =>
      omitUndefined({
        exists: true,
        role: ev.role,
        trigger: ev.trigger,
        appId: ev.appId,
        envId: ev.envId,
        incidentId: ev.incidentId,
        model: ev.model,
        status: "running" as const,
        budget: ev.budget,
        awakeElapsedMs: 0,
        connectorCalls: 0,
        totalToolCalls: 0,
        spentUsd: 0,
        budgetWarningIssued: false,
        startedAtMs: ev.startedAtMs,
      }),
    RunSessionAssigned: (state, ev) => ({
      ...state,
      sessionId: ev.sessionId,
      worktreePath: ev.worktreePath ?? state.worktreePath,
    }),
    RunUsageRecorded: (state, ev) => ({
      ...state,
      connectorCalls: state.connectorCalls + ev.connectorCallsDelta,
      totalToolCalls: state.totalToolCalls + ev.toolCallsDelta,
      spentUsd: Number((state.spentUsd + ev.usdDelta).toFixed(6)),
      awakeElapsedMs: state.awakeElapsedMs + ev.awakeDeltaMs,
      budgetWarningIssued: state.budgetWarningIssued || ev.warningTriggered,
    }),
    RunSuspendedForAsk: (state, ev) => ({
      ...state,
      status: "awaiting_ask" as const,
      pendingAskId: ev.askId,
    }),
    RunResumed: (state) => ({
      ...state,
      status: "running" as const,
      pendingAskId: undefined,
    }),
    RunCompleted: (state, ev) => ({
      ...state,
      status: "completed" as const,
      summary: ev.summary,
      completedAtMs: ev.completedAtMs,
    }),
    RunBudgetExhausted: (state, ev) => ({
      ...state,
      status: "budget_exhausted" as const,
      completedAtMs: ev.completedAtMs,
    }),
    RunFailed: (state, ev) => ({
      ...state,
      status: "failed" as const,
      summary: ev.reason,
      completedAtMs: ev.completedAtMs,
    }),
    RunJudgeScored: (state, ev) => ({
      ...state,
      judgeScore: ev.score,
    }),
  },
}) {}
