/**
 * What the page and agents read. Each view folds events into what one screen needs; none holds logic of its own.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Finding } from "./finding.ts";
import { IncidentId, RunId, Severity, ThreadId, threadIdOf } from "./ids.ts";
import { Incident, RECENT_MS } from "./incident.ts";
import { Run, RunStatus } from "./run.ts";
import { Handoff, Thread } from "./thread.ts";

/**
 * The one inbox: every incident, with the way out it has taken (if any), why it came back, and whether an agent is on
 * it. Which group a row belongs in, and whether it is new to the owner, is decided by the page from these facts.
 */
export const InboxKey = Schema.String;
export const INBOX = "inbox";

export const Disposition = Schema.Literals(["inbox", "done", "later", "never"]);
export type Disposition = typeof Disposition.Type;
const Occurrence = Schema.Struct({ at: Schema.Number, count: Schema.Number });

export const WayOut = Schema.Struct({
  kind: Schema.Literals(["done", "later", "never"]),
  /** Later: a time, a change, or only for it to get worse. */
  waitsFor: Schema.NullOr(Schema.Literals(["time", "change", "worse"])),
  at: Schema.Number,
  actor: Schema.String,
  /** Later: what the owner typed. Done and Never: the reason given, if any. */
  label: Schema.NullOr(Schema.String),
  /** Later: when it comes back; null until something changes. */
  until: Schema.NullOr(Schema.Number),
  severity: Schema.NullOr(Severity),
});
export type WayOut = typeof WayOut.Type;

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
  disposition: Disposition,
  way: Schema.NullOr(WayOut),
  /** Why it came back, in one line, until the owner takes a way out again. */
  back: Schema.NullOr(Schema.String),
  /** When something the owner would want to know about happened: opened, a finding, a rise in severity, came back. */
  changedAt: Schema.Number,
  /** Agent runs on it now. */
  running: Schema.Number,
  /** The last investigation failed even after its retry: the reason. */
  failure: Schema.NullOr(Schema.String),
  /** Occurrences over the last two weeks (what Never would have hidden). */
  recent: Schema.Array(Occurrence),
  /** Occurrences hidden while muted, over the last two weeks. */
  hidden: Schema.Array(Occurrence),
  /** When it came back after Done, over the last two weeks: a Done that keeps bouncing was the wrong way out. */
  returns: Schema.Array(Schema.Number),
}).annotate({ identifier: "InboxItem" });
export type InboxItem = typeof InboxItem.Type;

const replace = (items: ReadonlyArray<InboxItem>, id: string, update: (item: InboxItem) => InboxItem) =>
  items.map((item) => (item.incidentId === id ? update(item) : item));
const withinTwoWeeks = (list: ReadonlyArray<{ at: number; count: number }>, entry: { at: number; count: number }) => {
  const latest = Math.max(entry.at, ...list.map((o) => o.at));
  return [...list, entry].filter((o) => o.at > latest - RECENT_MS);
};
const incidentOf = (thread: string) => (thread.startsWith("thr_") ? thread.slice(4) : thread);
const out = (item: InboxItem, way: WayOut): InboxItem => ({ ...item, disposition: way.kind, way, back: null });

