/**
 * Rows read back from Overwatch's own tables, decoded with a schema where a wrong shape would change what Overwatch
 * says: a `code_deployed` that is not 0 or 1, a metric state nobody wrote, a timestamp stored as text. A row that does
 * not fit is an error naming the table and what was wrong, never a value quietly read as something else.
 */
import * as Schema from "effect/Schema";
import { MetricState } from "../domain/status.ts";

export function decodeRow<S extends Schema.Top>(table: string, schema: S): (row: unknown) => S["Type"] {
  const decode = Schema.decodeUnknownSync(schema as never) as (row: unknown) => S["Type"];
  return (row) => {
    try {
      return decode(row === undefined || row === null ? row : { ...(row as object) });
    } catch (error) {
      throw new Error(`A row in ${table} does not have the shape Overwatch wrote: ${String((error as Error).message).slice(0, 400)}`);
    }
  };
}

const Flag = Schema.Literals([0, 1]);

export const CodeBasisRow = decodeRow(
  "run_tokens",
  Schema.Struct({ code_path: Schema.String, code_commit: Schema.NullOr(Schema.String), code_deployed: Flag, code_note: Schema.NullOr(Schema.String) }),
);
export const CodeRow = decodeRow(
  "run_tokens",
  Schema.Struct({ code_commit: Schema.NullOr(Schema.String), code_deployed: Schema.NullOr(Flag), code_note: Schema.NullOr(Schema.String) }),
);
export const MetricStateRow = decodeRow(
  "metric_state",
  Schema.Struct({ state: MetricState, observed: Schema.NullOr(Schema.Number), limit_value: Schema.NullOr(Schema.Number), sampled_at: Schema.NullOr(Schema.Number) }),
);
export const WatcherRunRow = decodeRow(
  "watcher_runs",
  Schema.Struct({
    watcher: Schema.String,
    next_at: Schema.Number,
    last_started: Schema.NullOr(Schema.Number),
    last_finished: Schema.NullOr(Schema.Number),
    last_error: Schema.NullOr(Schema.String),
    last_summary: Schema.NullOr(Schema.String),
  }),
);
export const CheckpointRow = decodeRow("checkpoints", Schema.Struct({ watcher: Schema.String, source: Schema.String, at: Schema.Number }));
export const CapacityRow = decodeRow("capacity", Schema.Struct({ source: Schema.String, text: Schema.String, at: Schema.Number }));
export const MetricPointRow = decodeRow("metric_points", Schema.Struct({ at: Schema.Number, value: Schema.NullOr(Schema.Number) }));
export const WindowCheckpointRow = decodeRow("checkpoints", Schema.Struct({ at: Schema.Number, seen: Schema.String }));
