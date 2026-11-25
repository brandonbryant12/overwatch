import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
  ActionId,
  ActionKind,
  ActionStatus,
  AskId,
  AutonomyLevel,
  EvidenceId,
  IncidentId,
  omitUndefined,
  RunId,
} from "../ids.ts";

export const ActionStateSchema = Schema.Struct({
  exists: Schema.Boolean,
  kind: ActionKind,
  status: ActionStatus,
  appId: Schema.String,
  envId: Schema.String,
  repo: Schema.String,
  title: Schema.String,
  body: Schema.String,
  branch: Schema.optional(Schema.String),
  baseBranch: Schema.optional(Schema.String),
  worktreePath: Schema.optional(Schema.String),
  evidenceIds: Schema.Array(EvidenceId),
  incidentId: Schema.optional(IncidentId),
  runId: Schema.optional(RunId),
  autonomy: AutonomyLevel,
  requiresApproval: Schema.Boolean,
  approvedAskId: Schema.optional(AskId),
  artifactUrl: Schema.optional(Schema.String),
  artifactNumber: Schema.optional(Schema.Number),
  reconciled: Schema.Boolean,
  failureReason: Schema.optional(Schema.String),
  requestedAtMs: Schema.Number,
  completedAtMs: Schema.optional(Schema.Number),
});
export type ActionState = typeof ActionStateSchema.Type;

export class ActionAlreadyRequested extends Domain.Rejection("ActionAlreadyRequested", {
  actionId: ActionId,
}) {}

export class ActionNotFound extends Domain.Rejection("ActionNotFound", {
  actionId: ActionId,
}) {}

export class ActionDisallowedByPolicy extends Domain.Rejection("ActionDisallowedByPolicy", {
  actionId: ActionId,
  kind: ActionKind,
}) {}

export class ActionNotApproved extends Domain.Rejection("ActionNotApproved", {
  actionId: ActionId,
  status: ActionStatus,
}) {}

export class ActionRequested extends Domain.Event("ActionRequested", {
  kind: ActionKind,
  appId: Schema.String,
  envId: Schema.String,
  repo: Schema.String,
  title: Schema.String,
  body: Schema.String,
  branch: Schema.optional(Schema.String),
  baseBranch: Schema.optional(Schema.String),
  worktreePath: Schema.optional(Schema.String),
  evidenceIds: Schema.Array(EvidenceId),
  incidentId: Schema.optional(IncidentId),
  runId: Schema.optional(RunId),
  autonomy: AutonomyLevel,
  requiresApproval: Schema.Boolean,
  requestedAtMs: Schema.Number,
}) {}

export class ActionApproved extends Domain.Event("ActionApproved", {
  askId: AskId,
  approvedAtMs: Schema.Number,
}) {}

export class ActionRejected extends Domain.Event("ActionRejected", {
  askId: AskId,
  reason: Schema.String,
}) {}

export class ActionExecutionStarted extends Domain.Event("ActionExecutionStarted", {
  startedAtMs: Schema.Number,
}) {}

export class ActionCompleted extends Domain.Event("ActionCompleted", {
  artifactUrl: Schema.String,
  artifactNumber: Schema.optional(Schema.Number),
  reconciled: Schema.Boolean,
  completedAtMs: Schema.Number,
}) {}

export class ActionFailed extends Domain.Event("ActionFailed", {
  reason: Schema.String,
  failedAtMs: Schema.Number,
}) {}

export class RequestAction extends Domain.Command("RequestAction", {
  target: ActionId,
  input: {
    kind: ActionKind,
    appId: Schema.String,
    envId: Schema.String,
    repo: Schema.String,
    title: Schema.String,
    body: Schema.String,
    branch: Schema.optional(Schema.String),
    baseBranch: Schema.optional(Schema.String),
    worktreePath: Schema.optional(Schema.String),
    evidenceIds: Schema.Array(EvidenceId),
    incidentId: Schema.optional(IncidentId),
    runId: Schema.optional(RunId),
    autonomy: AutonomyLevel,
  },
  events: [ActionRequested],
  rejects: [ActionAlreadyRequested, ActionDisallowedByPolicy],
}) {}

export class ApproveAction extends Domain.Command("ApproveAction", {
  target: ActionId,
  input: { askId: AskId },
  events: [ActionApproved],
  rejects: [ActionNotFound],
}) {}

export class RejectAction extends Domain.Command("RejectAction", {
  target: ActionId,
  input: { askId: AskId, reason: Schema.String },
  events: [ActionRejected],
  rejects: [ActionNotFound],
}) {}

export class StartActionExecution extends Domain.Command("StartActionExecution", {
  target: ActionId,
  input: {},
  events: [ActionExecutionStarted],
  rejects: [ActionNotFound, ActionNotApproved],
}) {}

export class CompleteAction extends Domain.Command("CompleteAction", {
  target: ActionId,
  input: {
    artifactUrl: Schema.String,
    artifactNumber: Schema.optional(Schema.Number),
    reconciled: Schema.Boolean,
  },
  events: [ActionCompleted],
  rejects: [ActionNotFound],
}) {}

