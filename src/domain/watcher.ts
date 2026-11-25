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

export class Watcher extends Domain.Aggregate("Watcher", {
  id: WatcherId,
  state: Schema.Struct({ config: Schema.NullOr(Schema.String), gaps: Schema.Number }),
  initial: { config: null, gaps: 0 },
  commands: [ConfigureWatcher, RecordGap],
  decide: {
    ConfigureWatcher: (s, cmd, ctx) => {
      const config = JSON.stringify([cmd.app, cmd.environment, [...cmd.sources].sort(), cmd.everyMs]);
      return s.config === config ? [] : [new WatcherConfigured({ ...fieldsOf(cmd), at: nowMs(ctx) })];
    },
    RecordGap: (_s, cmd) => [new CoverageGapRecorded({ ...fieldsOf(cmd), reason: redactText(cmd.reason, { maxBytes: 500 }) })],
  },
  evolve: {
    WatcherConfigured: (s, e) => ({ ...s, config: JSON.stringify([e.app, e.environment, [...e.sources].sort(), e.everyMs]) }),
    CoverageGapRecorded: (s) => ({ ...s, gaps: s.gaps + 1 }),
  },
}) {}
