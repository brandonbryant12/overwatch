/**
 * Thread: a line of work about one subject. It records the prompts asked, the routing decision for each, the
 * sessions that served them, and the handoff the last one left. The handoff, not a transcript, is what a new
 * session starts from.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { IncidentId, messageIdOf, Mode, Origin, Override, RunId, runIdOf, sessionIdOf, ThreadId } from "./ids.ts";
import { routePrompt, type SessionStatus } from "./route.ts";
import { fieldsOf, nowMs } from "./time.ts";

export class ThreadClosed extends Domain.Rejection("ThreadClosed", {}, { description: "The thread is archived." }) {}

export const Handoff = Schema.Struct({
  runId: RunId,
  sessionId: Schema.String,
  concluded: Schema.String,
  verified: Schema.Array(Schema.Struct({ source: Schema.String, quote: Schema.String })),
  ruledOut: Schema.Array(Schema.String),
  open: Schema.Array(Schema.String),
  at: Schema.Number,
});
export type Handoff = typeof Handoff.Type;

const SessionStatusSchema = Schema.Literals(["pending", "running", "idle", "failed"]);

export class PromptAsked extends Domain.Event("PromptAsked", {
  subject: IncidentId,
  title: Schema.String,
  promptId: Schema.String,
  text: Schema.String,
  mode: Mode,
  origin: Origin,
  runId: RunId,
  sessionId: Schema.String,
  messageId: Schema.String,
  newSession: Schema.Boolean,
  /** `queue` to wait for the session's current turn; absent for a new session. */
  delivery: Schema.optionalKey(Schema.Literal("queue")),
  reason: Schema.String,
  /** Recorded but not sent: automatic investigation is off. */
  held: Schema.Boolean,
  /** What the last session concluded, as it stood when the prompt was asked. */
  handoff: Schema.NullOr(Handoff),
  at: Schema.Number,
}) {}
export class SessionStatusNoted extends Domain.Event("SessionStatusNoted", {
  sessionId: Schema.String,
  status: SessionStatusSchema,
}) {}
export class HandoffRecorded extends Domain.Event("HandoffRecorded", { handoff: Handoff }) {}
export class ThreadArchived extends Domain.Event("ThreadArchived", { at: Schema.Number }) {}

export class AskThread extends Domain.Command("AskThread", {
  target: ThreadId,
  input: {
    subject: IncidentId,
    title: Schema.String,
    /** Chosen by the caller, so a retried ask is the same ask. */
    promptId: Schema.String,
    text: Schema.String,
    mode: Mode,
    origin: Origin,
    override: Override,
    hold: Schema.optionalKey(Schema.Boolean),
    /** The session the prompt was typed in, when the owner asked in OpenCode itself: it continues there. */
    inSession: Schema.optionalKey(Schema.String),
  },
  events: [PromptAsked],
  rejects: [ThreadClosed],
}, { description: "Ask about the thread's subject. Overwatch decides whether this continues a session or starts one." }) {}

export class NoteSession extends Domain.Command("NoteSession", {
  target: ThreadId,
  input: { sessionId: Schema.String, status: SessionStatusSchema },
  events: [SessionStatusNoted],
}) {}

export class RecordHandoff extends Domain.Command("RecordHandoff", {
  target: ThreadId,
  input: { handoff: Handoff },
  events: [HandoffRecorded],
}) {}

export class ArchiveThread extends Domain.Command("ArchiveThread", {
  target: ThreadId,
  input: {},
  events: [ThreadArchived],
}, { description: "Archive a thread. Its worktree and the evidence its sessions were shown can then be removed." }) {}

const SessionEntry = Schema.Struct({ sessionId: Schema.String, mode: Mode, status: SessionStatusSchema });

export const ThreadState = Schema.Union([
  Schema.TaggedStruct("Unstarted", {}),
  Schema.TaggedStruct("Active", {
    subject: IncidentId,
    prompts: Schema.Array(Schema.String),
    sessions: Schema.Array(SessionEntry),
    handoff: Schema.NullOr(Handoff),
    archived: Schema.Boolean,
  }),
]);
export type ThreadState = typeof ThreadState.Type;

export class Thread extends Domain.Aggregate("Thread", {
  id: ThreadId,
  state: ThreadState,
  initial: { _tag: "Unstarted" as const },
  commands: [AskThread, NoteSession, RecordHandoff, ArchiveThread],
  decide: {
    AskThread: (s, cmd, ctx) => {
      if (s._tag === "Active" && s.archived) return new ThreadClosed();
      if (s._tag === "Active" && s.prompts.includes(cmd.promptId)) return [];
      const sessions = s._tag === "Active" ? s.sessions : [];
      const route =
        cmd.inSession !== undefined
          ? ({ kind: "continue", sessionId: cmd.inSession, delivery: "queue", reason: "asked in this session, in OpenCode" } as const)
          : routePrompt(sessions, cmd.mode, cmd.override);
      const newSession = route.kind === "new";
      return [
        new PromptAsked({
          subject: cmd.subject,
          title: cmd.title,
          promptId: cmd.promptId,
          text: cmd.text,
          mode: cmd.mode,
          origin: cmd.origin,
          runId: runIdOf(ctx.id, cmd.promptId),
          sessionId: route.kind === "new" ? sessionIdOf(ctx.id, cmd.promptId) : route.sessionId,
          messageId: messageIdOf(ctx.id, cmd.promptId),
          newSession,
          ...(route.kind === "continue" ? { delivery: route.delivery } : {}),
          reason: route.reason,
          held: cmd.hold === true,
          handoff: s._tag === "Active" ? s.handoff : null,
          at: nowMs(ctx),
        }),
      ];
    },
    NoteSession: (s, cmd) => {
      if (s._tag !== "Active") return [];
      const known = s.sessions.find((x) => x.sessionId === cmd.sessionId);
      return known?.status === cmd.status ? [] : [new SessionStatusNoted(fieldsOf(cmd))];
    },
    RecordHandoff: (s, cmd) => (s._tag === "Active" && s.handoff?.runId === cmd.handoff.runId ? [] : [new HandoffRecorded(fieldsOf(cmd))]),
    ArchiveThread: (s, _cmd, ctx) => (s._tag === "Active" && !s.archived ? [new ThreadArchived({ at: nowMs(ctx) })] : []),
  },
  evolve: {
    PromptAsked: (s, e) => {
      const base = s._tag === "Active" ? s : { _tag: "Active" as const, subject: e.subject, prompts: [], sessions: [], handoff: null, archived: false };
      const sessions = e.held || !e.newSession ? base.sessions : [...base.sessions, { sessionId: e.sessionId, mode: e.mode, status: "pending" as SessionStatus }];
      return { ...base, prompts: [...base.prompts, e.promptId], sessions };
    },
    SessionStatusNoted: (s, e) =>
      s._tag === "Active" ? { ...s, sessions: s.sessions.map((x) => (x.sessionId === e.sessionId ? { ...x, status: e.status } : x)) } : s,
    HandoffRecorded: (s, e) => (s._tag === "Active" ? { ...s, handoff: e.handoff } : s),
    ThreadArchived: (s) => (s._tag === "Active" ? { ...s, archived: true } : s),
  },
}) {}
