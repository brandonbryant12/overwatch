import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { OutputBudgetExceeded, validateAskBudget } from "../budgets.ts";
import {
  ActionId,
  AskId,
  AskKind,
  AskStatus,
  IncidentId,
  omitUndefined,
  RunId,
} from "../ids.ts";

export const AskOptionSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
});
export type AskOption = typeof AskOptionSchema.Type;

export const AskStateSchema = Schema.Struct({
  exists: Schema.Boolean,
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
  externalRequestId: Schema.optional(Schema.String),
  selectedOptionId: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  resolvedVia: Schema.optional(Schema.Literals(["dashboard", "opencode_tui", "chat"])),
  openedAtMs: Schema.Number,
  resolvedAtMs: Schema.optional(Schema.Number),
});
export type AskState = typeof AskStateSchema.Type;

export class AskAlreadyOpen extends Domain.Rejection("AskAlreadyOpen", {
  askId: AskId,
}) {}

export class AskNotFound extends Domain.Rejection("AskNotFound", {
  askId: AskId,
}) {}

export class AskAlreadyResolved extends Domain.Rejection("AskAlreadyResolved", {
  askId: AskId,
  status: AskStatus,
  selectedOptionId: Schema.optional(Schema.String),
  resolvedVia: Schema.optional(Schema.Literals(["dashboard", "opencode_tui", "chat"])),
}) {}

export class InvalidAskOption extends Domain.Rejection("InvalidAskOption", {
  askId: AskId,
  optionId: Schema.String,
}) {}

export class AskOpened extends Domain.Event("AskOpened", {
  kind: AskKind,
  question: Schema.String,
  whyItMatters: Schema.String,
  options: Schema.Array(AskOptionSchema),
  recommendedOptionId: Schema.String,
  incidentId: Schema.optional(IncidentId),
  runId: Schema.optional(RunId),
  actionId: Schema.optional(ActionId),
  sessionId: Schema.optional(Schema.String),
  externalRequestId: Schema.optional(Schema.String),
  openedAtMs: Schema.Number,
}) {}

export class AskAnswered extends Domain.Event("AskAnswered", {
  selectedOptionId: Schema.String,
  note: Schema.optional(Schema.String),
  resolvedVia: Schema.Literals(["dashboard", "opencode_tui"]),
  resolvedAtMs: Schema.Number,
}) {}

export class AskSupersededByChat extends Domain.Event("AskSupersededByChat", {
  sessionId: Schema.String,
  resolvedAtMs: Schema.Number,
}) {}

export class OpenAsk extends Domain.Command("OpenAsk", {
  target: AskId,
  input: {
    kind: AskKind,
    question: Schema.String,
    whyItMatters: Schema.String,
    options: Schema.Array(AskOptionSchema),
    recommendedOptionId: Schema.String,
    incidentId: Schema.optional(IncidentId),
    runId: Schema.optional(RunId),
    actionId: Schema.optional(ActionId),
    sessionId: Schema.optional(Schema.String),
    externalRequestId: Schema.optional(Schema.String),
  },
  events: [AskOpened],
  rejects: [AskAlreadyOpen, OutputBudgetExceeded],
}) {}

export class AnswerAsk extends Domain.Command("AnswerAsk", {
  target: AskId,
  input: {
    selectedOptionId: Schema.String,
    note: Schema.optional(Schema.String),
  },
  events: [AskAnswered],
  rejects: [AskNotFound, AskAlreadyResolved, InvalidAskOption],
  reply: {
    selectedOptionId: Schema.String,
    resolvedVia: Schema.Literals(["dashboard", "opencode_tui"]),
  },
}) {}

export class SyncExternalAskResolution extends Domain.Command("SyncExternalAskResolution", {
  target: AskId,
  input: {
    selectedOptionId: Schema.String,
    note: Schema.optional(Schema.String),
  },
  events: [AskAnswered],
  rejects: [AskNotFound],
}) {}

export class SupersedeAskByChat extends Domain.Command("SupersedeAskByChat", {
  target: AskId,
  input: {
    sessionId: Schema.String,
  },
  events: [AskSupersededByChat],
  rejects: [AskNotFound],
}) {}

