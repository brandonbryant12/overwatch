/**
 * Watcher: one app environment's sources, polled on a schedule. Polling bookkeeping (checkpoints, covered windows,
 * de-duplication state) lives in plain tables, because a poll that finds nothing is not an event. What a watcher
 * records here is what happened: it was set up or changed, and a stretch of time went unchecked.
 */
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { WatcherId } from "./ids.ts";
import { redactText } from "./redact.ts";
import { fieldsOf, nowMs } from "./time.ts";

export class WatcherConfigured extends Domain.Event("WatcherConfigured", {
  app: Schema.String,
  environment: Schema.String,
  sources: Schema.Array(Schema.String),
  everyMs: Schema.Number,
  at: Schema.Number,
}) {}
/** A window that was not checked: the lookback cap cut a catch-up short, or a source failed for it. */
export class CoverageGapRecorded extends Domain.Event("CoverageGapRecorded", {
  source: Schema.String,
  from: Schema.Number,
  to: Schema.Number,
  reason: Schema.String,
}) {}

/** What a source says is running changed: a deploy. Brings back incidents in its environment deferred until a change. */
export class DeployObserved extends Domain.Event("DeployObserved", {
  source: Schema.String,
  revisions: Schema.Array(Schema.String),
  previous: Schema.Array(Schema.String),
  at: Schema.Number,
}) {}
/** A source stopped being read: its connection kept failing (plan 4.1). One inbox item says how to fix it. */
export class SourceSuspended extends Domain.Event("SourceSuspended", {
  source: Schema.String,
  connection: Schema.String,
  kind: Schema.String,
  reason: Schema.String,
  fix: Schema.String,
  at: Schema.Number,
}) {}
/** A suspended source was read again: it catches up from its checkpoint. */
export class SourceResumed extends Domain.Event("SourceResumed", { source: Schema.String, connection: Schema.String, at: Schema.Number }) {}

export class ConfigureWatcher extends Domain.Command("ConfigureWatcher", {
  target: WatcherId,
  input: { app: Schema.String, environment: Schema.String, sources: Schema.Array(Schema.String), everyMs: Schema.Number },
  events: [WatcherConfigured],
}) {}
export class RecordGap extends Domain.Command("RecordGap", {
  target: WatcherId,
  input: { source: Schema.String, from: Schema.Number, to: Schema.Number, reason: Schema.String },
  events: [CoverageGapRecorded],
}) {}

export class RecordDeploy extends Domain.Command("RecordDeploy", {
  target: WatcherId,
  input: { source: Schema.String, revisions: Schema.Array(Schema.String), previous: Schema.Array(Schema.String), at: Schema.Number },
  events: [DeployObserved],
}) {}
export class NoteSuspended extends Domain.Command("NoteSuspended", {
  target: WatcherId,
  input: { source: Schema.String, connection: Schema.String, kind: Schema.String, reason: Schema.String, fix: Schema.String, at: Schema.Number },
  events: [SourceSuspended],
}) {}
export class NoteResumed extends Domain.Command("NoteResumed", {
  target: WatcherId,
  input: { source: Schema.String, connection: Schema.String, at: Schema.Number },
  events: [SourceResumed],
}) {}

export class Watcher extends Domain.Aggregate("Watcher", {
  id: WatcherId,
  state: Schema.Struct({ config: Schema.NullOr(Schema.String), gaps: Schema.Number }),
  initial: { config: null, gaps: 0 },
  commands: [ConfigureWatcher, RecordGap, RecordDeploy, NoteSuspended, NoteResumed],
  decide: {
    ConfigureWatcher: (s, cmd, ctx) => {
      const config = JSON.stringify([cmd.app, cmd.environment, [...cmd.sources].sort(), cmd.everyMs]);
      return s.config === config ? [] : [new WatcherConfigured({ ...fieldsOf(cmd), at: nowMs(ctx) })];
    },
    RecordGap: (_s, cmd) => [new CoverageGapRecorded({ ...fieldsOf(cmd), reason: redactText(cmd.reason, { maxBytes: 500 }) })],
    RecordDeploy: (_s, cmd) => [new DeployObserved({ ...fieldsOf(cmd), revisions: cmd.revisions.map((r) => redactText(r, { maxBytes: 200 })), previous: cmd.previous.map((r) => redactText(r, { maxBytes: 200 })) })],
    NoteSuspended: (_s, cmd) => [new SourceSuspended({ ...fieldsOf(cmd), reason: redactText(cmd.reason, { maxBytes: 500 }), fix: redactText(cmd.fix, { maxBytes: 500 }) })],
    NoteResumed: (_s, cmd) => [new SourceResumed(fieldsOf(cmd))],
  },
  evolve: {
    WatcherConfigured: (s, e) => ({ ...s, config: JSON.stringify([e.app, e.environment, [...e.sources].sort(), e.everyMs]) }),
    CoverageGapRecorded: (s) => ({ ...s, gaps: s.gaps + 1 }),
    DeployObserved: (s) => s,
    SourceSuspended: (s) => s,
    SourceResumed: (s) => s,
  },
}) {}
