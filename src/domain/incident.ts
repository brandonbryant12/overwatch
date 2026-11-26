/**
 * Incident: one problem in one app and environment, from its first signal on. It records the signal, quiet
 * recurrences and findings, and the owner's three ways out of the inbox:
 *
 * - **Done**: "this is dealt with." It comes back if it happens again. Occurrences already in flight do not count:
 *   anything up to one polling interval after Done is ignored.
 * - **Later**: "not now." Until a time, until something changes (a new finding, a deploy in its environment), or
 *   until it gets worse. Every Later also comes back if it gets worse: the severity rises, or the rate reaches a
 *   multiple of what it was (twice, with at least five more, by default).
 * - **Never**: "stop raising this." Muted in its app and environment (an incident is one fingerprint there). It breaks
 *   through only if the severity rises, or the rate reaches a larger multiple of what it was when muted (ten times by
 *   default). More of it is counted as hidden.
 *
 * Each way out is undoable (Restore). Whatever brings an incident back records one line saying why. Every owner action
 * records who or what issued it. Free text is redacted here, before an event exists.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { redactText, redactValue } from "./redact.ts";
import { fieldsOf, nowMs } from "./time.ts";
import { Finding } from "./finding.ts";
import { IncidentId, RunId, Severity, ThreadId, WatcherId } from "./ids.ts";

export class NotOpened extends Domain.Rejection("NotOpened", {}, { description: "There is no incident with this id." }) {}

const SignalFields = {
  app: Schema.String,
  environment: Schema.String,
  watcher: WatcherId,
  /** The telemetry source the signal came from. */
  source: Schema.String,
  fingerprint: Schema.String,
  title: Schema.String,
  severity: Severity,
  /** When the newest occurrence happened, epoch milliseconds. */
  at: Schema.Number,
  /** Occurrences this report adds. */
  count: Schema.Number,
  /** When the oldest of them happened, if earlier than `at`. */
  firstAt: Schema.optionalKey(Schema.Number),
  /** A redacted, bounded line that shows the signal. */
  sample: Schema.optionalKey(Schema.String),
  /** How to see the same thing again. */
  query: Schema.optionalKey(Schema.String),
};

/**
 * When an incident that took a way out comes back. Data, sent with each report from the configuration.
 * - `graceMs`: after Done, occurrences up to this long after it were already in flight (one polling interval).
 * - `multiple`, `atLeast`: Later comes back when the rate reaches `multiple` times what it was, with `atLeast` more.
 * - `neverMultiple`: Never breaks through when the rate reaches this many times what it was when muted.
 */
export const ComeBack = Schema.Struct({ graceMs: Schema.Number, multiple: Schema.Number, atLeast: Schema.Number, neverMultiple: Schema.Number });
export type ComeBack = typeof ComeBack.Type;
export const DEFAULT_COME_BACK: ComeBack = { graceMs: 10 * 60_000, multiple: 2, atLeast: 5, neverMultiple: 10 };

/** The one-tap reasons for Never. */
export const MuteReason = Schema.Literals(["noise", "expected", "duplicate"]);
export type MuteReason = typeof MuteReason.Type;

/** What brought an incident back. */
export const BackCause = Schema.Literals(["again", "severity", "worse", "time", "finding", "deploy"]);

/** What a Later waits for: a time, a change (a new finding or a deploy), or only for it to get worse. */
export const LaterUntil = Schema.Literals(["time", "change", "worse"]);

