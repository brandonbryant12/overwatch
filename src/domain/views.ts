/**
 * What the page and agents read. Each view folds events into what one screen needs; none holds logic of its own.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Finding } from "./finding.ts";
import { IncidentId, RunId, Severity, ThreadId, threadIdOf } from "./ids.ts";
import { Incident } from "./incident.ts";
import { Run, RunStatus } from "./run.ts";
import { Handoff, Thread } from "./thread.ts";

/** The one inbox. Phase 1A has one kind of item, an incident; archive removes it for good. */
export const InboxKey = Schema.String;
export const INBOX = "inbox";

export const InboxItem = Schema.Struct({
  incidentId: IncidentId,
  title: Schema.String,
  app: Schema.String,
  environment: Schema.String,
  severity: Severity,
  firstAt: Schema.Number,
  lastAt: Schema.Number,
  occurrences: Schema.Number,
  verdict: Schema.NullOr(Schema.String),
  cause: Schema.NullOr(Schema.String),
});
export type InboxItem = typeof InboxItem.Type;

const replace = (items: ReadonlyArray<InboxItem>, id: string, update: (item: InboxItem) => InboxItem) =>
  items.map((item) => (item.incidentId === id ? update(item) : item));

export class Inbox extends Domain.View("Inbox", {
  from: [Incident],
  key: InboxKey,
  keyOf: {
    IncidentOpened: () => INBOX,
    SignalRecurred: () => INBOX,
    IncidentArchived: () => INBOX,
    FindingRecorded: () => INBOX,
  },
  state: Schema.Struct({ items: Schema.Array(InboxItem) }),
  initial: { items: [] },
  evolve: {
    IncidentOpened: (v, e, { source }) => ({
      items: [
        {
          incidentId: source.id,
          title: e.title,
          app: e.app,
          environment: e.environment,
          severity: e.severity,
          firstAt: e.firstAt,
          lastAt: e.at,
          occurrences: e.count,
          verdict: null,
          cause: null,
        },
        ...v.items.filter((item) => item.incidentId !== source.id),
      ],
    }),
    // A recurrence updates the item quietly, and only while it is in the inbox: it never brings one back.
    SignalRecurred: (v, e, { source }) => ({ items: replace(v.items, source.id, (item) => ({ ...item, lastAt: e.at, occurrences: e.occurrences })) }),
    IncidentArchived: (v, _e, { source }) => ({ items: v.items.filter((item) => item.incidentId !== source.id) }),
    FindingRecorded: (v, e, { source }) => ({
      items: replace(v.items, source.id, (item) => ({ ...item, verdict: e.finding.engineering.verdict, cause: e.finding.engineering.cause })),
    }),
  },
}, { description: "The owner's inbox: incidents that need a look. Archived ones are gone for good." }) {}

export const TimelineEntry = Schema.Struct({ at: Schema.Number, kind: Schema.String, text: Schema.String });
const TIMELINE = 50;
const add = <T>(list: ReadonlyArray<T>, entry: T) => [...list, entry].slice(-TIMELINE);

export const IncidentPageState = Schema.Struct({
  incidentId: IncidentId,
  threadId: ThreadId,
  title: Schema.String,
  app: Schema.String,
  environment: Schema.String,
  source: Schema.String,
  fingerprint: Schema.String,
  severity: Severity,
  firstAt: Schema.Number,
  lastAt: Schema.Number,
  occurrences: Schema.Number,
  disposition: Schema.Literals(["inbox", "archived"]),
  sample: Schema.NullOr(Schema.String),
  query: Schema.NullOr(Schema.String),
  timeline: Schema.Array(TimelineEntry),
  findings: Schema.Array(Schema.Struct({ runId: RunId, sessionId: Schema.String, at: Schema.Number, finding: Finding })),
});
export type IncidentPageState = typeof IncidentPageState.Type;

