import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { OutputBudgetExceeded, validateStakeholderUpdate } from "../budgets.ts";
import { BriefId, BriefKind, BriefStatus, IncidentId } from "../ids.ts";

export const BriefStateSchema = Schema.Struct({
  exists: Schema.Boolean,
  kind: BriefKind,
  status: BriefStatus,
  incidentId: Schema.optional(IncidentId),
  subject: Schema.String,
  originalBody: Schema.String,
  body: Schema.String,
  recipients: Schema.Array(Schema.String),
  editDistanceChars: Schema.Number,
  createdAtMs: Schema.Number,
  sentAtMs: Schema.optional(Schema.Number),
  messageId: Schema.optional(Schema.String),
});
export type BriefState = typeof BriefStateSchema.Type;

export class BriefNotFound extends Domain.Rejection("BriefNotFound", {
  briefId: BriefId,
}) {}

export class BriefDraftSaved extends Domain.Event("BriefDraftSaved", {
  kind: BriefKind,
  incidentId: Schema.optional(IncidentId),
  subject: Schema.String,
  body: Schema.String,
  recipients: Schema.Array(Schema.String),
  createdAtMs: Schema.Number,
}) {}

export class BriefDraftEdited extends Domain.Event("BriefDraftEdited", {
  body: Schema.String,
  editDistanceChars: Schema.Number,
}) {}

export class BriefApproved extends Domain.Event("BriefApproved", {
  approvedAtMs: Schema.Number,
}) {}

export class BriefSent extends Domain.Event("BriefSent", {
  messageId: Schema.String,
  sentAtMs: Schema.Number,
}) {}

export class SaveBriefDraft extends Domain.Command("SaveBriefDraft", {
  target: BriefId,
  input: {
    kind: BriefKind,
    incidentId: Schema.optional(IncidentId),
    subject: Schema.String,
    body: Schema.String,
    recipients: Schema.Array(Schema.String),
  },
  events: [BriefDraftSaved],
  rejects: [OutputBudgetExceeded],
}) {}

export class EditBriefDraft extends Domain.Command("EditBriefDraft", {
  target: BriefId,
  input: { body: Schema.String },
  events: [BriefDraftEdited],
  rejects: [BriefNotFound, OutputBudgetExceeded],
}) {}

export class ApproveBrief extends Domain.Command("ApproveBrief", {
  target: BriefId,
  input: {},
  events: [BriefApproved],
  rejects: [BriefNotFound],
}) {}

export class MarkBriefSent extends Domain.Command("MarkBriefSent", {
  target: BriefId,
  input: { messageId: Schema.String },
  events: [BriefSent],
  rejects: [BriefNotFound],
}) {}

function charDelta(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  let diff = Math.abs(a.length - b.length);
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return Math.min(max, diff);
}

const initialBriefState: BriefState = {
  exists: false,
  kind: "stakeholder_update",
  status: "draft" as const,
  subject: "",
  originalBody: "",
  body: "",
  recipients: [],
  editDistanceChars: 0,
  createdAtMs: 0,
};

export class Brief extends Domain.Aggregate("Brief", {
  id: BriefId,
  state: BriefStateSchema,
  initial: initialBriefState,
  commands: [SaveBriefDraft, EditBriefDraft, ApproveBrief, MarkBriefSent],
  decide: {
    SaveBriefDraft: (_state, cmd, ctx) => {
      if (cmd.kind === "stakeholder_update") {
        const err = validateStakeholderUpdate(cmd.body);
        if (err) return err;
      }
      return [
        new BriefDraftSaved({
          kind: cmd.kind,
          incidentId: cmd.incidentId,
          subject: cmd.subject,
          body: cmd.body,
          recipients: cmd.recipients,
          createdAtMs: ctx.now.epochMilliseconds,
        }),
      ];
    },
    EditBriefDraft: (state, cmd, ctx) => {
      if (!state.exists) return new BriefNotFound({ briefId: ctx.id });
      if (state.kind === "stakeholder_update") {
        const err = validateStakeholderUpdate(cmd.body);
        if (err) return err;
      }
      return [
        new BriefDraftEdited({
          body: cmd.body,
          editDistanceChars: charDelta(state.originalBody, cmd.body),
        }),
      ];
    },
    ApproveBrief: (state, _cmd, ctx) => {
      if (!state.exists) return new BriefNotFound({ briefId: ctx.id });
      if (state.status !== "draft") return [];
      return [new BriefApproved({ approvedAtMs: ctx.now.epochMilliseconds })];
    },
    MarkBriefSent: (state, cmd, ctx) => {
      if (!state.exists) return new BriefNotFound({ briefId: ctx.id });
      return [
        new BriefSent({
          messageId: cmd.messageId,
          sentAtMs: ctx.now.epochMilliseconds,
        }),
      ];
    },
  },
  evolve: {
    BriefDraftSaved: (_state, ev) => ({
      exists: true,
      kind: ev.kind,
      status: "draft" as const,
      incidentId: ev.incidentId,
      subject: ev.subject,
      originalBody: ev.body,
      body: ev.body,
      recipients: [...ev.recipients],
      editDistanceChars: 0,
      createdAtMs: ev.createdAtMs,
    }),
    BriefDraftEdited: (state, ev) => ({
      ...state,
      body: ev.body,
      editDistanceChars: ev.editDistanceChars,
    }),
    BriefApproved: (state) => ({
      ...state,
      status: "approved" as const,
    }),
    BriefSent: (state, ev) => ({
      ...state,
      status: "sent" as const,
      messageId: ev.messageId,
      sentAtMs: ev.sentAtMs,
    }),
  },
}) {}