export class IncidentOpened extends Domain.Event("IncidentOpened", { ...SignalFields, firstAt: Schema.Number }) {}
export class SignalRecurred extends Domain.Event("SignalRecurred", {
  at: Schema.Number,
  count: Schema.Number,
  occurrences: Schema.Number,
  sample: Schema.optionalKey(Schema.String),
  /** Present when this report raised the incident's severity. */
  severity: Schema.optionalKey(Severity),
}) {}
/** Retired: archive was replaced by the three ways out. Kept so journals that have it still read (as Done). */
export class IncidentArchived extends Domain.Event("IncidentArchived", {
  reason: Schema.String,
  at: Schema.Number,
  actor: Schema.optionalKey(Schema.String),
}) {}
export class FindingRecorded extends Domain.Event("FindingRecorded", {
  runId: RunId,
  threadId: ThreadId,
  sessionId: Schema.String,
  finding: Finding,
  at: Schema.Number,
}) {}
export class IncidentDone extends Domain.Event("IncidentDone", {
  at: Schema.Number,
  /** Who or what issued it, as the caller names itself: `owner (page)`, an agent. */
  actor: Schema.String,
  reason: Schema.NullOr(Schema.String),
}) {}
export class IncidentDeferred extends Domain.Event("IncidentDeferred", {
  at: Schema.Number,
  actor: Schema.String,
  waitsFor: LaterUntil,
  /** When it comes back, for a Later until a time. */
  until: Schema.NullOr(Schema.Number),
  /** What the owner typed, such as "2h" or "monday", or "until something changes". */
  label: Schema.String,
  /** The severity and the rate (occurrences in the day before) it is measured against for "gets worse". */
  severity: Severity,
  perDay: Schema.Number,
}) {}
export class IncidentMuted extends Domain.Event("IncidentMuted", {
  at: Schema.Number,
  actor: Schema.String,
  reason: Schema.NullOr(MuteReason),
  /** The severity and the rate when muted: higher severity, or many times the rate, breaks through. */
  severity: Severity,
  perDay: Schema.Number,
}) {}
/** Undo: the incident is back in the inbox exactly as it was before its way out. */
export class IncidentRestored extends Domain.Event("IncidentRestored", {
  at: Schema.Number,
  actor: Schema.String,
  /** The way out that was undone. */
  undid: Schema.String,
}) {}
export class IncidentCameBack extends Domain.Event("IncidentCameBack", {
  at: Schema.Number,
  cause: BackCause,
  /** One line for the owner: "Back: 4x the rate it had when you marked it done." */
  reason: Schema.String,
}) {}

/** A signal from a watcher. Opens the incident, or counts quietly against the open one; may bring it back. */
export class ReportSignal extends Domain.Command("ReportSignal", {
  target: IncidentId,
  input: { ...SignalFields, comeBack: Schema.optionalKey(ComeBack) },
  events: [IncidentOpened, SignalRecurred, IncidentCameBack],
}, { description: "Record a signal a watcher found." }) {}

export class MarkDone extends Domain.Command("MarkDone", {
  target: IncidentId,
  input: { actor: Schema.optionalKey(Schema.String), reason: Schema.optionalKey(Schema.String) },
  events: [IncidentDone, IncidentArchived],
  rejects: [NotOpened],
}, { description: "Done: it leaves the inbox and comes back only if it gets materially worse (severity, or a multiple of its rate)." }) {}

export class Defer extends Domain.Command("Defer", {
  target: IncidentId,
  input: {
    /** Epoch milliseconds, for a Later until a time. */
    until: Schema.optionalKey(Schema.Number),
    /** Without `until`: "change" (default) waits for a new finding or a deploy; "worse" only for it to get worse. */
    waitsFor: Schema.optionalKey(Schema.Literals(["change", "worse"])),
    label: Schema.optionalKey(Schema.String),
    actor: Schema.optionalKey(Schema.String),
  },
  events: [IncidentDeferred],
  rejects: [NotOpened],
}, { description: "Later: it leaves the inbox until a time, until something changes, or until it gets worse, and comes back saying which." }) {}

export class Mute extends Domain.Command("Mute", {
  target: IncidentId,
  input: { reason: Schema.optionalKey(MuteReason), actor: Schema.optionalKey(Schema.String) },
  events: [IncidentMuted],
  rejects: [NotOpened],
}, { description: "Never: mutes this fingerprint in its app and environment. It breaks through only if its severity rises." }) {}

export class Restore extends Domain.Command("Restore", {
  target: IncidentId,
  input: { actor: Schema.optionalKey(Schema.String) },
  events: [IncidentRestored],
  rejects: [NotOpened],
}, { description: "Undo a way out: the incident returns to the inbox." }) {}

/** Scheduled when an incident is deferred to a time. Does nothing if it was deferred again or put back since. */
export class WakeDeferred extends Domain.Command("WakeDeferred", {
  target: IncidentId,
  input: { deferredAt: Schema.Number },
  events: [IncidentCameBack],
}, { description: "The time an incident was deferred to has come." }) {}