export class IncidentPage extends Domain.View("IncidentPage", {
  from: [Incident],
  key: Incident,
  state: Schema.NullOr(IncidentPageState),
  initial: null,
  evolve: {
    IncidentOpened: (_, e, { source }) => ({
      incidentId: source.id,
      threadId: threadIdOf(source.id),
      title: e.title,
      app: e.app,
      environment: e.environment,
      source: e.source,
      fingerprint: e.fingerprint,
      severity: e.severity,
      firstAt: e.firstAt,
      lastAt: e.at,
      occurrences: e.count,
      disposition: "inbox" as const,
      sample: e.sample ?? null,
      query: e.query ?? null,
      timeline: [{ at: e.at, kind: "opened", text: `${e.count} × ${e.title}` }],
      findings: [],
    }),
    SignalRecurred: (v, e) =>
      v && {
        ...v,
        lastAt: e.at,
        occurrences: e.occurrences,
        sample: e.sample ?? v.sample,
        timeline: add(v.timeline, { at: e.at, kind: "recurred", text: `${e.count} more (${e.occurrences} in all)` }),
      },
    IncidentArchived: (v, e) => v && { ...v, disposition: "archived" as const, timeline: add(v.timeline, { at: e.at, kind: "archived", text: e.reason }) },
    FindingRecorded: (v, e) =>
      v && {
        ...v,
        findings: [...v.findings, { runId: e.runId, sessionId: e.sessionId, at: e.at, finding: e.finding }],
        timeline: add(v.timeline, { at: e.at, kind: "finding", text: `${e.finding.engineering.verdict}: ${e.finding.engineering.cause}` }),
      },
  },
}, { description: "One incident: what was seen, its timeline and its checked findings." }) {}

export const PromptStatus = Schema.Literals(["held", "queued", "sent", "answered", "failed"]);
export const ThreadPrompt = Schema.Struct({
  promptId: Schema.String,
  text: Schema.String,
  origin: Schema.String,
  runId: RunId,
  sessionId: Schema.String,
  newSession: Schema.Boolean,
  reason: Schema.String,
  status: PromptStatus,
  failure: Schema.NullOr(Schema.String),
  at: Schema.Number,
});
export const ThreadPageState = Schema.Struct({
  threadId: ThreadId,
  subject: IncidentId,
  title: Schema.String,
  archived: Schema.Boolean,
  prompts: Schema.Array(ThreadPrompt),
  sessions: Schema.Array(Schema.Struct({ sessionId: Schema.String, mode: Schema.String, status: Schema.String })),
  handoff: Schema.NullOr(Handoff),
});
export type ThreadPageState = typeof ThreadPageState.Type;

const promptStatus = (v: ThreadPageState | null, runId: string, status: typeof PromptStatus.Type, failure: string | null = null) =>
  v && { ...v, prompts: v.prompts.map((p) => (p.runId === runId ? { ...p, status, failure } : p)) };

