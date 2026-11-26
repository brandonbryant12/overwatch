/**
 * The expected failures, as tagged errors: each is handled by its tag (`Effect.catchTag`), never by `instanceof` on
 * something thrown. A defect (a bug, or a SQL constraint broken) is not here: it dies.
 */
import { Schema } from "effect";

/** A request the API refuses, with the HTTP status it answers. */
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Number,
  message: Schema.String,
}) {}
export const apiError = (status: number, message: string) => new ApiError({ status, message });

/** The disk is short: nothing is admitted until there is room again. */
export class Full extends Schema.TaggedError<Full>()("Full", { message: Schema.String }) {}

/** Another process owns the database. */
export class Busy extends Schema.TaggedError<Busy>()("Busy", { message: Schema.String }) {}

/** A file that is not an Overwatch database or backup of this version. */
export class Incompatible extends Schema.TaggedError<Incompatible>()("Incompatible", { message: Schema.String }) {}

/** The configuration file is invalid. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", { message: Schema.String }) {}

/** A tool call the investigation tools refuse; its message goes back to the model. */
export class Refusal extends Schema.TaggedError<Refusal>()("Refusal", { message: Schema.String }) {}

/** OpenCode did not answer (down, unreachable, or a server error): work waits; nothing is failed for it. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", { message: Schema.String }) {}

/** A deadline on the service's monotonic clock passed before the work finished. */
export class Expired extends Schema.TaggedError<Expired>()("Expired", {}) {}

/** The command line's outcome when it is not success: its exit code, error kind and message. */
export class CliExit extends Schema.TaggedError<CliExit>()("CliExit", {
  code: Schema.Number,
  kind: Schema.String,
  message: Schema.String,
}) {}
export const cliExit = (code: number, kind: string, message: string) => new CliExit({ code, kind, message });

/** A backup that cannot be written (the target exists, or SQLite refused). */
export class BackupError extends Schema.TaggedError<BackupError>()("BackupError", { message: Schema.String }) {}