/**
 * Something changed in the incident's environment (a deploy), at `at`. Every incident in the environment is told; each
 * decides from its own history: only a Later until a change that was already in force at `at` comes back. A deploy
 * told late, or one told before the deferral it raced, is judged by when it happened, not when it arrived.
 */
export class NoteChange extends Domain.Command("NoteChange", {
  target: IncidentId,
  input: { cause: Schema.Literals(["deploy"]), reason: Schema.String, at: Schema.Number },
  events: [IncidentCameBack],
}, { description: "Something changed in the incident's environment." }) {}

export class RecordFinding extends Domain.Command("RecordFinding", {
  target: IncidentId,
  input: { runId: RunId, threadId: ThreadId, sessionId: Schema.String, finding: Finding },
  events: [FindingRecorded, IncidentCameBack],
  rejects: [NotOpened],
}, { description: "Record a finding whose citations were checked." }) {}

/** Occurrences, by report, over the last two weeks: the rate for Done and the preview for Never. */
const Occurrence = Schema.Struct({ at: Schema.Number, count: Schema.Number });
export const RECENT_MS = 14 * 24 * 3_600_000;
export const DAY_MS = 24 * 3_600_000;

const Way = Schema.Union([
  Schema.TaggedStruct("Done", { at: Schema.Number }),
  Schema.TaggedStruct("Later", { at: Schema.Number, waitsFor: LaterUntil, until: Schema.NullOr(Schema.Number), label: Schema.String, severity: Severity, perDay: Schema.Number, since: Schema.Number }),
  Schema.TaggedStruct("Never", { at: Schema.Number, severity: Severity, perDay: Schema.Number, since: Schema.Number }),
]);
type Way = typeof Way.Type;

export const IncidentState = Schema.Union([
  Schema.TaggedStruct("Unopened", {}),
  Schema.TaggedStruct("Open", {
    app: Schema.String,
    environment: Schema.String,
    fingerprint: Schema.String,
    title: Schema.String,
    occurrences: Schema.Number,
    lastAt: Schema.Number,
    /** Kept for state written before the ways out; read as Done. */
    disposition: Schema.Literals(["inbox", "archived"]),
    findings: Schema.Array(RunId),
    severity: Schema.optionalKey(Severity),
    recent: Schema.optionalKey(Schema.Array(Occurrence)),
    way: Schema.optionalKey(Schema.NullOr(Way)),
  }),
]);
export type IncidentState = typeof IncidentState.Type;
type Open = Extract<IncidentState, { _tag: "Open" }>;

const RANK = { info: 1, warn: 2, error: 3 } as const;
export const severityAbove = (a: Severity, b: Severity) => RANK[a] > RANK[b];
const occurredSince = (recent: ReadonlyArray<{ at: number; count: number }>, from: number) =>
  recent.reduce((sum, o) => (o.at > from ? sum + o.count : sum), 0);
const addRecent = (recent: ReadonlyArray<{ at: number; count: number }>, entry: { at: number; count: number }) => {
  const latest = Math.max(entry.at, ...recent.map((o) => o.at));
  return [...recent, entry].filter((o) => o.at > latest - RECENT_MS);
};
/** The way out an incident has taken, if any. State written before the ways out reads archived as Done. */
const wayOf = (s: Open): Way | null => (s.way !== undefined ? s.way : s.disposition === "archived" ? { _tag: "Done", at: s.lastAt } : null);
const actorOf = (actor: string | undefined) => redactText(actor ?? "owner", { maxBytes: 120 });
const WAY_NAME = { Done: "done", Later: "later", Never: "never" } as const;