export class ThreadPage extends Domain.View("ThreadPage", {
  from: [Thread, Run],
  key: Thread,
  keyOf: {
    RunRequested: ({ event }) => Thread.ref(event.threadId),
    RunSent: ({ event }) => Thread.ref(event.threadId),
    RunNudged: ({ event }) => Thread.ref(event.threadId),
    RunCompleted: ({ event }) => Thread.ref(event.threadId),
    RunFailed: ({ event }) => Thread.ref(event.threadId),
  },
  state: Schema.NullOr(ThreadPageState),
  initial: null,
  evolve: {
    PromptAsked: (v, e, { key }) => {
      const base = v ?? { threadId: key.id, subject: e.subject, title: e.title, archived: false, prompts: [], sessions: [], handoff: null };
      return {
        ...base,
        prompts: [
          ...base.prompts,
          {
            promptId: e.promptId,
            text: e.text,
            origin: e.origin,
            runId: e.runId,
            sessionId: e.sessionId,
            newSession: e.newSession,
            reason: e.held ? "held: automatic investigation is off; prompt on it to start" : e.reason,
            status: e.held ? ("held" as const) : ("queued" as const),
            failure: null,
            at: e.at,
          },
        ],
        sessions: e.newSession && !e.held ? [...base.sessions, { sessionId: e.sessionId, mode: e.mode, status: "pending" }] : base.sessions,
      };
    },
    SessionStatusNoted: (v, e) => v && { ...v, sessions: v.sessions.map((s) => (s.sessionId === e.sessionId ? { ...s, status: e.status } : s)) },
    HandoffRecorded: (v, e) => v && { ...v, handoff: e.handoff },
    ThreadArchived: (v) => v && { ...v, archived: true },
    RunRequested: (v) => v,
    RunSent: (v, _e, { source }) => promptStatus(v, source.id, "sent"),
    RunNudged: (v) => v,
    RunCompleted: (v, _e, { source }) => promptStatus(v, source.id, "answered"),
    RunFailed: (v, e, { source }) => promptStatus(v, source.id, "failed", e.reason),
  },
}, { description: "A thread: the prompts asked about one subject, how each was routed, and the last handoff." }) {}

/** Runs not yet finished, for the service's worker. */
export const PendingRun = Schema.Struct({
  runId: RunId,
  threadId: ThreadId,
  subject: IncidentId,
  promptId: Schema.String,
  mode: Schema.String,
  sessionId: Schema.String,
  messageId: Schema.String,
  newSession: Schema.Boolean,
  delivery: Schema.NullOr(Schema.String),
  text: Schema.String,
  origin: Schema.String,
  handoff: Schema.NullOr(Handoff),
  status: RunStatus,
  nudges: Schema.Array(Schema.String),
  /** When the run was asked for. */
  at: Schema.Number,
  /** When its prompt was sent to OpenCode: its time limit counts from here, not from when it was asked for. */
  sentAt: Schema.NullOr(Schema.Number),
});
export type PendingRun = typeof PendingRun.Type;
export const RUNS = "runs";

const updateRun = (v: { runs: ReadonlyArray<PendingRun> }, id: string, update: (run: PendingRun) => PendingRun) => ({
  runs: v.runs.map((run) => (run.runId === id ? update(run) : run)),
});

export class PendingRuns extends Domain.View("PendingRuns", {
  from: [Run],
  // 1: runs carry sentAt.
  version: 1,
  key: Schema.String,
  keyOf: {
    RunRequested: () => RUNS,
    RunSent: () => RUNS,
    RunNudged: () => RUNS,
    RunCompleted: () => RUNS,
    RunFailed: () => RUNS,
  },
  state: Schema.Struct({ runs: Schema.Array(PendingRun) }),
  initial: { runs: [] },
  evolve: {
    RunRequested: (v, e, { source }) => ({
      runs: [
        ...v.runs.filter((r) => r.runId !== source.id),
        {
          runId: source.id,
          threadId: e.threadId,
          subject: e.subject,
          promptId: e.promptId,
          mode: e.mode,
          sessionId: e.sessionId,
          messageId: e.messageId,
          newSession: e.newSession,
          delivery: e.delivery ?? null,
          text: e.text,
          origin: e.origin,
          handoff: e.handoff,
          status: "requested" as const,
          nudges: [],
          at: e.at,
          sentAt: null,
        },
      ],
    }),
    RunSent: (v, e, { source }) => updateRun(v, source.id, (r) => ({ ...r, status: "sent" as const, sentAt: e.at })),
    RunNudged: (v, e, { source }) => updateRun(v, source.id, (r) => ({ ...r, nudges: [...r.nudges, e.messageId] })),
    RunCompleted: (v, _e, { source }) => ({ runs: v.runs.filter((r) => r.runId !== source.id) }),
    RunFailed: (v, _e, { source }) => ({ runs: v.runs.filter((r) => r.runId !== source.id) }),
  },
}, { description: "Agent runs requested and not yet finished." }) {}
