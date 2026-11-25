/**
 * What `/status` answers: one definition, which the service encodes with and the page decodes with.
 */
import * as Schema from "effect/Schema";

export const WatcherStatus = Schema.Struct({
  watcher: Schema.String,
  next_at: Schema.Number,
  last_started: Schema.NullOr(Schema.Number),
  last_finished: Schema.NullOr(Schema.Number),
  last_error: Schema.NullOr(Schema.String),
  last_summary: Schema.NullOr(Schema.String),
});
export type WatcherStatus = typeof WatcherStatus.Type;

export const Checkpoint = Schema.Struct({ watcher: Schema.String, source: Schema.String, at: Schema.Number });

export const ServiceStatus = Schema.Struct({
  name: Schema.Literal("overwatch"),
  version: Schema.String,
  apiVersion: Schema.Number,
  configErrors: Schema.Array(Schema.String),
  opencode: Schema.Struct({
    connected: Schema.Boolean,
    url: Schema.NullOr(Schema.String),
    checkedAt: Schema.Number,
    waitingRuns: Schema.Number,
    runningRuns: Schema.Number,
  }),
  watchers: Schema.Array(WatcherStatus),
  checkpoints: Schema.Array(Checkpoint),
});
export type ServiceStatus = typeof ServiceStatus.Type;
