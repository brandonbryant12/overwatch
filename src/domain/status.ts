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

/** A measured value and what its rule made of it: breach, clear, pending, no_data, measured, or unknown (not sampled by the last check). */
export const MetricReading = Schema.Struct({
  value: Schema.NullOr(Schema.Number),
  limit: Schema.NullOr(Schema.Number),
  state: Schema.String,
  sampledAt: Schema.NullOr(Schema.Number),
});
export type MetricReading = typeof MetricReading.Type;

/** One app environment as the fleet strip shows it: facts only; the page decides how it reads. */
export const EnvironmentStatus = Schema.Struct({
  app: Schema.String,
  environment: Schema.String,
  tier: Schema.Literals(["production", "staging", "development"]),
  everyMs: Schema.Number,
  /** The oldest of its sources' checkpoints: until when every source has been read. Null until all have been. */
  checkedThrough: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String),
  notReadyPods: Schema.NullOr(MetricReading),
  memoryPctOfLimit: Schema.NullOr(MetricReading),
});
export type EnvironmentStatus = typeof EnvironmentStatus.Type;

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
  environments: Schema.Array(EnvironmentStatus),
  /** The service's clock when it answered, so ages are measured against it. */
  at: Schema.Number,
});
export type ServiceStatus = typeof ServiceStatus.Type;