const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`;

/** Whether a report brings an incident that took a way out back, and the one line that says why. */
function comesBack(way: Way, s: Open, cmd: { severity: Severity; at: number; count: number; firstAt?: number }, rule: ComeBack): { cause: "again" | "severity" | "worse"; reason: string } | null {
  if (way._tag === "Done") {
    // Anything up to one polling interval after Done was already in flight.
    const quietUntil = way.at + rule.graceMs;
    if (cmd.at <= quietUntil) return null;
    const allAfter = (cmd.firstAt ?? cmd.at) > quietUntil;
    return { cause: "again", reason: allAfter ? `Back: happened again ${times(cmd.count)} since you marked it done.` : "Back: happened again since you marked it done." };
  }
  if (severityAbove(cmd.severity, way.severity)) {
    return way._tag === "Never"
      ? { cause: "severity", reason: `Back through Never: now ${cmd.severity}, above the ${way.severity} it was when you muted it.` }
      : { cause: "severity", reason: `Back: now ${cmd.severity}; it was ${way.severity} when you said later.` };
  }
  const since = way.since + cmd.count;
  if (since < rule.atLeast) return null;
  const lastDay = occurredSince(addRecent(s.recent ?? [], { at: cmd.at, count: cmd.count }), cmd.at - DAY_MS);
  const multiple = way._tag === "Never" ? rule.neverMultiple : rule.multiple;
  if (lastDay < multiple * Math.max(way.perDay, 1)) return null;
  const was = way.perDay === 0 ? "none in the day before" : `${way.perDay} in the day before`;
  const x = way.perDay === 0 ? lastDay : Math.floor(lastDay / way.perDay);
  return way._tag === "Never"
    ? { cause: "worse", reason: `Back through Never: ${x}x the rate it had when you muted it (${lastDay} in the last day, ${was}).` }
    : { cause: "worse", reason: `Back: ${x}x the rate it had when you said later (${lastDay} in the last day, ${was}).` };
}

export class Incident extends Domain.Aggregate("Incident", {
  id: IncidentId,
  state: IncidentState,
  initial: { _tag: "Unopened" as const },
  commands: [ReportSignal, MarkDone, Defer, Mute, Restore, WakeDeferred, NoteChange, RecordFinding],
  decide: {
    ReportSignal: (s, raw, ctx) => {
      // Text from outside is redacted here, before the event that records it exists.
      const { comeBack: rule, ...signal } = raw;
      const cmd = { ...signal, title: redactText(raw.title, { maxBytes: 400 }), ...(raw.sample === undefined ? {} : { sample: redactText(raw.sample, { maxBytes: 2_000 }) }), ...(raw.query === undefined ? {} : { query: redactText(raw.query, { maxBytes: 2_000 }) }) };
      if (s._tag === "Unopened") return [new IncidentOpened({ ...fieldsOf(cmd), firstAt: cmd.firstAt ?? cmd.at })];
      const severity = s.severity ?? cmd.severity;
      const recurred = new SignalRecurred({
        at: Math.max(s.lastAt, cmd.at),
        count: cmd.count,
        occurrences: s.occurrences + cmd.count,
        ...(cmd.sample === undefined ? {} : { sample: cmd.sample }),
        ...(severityAbove(cmd.severity, severity) ? { severity: cmd.severity } : {}),
      });
      const way = wayOf(s);
      const back = way ? comesBack(way, s, cmd, rule ?? DEFAULT_COME_BACK) : null;
      return back ? [recurred, new IncidentCameBack({ at: nowMs(ctx), ...back })] : [recurred];
    },
    MarkDone: (s, cmd, ctx) => {
      if (s._tag === "Unopened") return new NotOpened();
      if (wayOf(s)?._tag === "Done") return [];
      return [new IncidentDone({ at: nowMs(ctx), actor: actorOf(cmd.actor), reason: cmd.reason === undefined ? null : redactText(cmd.reason, { maxBytes: 500 }) })];
    },
    Defer: (s, cmd, ctx) => {
      if (s._tag === "Unopened") return new NotOpened();
      const until = cmd.until ?? null;
      const waitsFor = until !== null ? "time" : (cmd.waitsFor ?? "change");
      const way = wayOf(s);
      if (way?._tag === "Later" && way.until === until && way.waitsFor === waitsFor) return [];
      const at = nowMs(ctx);
      const fallback = waitsFor === "time" ? "later" : waitsFor === "worse" ? "until it gets worse" : "until something changes";
      return [
        new IncidentDeferred({
          at,
          actor: actorOf(cmd.actor),
          waitsFor,
          until,
          label: redactText(cmd.label ?? fallback, { maxBytes: 80 }),
          severity: s.severity ?? "error",
          perDay: occurredSince(s.recent ?? [], Math.max(at, s.lastAt) - DAY_MS),
        }),
      ];
    },
    Mute: (s, cmd, ctx) => {
      if (s._tag === "Unopened") return new NotOpened();
      if (wayOf(s)?._tag === "Never") return [];
      const at = nowMs(ctx);
      return [
        new IncidentMuted({
          at,
          actor: actorOf(cmd.actor),
          reason: cmd.reason ?? null,
          severity: s.severity ?? "error",
          perDay: occurredSince(s.recent ?? [], Math.max(at, s.lastAt) - DAY_MS),
        }),
      ];
    },
    Restore: (s, cmd, ctx) => {
      if (s._tag === "Unopened") return new NotOpened();
      const way = wayOf(s);
      return way ? [new IncidentRestored({ at: nowMs(ctx), actor: actorOf(cmd.actor), undid: WAY_NAME[way._tag] })] : [];
    },
    WakeDeferred: (s, cmd, ctx) => {
      if (s._tag !== "Open") return [];
      const way = wayOf(s);
      if (way?._tag !== "Later" || way.at !== cmd.deferredAt || way.waitsFor !== "time") return [];
      return [new IncidentCameBack({ at: nowMs(ctx), cause: "time", reason: `Back: you said later (${way.label}).` })];
    },
    NoteChange: (s, cmd, ctx) => {
      if (s._tag !== "Open") return [];
      const way = wayOf(s);
      if (way?._tag !== "Later" || way.waitsFor !== "change" || way.at > cmd.at) return [];
      return [new IncidentCameBack({ at: nowMs(ctx), cause: cmd.cause, reason: redactText(cmd.reason, { maxBytes: 300 }) })];
    },
    RecordFinding: (s, cmd, ctx) => {
      if (s._tag === "Unopened") return new NotOpened();
      if (s.findings.includes(cmd.runId)) return [];
      const finding = redactValue(cmd.finding);
      const recorded = new FindingRecorded({ ...fieldsOf(cmd), finding, at: nowMs(ctx) });
      const way = wayOf(s);
      if (way?._tag === "Later" && way.waitsFor === "change") {
        const e = finding.engineering;
        return [recorded, new IncidentCameBack({ at: nowMs(ctx), cause: "finding", reason: `Back: a new finding arrived (${e.verdict}: ${e.cause.slice(0, 120)}).` })];
      }
      return [recorded];
    },
  },
  evolve: {
    IncidentOpened: (_, e) => ({
      _tag: "Open" as const,
      app: e.app,
      environment: e.environment,
      fingerprint: e.fingerprint,
      title: e.title,
      occurrences: e.count,
      lastAt: e.at,
      disposition: "inbox" as const,
      findings: [],
      severity: e.severity,
      recent: [{ at: e.at, count: e.count }],
      way: null,
    }),
    SignalRecurred: (s, e) =>
      s._tag === "Open"
        ? {
            ...s,
            occurrences: e.occurrences,
            lastAt: e.at,
            recent: addRecent(s.recent ?? [], { at: e.at, count: e.count }),
            ...(e.severity ? { severity: e.severity } : {}),
            way: ((way) => (way && way._tag !== "Done" ? { ...way, since: way.since + e.count } : way))(wayOf(s)),
          }
        : s,
    IncidentArchived: (s) => (s._tag === "Open" ? { ...s, disposition: "archived" as const } : s),
    IncidentDone: (s, e) => (s._tag === "Open" ? { ...s, way: { _tag: "Done" as const, at: e.at } } : s),
    IncidentDeferred: (s, e) =>
      s._tag === "Open" ? { ...s, way: { _tag: "Later" as const, at: e.at, waitsFor: e.waitsFor, until: e.until, label: e.label, severity: e.severity, perDay: e.perDay, since: 0 } } : s,
    IncidentMuted: (s, e) => (s._tag === "Open" ? { ...s, way: { _tag: "Never" as const, at: e.at, severity: e.severity, perDay: e.perDay, since: 0 } } : s),
    IncidentRestored: (s) => (s._tag === "Open" ? { ...s, disposition: "inbox" as const, way: null } : s),
    IncidentCameBack: (s) => (s._tag === "Open" ? { ...s, disposition: "inbox" as const, way: null } : s),
    FindingRecorded: (s, e) => (s._tag === "Open" ? { ...s, findings: [...s.findings, e.runId] } : s),
  },
}) {}