export class FailAction extends Domain.Command("FailAction", {
  target: ActionId,
  input: { reason: Schema.String },
  events: [ActionFailed],
  rejects: [ActionNotFound],
}) {}

const initialActionState: ActionState = {
  exists: false,
  kind: "create_github_issue",
  status: "requested",
  appId: "",
  envId: "",
  repo: "",
  title: "",
  body: "",
  evidenceIds: [],
  autonomy: "propose",
  requiresApproval: true,
  reconciled: false,
  requestedAtMs: 0,
};

export class Action extends Domain.Aggregate("Action", {
  id: ActionId,
  state: ActionStateSchema,
  initial: initialActionState,
  commands: [
    RequestAction,
    ApproveAction,
    RejectAction,
    StartActionExecution,
    CompleteAction,
    FailAction,
  ],
  decide: {
    RequestAction: (state, cmd, ctx) => {
      if (state.exists) return new ActionAlreadyRequested({ actionId: ctx.id });
      if (cmd.autonomy === "never") {
        return new ActionDisallowedByPolicy({ actionId: ctx.id, kind: cmd.kind });
      }
      return [
        new ActionRequested(
          omitUndefined({
            kind: cmd.kind,
            appId: cmd.appId,
            envId: cmd.envId,
            repo: cmd.repo,
            title: cmd.title,
            body: cmd.body,
            branch: cmd.branch,
            baseBranch: cmd.baseBranch,
            worktreePath: cmd.worktreePath,
            evidenceIds: cmd.evidenceIds,
            incidentId: cmd.incidentId,
            runId: cmd.runId,
            autonomy: cmd.autonomy,
            requiresApproval: cmd.autonomy === "propose",
            requestedAtMs: ctx.now.epochMilliseconds,
          }),
        ),
      ];
    },
    ApproveAction: (state, cmd, ctx) => {
      if (!state.exists) return new ActionNotFound({ actionId: ctx.id });
      if (state.status === "approved" || state.status === "executing" || state.status === "completed") {
        return [];
      }
      return [
        new ActionApproved({
          askId: cmd.askId,
          approvedAtMs: ctx.now.epochMilliseconds,
        }),
      ];
    },
    RejectAction: (state, cmd, ctx) => {
      if (!state.exists) return new ActionNotFound({ actionId: ctx.id });
      if (state.status === "rejected" || state.status === "completed") return [];
      return [new ActionRejected({ askId: cmd.askId, reason: cmd.reason })];
    },
    StartActionExecution: (state, _cmd, ctx) => {
      if (!state.exists) return new ActionNotFound({ actionId: ctx.id });
      if (state.status === "completed") return [];
      if (state.requiresApproval && state.status !== "approved" && state.status !== "executing") {
        return new ActionNotApproved({ actionId: ctx.id, status: state.status });
      }
      return [new ActionExecutionStarted({ startedAtMs: ctx.now.epochMilliseconds })];
    },
    CompleteAction: (state, cmd, ctx) => {
      if (!state.exists) return new ActionNotFound({ actionId: ctx.id });
      if (state.status === "completed") return [];
      return [
        new ActionCompleted(
          omitUndefined({
            artifactUrl: cmd.artifactUrl,
            artifactNumber: cmd.artifactNumber,
            reconciled: cmd.reconciled,
            completedAtMs: ctx.now.epochMilliseconds,
          }),
        ),
      ];
    },
    FailAction: (state, cmd, ctx) => {
      if (!state.exists) return new ActionNotFound({ actionId: ctx.id });
      return [new ActionFailed({ reason: cmd.reason, failedAtMs: ctx.now.epochMilliseconds })];
    },
  },
  evolve: {
    ActionRequested: (_state, ev) => ({
      exists: true,
      kind: ev.kind,
      status: ev.requiresApproval ? ("awaiting_approval" as const) : ("approved" as const),
      appId: ev.appId,
      envId: ev.envId,
      repo: ev.repo,
      title: ev.title,
      body: ev.body,
      branch: ev.branch,
      baseBranch: ev.baseBranch,
      worktreePath: ev.worktreePath,
      evidenceIds: [...ev.evidenceIds],
      incidentId: ev.incidentId,
      runId: ev.runId,
      autonomy: ev.autonomy,
      requiresApproval: ev.requiresApproval,
      reconciled: false,
      requestedAtMs: ev.requestedAtMs,
    }),
    ActionApproved: (state, ev) => ({
      ...state,
      status: "approved" as const,
      approvedAskId: ev.askId,
    }),
    ActionRejected: (state, ev) => ({
      ...state,
      status: "rejected" as const,
      failureReason: ev.reason,
    }),
    ActionExecutionStarted: (state) => ({
      ...state,
      status: "executing" as const,
    }),
    ActionCompleted: (state, ev) => ({
      ...state,
      status: "completed" as const,
      artifactUrl: ev.artifactUrl,
      artifactNumber: ev.artifactNumber,
      reconciled: ev.reconciled,
      completedAtMs: ev.completedAtMs,
    }),
    ActionFailed: (state, ev) => ({
      ...state,
      status: "failed" as const,
      failureReason: ev.reason,
      completedAtMs: ev.failedAtMs,
    }),
  },
}) {}
