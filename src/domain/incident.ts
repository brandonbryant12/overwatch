/**
 * Incident: one problem in one app and environment, from its first signal on. Phase 1A records the signal, quiet
 * recurrences, findings, and archive. Archive is a disposition, not a state of the problem: more of the same signal
 * updates an archived incident without bringing it back.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
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

export class IncidentOpened extends Domain.Event("IncidentOpened", { ...SignalFields, firstAt: Schema.Number }) {}
export class SignalRecurred extends Domain.Event("SignalRecurred", {
  at: Schema.Number,
  count: Schema.Number,
  occurrences: Schema.Number,
  sample: Schema.optionalKey(Schema.String),
}) {}
export class IncidentArchived extends Domain.Event("IncidentArchived", { reason: Schema.String, at: Schema.Number }) {}
export class FindingRecorded extends Domain.Event("FindingRecorded", {
  runId: RunId,
  threadId: ThreadId,
  sessionId: Schema.String,
  finding: Finding,
  at: Schema.Number,
}) {}

/** A signal from a watcher. Opens the incident, or counts quietly against the open one. */
export class ReportSignal extends Domain.Command("ReportSignal", {
  target: IncidentId,
  input: SignalFields,
  events: [IncidentOpened, SignalRecurred],
}, { description: "Record a signal a watcher found." }) {}

export class ArchiveIncident extends Domain.Command("ArchiveIncident", {
  target: IncidentId,
  input: { reason: Schema.optionalKey(Schema.String) },
  events: [IncidentArchived],
  rejects: [NotOpened],
}, { description: "Archive an incident: it leaves the inbox and more of the same signal does not bring it back." }) {}

export class RecordFinding extends Domain.Command("RecordFinding", {
  target: IncidentId,
  input: { runId: RunId, threadId: ThreadId, sessionId: Schema.String, finding: Finding },
  events: [FindingRecorded],
  rejects: [NotOpened],
}, { description: "Record a finding whose citations were checked." }) {}

export const IncidentState = Schema.Union([
  Schema.TaggedStruct("Unopened", {}),
  Schema.TaggedStruct("Open", {
    app: Schema.String,
    environment: Schema.String,
    fingerprint: Schema.String,
    title: Schema.String,
    occurrences: Schema.Number,
    lastAt: Schema.Number,
    disposition: Schema.Literals(["inbox", "archived"]),
    findings: Schema.Array(RunId),
  }),
]);
export type IncidentState = typeof IncidentState.Type;


export class Incident extends Domain.Aggregate("Incident", {
  id: IncidentId,
  state: IncidentState,
  initial: { _tag: "Unopened" as const },
  commands: [ReportSignal, ArchiveIncident, RecordFinding],
  decide: {
    ReportSignal: (s, cmd) =>
      s._tag === "Unopened"
        ? [new IncidentOpened({ ...fieldsOf(cmd), firstAt: cmd.firstAt ?? cmd.at })]
        : [
            new SignalRecurred({
              at: Math.max(s.lastAt, cmd.at),
              count: cmd.count,
              occurrences: s.occurrences + cmd.count,
              ...(cmd.sample === undefined ? {} : { sample: cmd.sample }),
            }),
          ],
    ArchiveIncident: (s, cmd, ctx) => {
      if (s._tag === "Unopened") return new NotOpened();
      if (s.disposition === "archived") return [];
      return [new IncidentArchived({ reason: cmd.reason ?? "archived by the owner", at: nowMs(ctx) })];
    },
    RecordFinding: (s, cmd, ctx) => {
      if (s._tag === "Unopened") return new NotOpened();
      if (s.findings.includes(cmd.runId)) return [];
      return [new FindingRecorded({ ...fieldsOf(cmd), at: nowMs(ctx) })];
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
    }),
    SignalRecurred: (s, e) => (s._tag === "Open" ? { ...s, occurrences: e.occurrences, lastAt: e.at } : s),
    IncidentArchived: (s) => (s._tag === "Open" ? { ...s, disposition: "archived" as const } : s),
    FindingRecorded: (s, e) => (s._tag === "Open" ? { ...s, findings: [...s.findings, e.runId] } : s),
  },
}) {}