export class Inbox extends Domain.View("Inbox", {
  from: [Incident, Run],
  // 2: every incident stays, with its way out; runs and failures; recent and hidden occurrences; returns after Done.
  version: 2,
  key: InboxKey,
  keyOf: {
    IncidentOpened: () => INBOX,
    SignalRecurred: () => INBOX,
    IncidentArchived: () => INBOX,
    IncidentDone: () => INBOX,
    IncidentDeferred: () => INBOX,
    IncidentMuted: () => INBOX,
    IncidentRestored: () => INBOX,
    IncidentCameBack: () => INBOX,
    FindingRecorded: () => INBOX,
    RunRequested: () => INBOX,
    RunSent: () => INBOX,
    RunNudged: () => INBOX,
    RunCompleted: () => INBOX,
    RunFailed: () => INBOX,
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
          disposition: "inbox" as const,
          way: null,
          back: null,
          changedAt: e.at,
          running: 0,
          failure: null,
          recent: [{ at: e.at, count: e.count }],
          hidden: [],
          returns: [],
        },
        ...v.items.filter((item) => item.incidentId !== source.id),
      ],
    }),
    // A recurrence updates the row quietly; while muted it is counted as hidden.
    SignalRecurred: (v, e, { source }) => ({
      items: replace(v.items, source.id, (item) => ({
        ...item,
        lastAt: e.at,
        occurrences: e.occurrences,
        recent: withinTwoWeeks(item.recent, { at: e.at, count: e.count }),
        ...(e.severity ? { severity: e.severity, changedAt: e.at } : {}),
        ...(item.disposition === "never" ? { hidden: withinTwoWeeks(item.hidden, { at: e.at, count: e.count }) } : {}),
      })),
    }),
    IncidentArchived: (v, e, { source }) => ({
      items: replace(v.items, source.id, (item) => out(item, { kind: "done", waitsFor: null, at: e.at, actor: e.actor ?? "owner", label: e.reason, until: null, severity: item.severity })),
    }),
    IncidentDone: (v, e, { source }) => ({
      items: replace(v.items, source.id, (item) => out(item, { kind: "done", waitsFor: null, at: e.at, actor: e.actor, label: e.reason, until: null, severity: item.severity })),
    }),
    IncidentDeferred: (v, e, { source }) => ({
      items: replace(v.items, source.id, (item) => out(item, { kind: "later", waitsFor: e.waitsFor, at: e.at, actor: e.actor, label: e.label, until: e.until, severity: e.severity })),
    }),
    IncidentMuted: (v, e, { source }) => ({
      items: replace(v.items, source.id, (item) => ({ ...out(item, { kind: "never", waitsFor: null, at: e.at, actor: e.actor, label: e.reason, until: null, severity: e.severity }), hidden: [] })),
    }),
    IncidentRestored: (v, _e, { source }) => ({
      items: replace(v.items, source.id, (item) => ({ ...item, disposition: "inbox" as const, way: null, back: null })),
    }),
    IncidentCameBack: (v, e, { source }) => ({
      items: replace(v.items, source.id, (item) => ({
        ...item,
        disposition: "inbox" as const,
        way: null,
        back: e.reason,
        changedAt: e.at,
        returns: e.cause === "again" ? [...item.returns.filter((at) => at > e.at - RECENT_MS), e.at] : item.returns,
      })),
    }),
    FindingRecorded: (v, e, { source }) => ({
      items: replace(v.items, source.id, (item) => ({ ...item, verdict: e.finding.engineering.verdict, cause: e.finding.engineering.cause, changedAt: e.at })),
    }),
    RunRequested: (v, e) => ({ items: replace(v.items, e.subject, (item) => ({ ...item, running: item.running + 1, failure: null })) }),
    RunSent: (v) => v,
    RunNudged: (v) => v,
    RunCompleted: (v, e) => ({ items: replace(v.items, incidentOf(e.threadId), (item) => ({ ...item, running: Math.max(0, item.running - 1) })) }),
    // A failure that will be retried is not news; one that was the retry parks the work, with its reason.
    RunFailed: (v, e) => ({
      items: replace(v.items, incidentOf(e.threadId), (item) => ({
        ...item,
        running: Math.max(0, item.running - 1),
        ...(e.retryAs === undefined ? { failure: e.reason, changedAt: e.at } : {}),
      })),
    }),
  },
}, { description: "The owner's inbox: every incident, with the way out it took, why it came back, and whether an agent is on it." }) {}

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
  disposition: Disposition,
  back: Schema.NullOr(Schema.String),
  sample: Schema.NullOr(Schema.String),
  query: Schema.NullOr(Schema.String),
  timeline: Schema.Array(TimelineEntry),
  findings: Schema.Array(Schema.Struct({ runId: RunId, sessionId: Schema.String, at: Schema.Number, finding: Finding })),
});
export type IncidentPageState = typeof IncidentPageState.Type;

export class IncidentPage extends Domain.View("IncidentPage", {
  from: [Incident],
  // 1: the ways out and coming back.
  version: 1,
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
      back: null,
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
    IncidentArchived: (v, e) => v && { ...v, disposition: "done" as const, back: null, timeline: add(v.timeline, { at: e.at, kind: "done", text: e.reason }) },
    IncidentDone: (v, e) =>
      v && { ...v, disposition: "done" as const, back: null, timeline: add(v.timeline, { at: e.at, kind: "done", text: `Done by ${e.actor}${e.reason ? `: ${e.reason}` : ""}` }) },
    IncidentDeferred: (v, e) => v && { ...v, disposition: "later" as const, back: null, timeline: add(v.timeline, { at: e.at, kind: "later", text: `Later (${e.label}) by ${e.actor}` }) },
    IncidentMuted: (v, e) =>
      v && { ...v, disposition: "never" as const, back: null, timeline: add(v.timeline, { at: e.at, kind: "never", text: `Never by ${e.actor}${e.reason ? ` (${e.reason})` : ""}` }) },
    IncidentRestored: (v, e) => v && { ...v, disposition: "inbox" as const, back: null, timeline: add(v.timeline, { at: e.at, kind: "restored", text: `Undid ${e.undid} (${e.actor})` }) },
    IncidentCameBack: (v, e) => v && { ...v, disposition: "inbox" as const, back: e.reason, timeline: add(v.timeline, { at: e.at, kind: "back", text: e.reason }) },
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
