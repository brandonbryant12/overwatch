/**
 * Run: one unit of agent work, and its outbox. The session and message ids are chosen and recorded here before
 * anything is sent to OpenCode, so a retry after a crash on either side finds the same session and the same prompt.
 * A run is finished only when a finding tied to it has been filed and its citations checked.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Finding } from "./finding.ts";
import { IncidentId, Mode, Origin, RunId, ThreadId } from "./ids.ts";
import { Handoff } from "./thread.ts";
import { redactText, redactValue } from "./redact.ts";
import { fieldsOf, nowMs } from "./time.ts";

export class RunUnknown extends Domain.Rejection("RunUnknown", {}, { description: "There is no run with this id." }) {}
export class RunNotSent extends Domain.Rejection("RunNotSent", {}, { description: "The run's prompt has not been sent yet." }) {}
export class RunClosed extends Domain.Rejection("RunClosed", {}, { description: "The run has already completed or failed." }) {}
export class WrongSession extends Domain.Rejection("WrongSession", {}, { description: "Only the run's own session can complete it." }) {}

const Requested = {
  threadId: ThreadId,
  subject: IncidentId,
  promptId: Schema.String,
  mode: Mode,
  sessionId: Schema.String,
  messageId: Schema.String,
  newSession: Schema.Boolean,
  delivery: Schema.optionalKey(Schema.Literal("queue")),
  /** What was asked. The service adds the context pack, built by code, when it sends the prompt. */
  text: Schema.String,
  origin: Origin,
  /** The thread's handoff as it stood when the prompt was asked. */
  handoff: Schema.NullOr(Handoff),
};

export class RunRequested extends Domain.Event("RunRequested", { ...Requested, at: Schema.Number }) {}
export class RunSent extends Domain.Event("RunSent", { threadId: ThreadId, sessionId: Schema.String, messageId: Schema.String, at: Schema.Number }) {}
export class RunNudged extends Domain.Event("RunNudged", { threadId: ThreadId, sessionId: Schema.String, messageId: Schema.String, at: Schema.Number }) {}
export class RunCompleted extends Domain.Event("RunCompleted", {
  threadId: ThreadId,
  subject: IncidentId,
  sessionId: Schema.String,
  finding: Finding,
  at: Schema.Number,
}) {}
export class RunFailed extends Domain.Event("RunFailed", {
  threadId: ThreadId,
  sessionId: Schema.String,
  reason: Schema.String,
  at: Schema.Number,
  /** Agent work is retried once, in a fresh session: the prompt id of that retry. Absent when this was the retry. */
  retryAs: Schema.optionalKey(Schema.String),
}) {}

/** The suffix of a retry's prompt id. A run whose prompt id ends with it is not retried again: it is parked. */
export const RETRY = ":retry";

export class RequestRun extends Domain.Command("RequestRun", { target: RunId, input: Requested, events: [RunRequested] }) {}
export class MarkRunSent extends Domain.Command("MarkRunSent", { target: RunId, input: {}, events: [RunSent], rejects: [RunUnknown, RunClosed] }) {}
/** Record a follow-up prompt's id before it is sent: the session went quiet without filing a finding. */
export class NudgeRun extends Domain.Command("NudgeRun", { target: RunId, input: { messageId: Schema.String }, events: [RunNudged], rejects: [RunUnknown, RunNotSent, RunClosed] }) {}
export class CompleteRun extends Domain.Command("CompleteRun", {
  target: RunId,
  input: { sessionId: Schema.String, finding: Finding },
  events: [RunCompleted],
  rejects: [RunUnknown, RunNotSent, RunClosed, WrongSession],
}) {}
export class FailRun extends Domain.Command("FailRun", { target: RunId, input: { reason: Schema.String }, events: [RunFailed], rejects: [RunUnknown, RunClosed] }) {}

export const RunStatus = Schema.Literals(["requested", "sent", "completed", "failed"]);
export type RunStatus = typeof RunStatus.Type;

export const RunState = Schema.Union([
  Schema.TaggedStruct("Unrequested", {}),
  Schema.TaggedStruct("Run", {
    threadId: ThreadId,
    subject: IncidentId,
    sessionId: Schema.String,
    messageId: Schema.String,
    status: RunStatus,
    nudges: Schema.Array(Schema.String),
    promptId: Schema.optionalKey(Schema.String),
  }),
]);

export class Run extends Domain.Aggregate("Run", {
  id: RunId,
  state: RunState,
  initial: { _tag: "Unrequested" as const },
  commands: [RequestRun, MarkRunSent, NudgeRun, CompleteRun, FailRun],
  decide: {
    RequestRun: (s, cmd, ctx) => (s._tag === "Run" ? [] : [new RunRequested({ ...fieldsOf(cmd), text: redactText(cmd.text, { maxBytes: 8_000 }), at: nowMs(ctx) })]),
    // requested → sent → completed | failed. Repeating the current step is harmless; going back, or acting on a
    // closed run, is refused.
    MarkRunSent: (s, _cmd, ctx) => {
      if (s._tag !== "Run") return new RunUnknown();
      if (s.status === "completed" || s.status === "failed") return new RunClosed();
      return s.status === "requested" ? [new RunSent({ threadId: s.threadId, sessionId: s.sessionId, messageId: s.messageId, at: nowMs(ctx) })] : [];
    },
    NudgeRun: (s, cmd, ctx) => {
      if (s._tag !== "Run") return new RunUnknown();
      if (s.status === "completed" || s.status === "failed") return new RunClosed();
      if (s.status === "requested") return new RunNotSent();
      if (s.nudges.includes(cmd.messageId)) return [];
      return [new RunNudged({ threadId: s.threadId, sessionId: s.sessionId, messageId: cmd.messageId, at: nowMs(ctx) })];
    },
    CompleteRun: (s, cmd, ctx) => {
      if (s._tag !== "Run") return new RunUnknown();
      if (s.status === "completed" || s.status === "failed") return new RunClosed();
      if (s.status === "requested") return new RunNotSent();
      if (cmd.sessionId !== s.sessionId) return new WrongSession();
      return [new RunCompleted({ threadId: s.threadId, subject: s.subject, sessionId: s.sessionId, finding: redactValue(cmd.finding), at: nowMs(ctx) })];
    },
    FailRun: (s, cmd, ctx) => {
      if (s._tag !== "Run") return new RunUnknown();
      if (s.status === "failed") return [];
      if (s.status === "completed") return new RunClosed();
      const retryAs = s.promptId !== undefined && !s.promptId.endsWith(RETRY) ? `${s.promptId}${RETRY}` : undefined;
      return [new RunFailed({ threadId: s.threadId, sessionId: s.sessionId, reason: redactText(cmd.reason, { maxBytes: 1_000 }), at: nowMs(ctx), ...(retryAs ? { retryAs } : {}) })];
    },
  },
  evolve: {
    RunRequested: (_, e) => ({
      _tag: "Run" as const,
      threadId: e.threadId,
      subject: e.subject,
      sessionId: e.sessionId,
      messageId: e.messageId,
      status: "requested" as const,
      nudges: [],
      promptId: e.promptId,
    }),
    RunSent: (s) => (s._tag === "Run" ? { ...s, status: "sent" as const } : s),
    RunNudged: (s, e) => (s._tag === "Run" ? { ...s, nudges: [...s.nudges, e.messageId] } : s),
    RunCompleted: (s) => (s._tag === "Run" ? { ...s, status: "completed" as const } : s),
    RunFailed: (s) => (s._tag === "Run" ? { ...s, status: "failed" as const } : s),
  },
}) {}