const initialAskState: AskState = {
  exists: false,
  kind: "domain_decision",
  status: "pending" as const,
  question: "",
  whyItMatters: "",
  options: [],
  recommendedOptionId: "",
  openedAtMs: 0,
};

export class Ask extends Domain.Aggregate("Ask", {
  id: AskId,
  state: AskStateSchema,
  initial: initialAskState,
  commands: [OpenAsk, AnswerAsk, SyncExternalAskResolution, SupersedeAskByChat],
  decide: {
    OpenAsk: (state, cmd, ctx) => {
      if (state.exists) return new AskAlreadyOpen({ askId: ctx.id });
      const err = validateAskBudget({
        question: cmd.question,
        whyItMatters: cmd.whyItMatters,
        options: cmd.options,
      });
      if (err) return err;
      return [
        new AskOpened(
          omitUndefined({
            kind: cmd.kind,
            question: cmd.question,
            whyItMatters: cmd.whyItMatters,
            options: cmd.options,
            recommendedOptionId: cmd.recommendedOptionId,
            incidentId: cmd.incidentId,
            runId: cmd.runId,
            actionId: cmd.actionId,
            sessionId: cmd.sessionId,
            externalRequestId: cmd.externalRequestId,
            openedAtMs: ctx.now.epochMilliseconds,
          }),
        ),
      ];
    },
    AnswerAsk: (state, cmd, ctx) => {
      if (!state.exists) return new AskNotFound({ askId: ctx.id });
      if (state.status !== "pending") {
        return new AskAlreadyResolved(
          omitUndefined({
            askId: ctx.id,
            status: state.status,
            selectedOptionId: state.selectedOptionId,
            resolvedVia: state.resolvedVia,
          }),
        );
      }
      const valid = state.options.some((o) => o.id === cmd.selectedOptionId);
      if (!valid) {
        return new InvalidAskOption({ askId: ctx.id, optionId: cmd.selectedOptionId });
      }
      return [
        new AskAnswered(
          omitUndefined({
            selectedOptionId: cmd.selectedOptionId,
            note: cmd.note,
            resolvedVia: "dashboard" as const,
            resolvedAtMs: ctx.now.epochMilliseconds,
          }),
        ),
      ];
    },
    SyncExternalAskResolution: (state, cmd, ctx) => {
      if (!state.exists) return new AskNotFound({ askId: ctx.id });
      // External sync is idempotent: if already answered locally, accept as no-op so convergence is clean.
      if (state.status !== "pending") return [];
      return [
        new AskAnswered(
          omitUndefined({
            selectedOptionId: cmd.selectedOptionId,
            note: cmd.note,
            resolvedVia: "opencode_tui" as const,
            resolvedAtMs: ctx.now.epochMilliseconds,
          }),
        ),
      ];
    },
    SupersedeAskByChat: (state, cmd, ctx) => {
      if (!state.exists) return new AskNotFound({ askId: ctx.id });
      if (state.status !== "pending") return [];
      return [
        new AskSupersededByChat({
          sessionId: cmd.sessionId,
          resolvedAtMs: ctx.now.epochMilliseconds,
        }),
      ];
    },
  },
  reply: {
    AnswerAsk: (state) => ({
      selectedOptionId: state.selectedOptionId ?? "",
      resolvedVia: state.resolvedVia === "opencode_tui" ? "opencode_tui" : "dashboard",
    }),
  },
  evolve: {
    AskOpened: (_state, ev) => ({
      exists: true,
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
      externalRequestId: ev.externalRequestId,
      openedAtMs: ev.openedAtMs,
    }),
    AskAnswered: (state, ev) => ({
      ...state,
      status: "answered" as const,
      selectedOptionId: ev.selectedOptionId,
      note: ev.note,
      resolvedVia: ev.resolvedVia,
      resolvedAtMs: ev.resolvedAtMs,
    }),
    AskSupersededByChat: (state, ev) => ({
      ...state,
      status: "superseded_by_chat" as const,
      resolvedVia: "chat" as const,
      resolvedAtMs: ev.resolvedAtMs,
    }),
  },
}) {}
