import type { Exec } from "../exec.ts";
import type { AppConfig, EnvironmentConfig, Options, SourceConfig } from "../options.ts";
import type { Sample, Signal } from "../signals.ts";
import type { TimeWindow } from "../window.ts";

export interface SourceContext {
  /** Source name in the environment config. */
  readonly name: string;
  readonly app: AppConfig;
  readonly environment: string;
  readonly env: EnvironmentConfig;
  readonly options: Options;
  readonly exec: Exec;
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
  /**
   * When this collection must be finished, as `Date.now()` milliseconds. A source that fans out stops starting new
   * calls before it and reports what it left unread, rather than being cut off with nothing to show.
   */
  readonly deadline: number;
  /** Scratch space shared by every slice of one run of this source, so a long catch-up does not repeat calls. */
  readonly scratch: Map<string, unknown>;
  /** Waits; a fake in tests so retries do not slow them down. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface CollectResult {
  readonly signals: ReadonlyArray<Signal>;
  readonly samples: ReadonlyArray<Sample>;
  /** Things the report should mention, such as a capped page count. */
  readonly notes: ReadonlyArray<string>;
  /** Commits or refs of what is running, when the source can tell. */
  readonly revisions?: ReadonlyArray<string>;
  /** Short capacity summary for investigations (limits, quota, node allocatable). */
  readonly capacity?: string;
}

export interface QueryInput {
  readonly since: number;
  readonly until: number;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * A kind of telemetry. Sources are open to extension: add a type to the registry, or use the `command` type to
 * plug in any program that prints signals and metrics as JSON lines.
 */
export interface SourceType {
  readonly type: string;
  /** What `overwatch_query` accepts for this type, shown to agents. */
  readonly queryHelp: string;
  readonly validate: (config: SourceConfig, options: Options) => ReadonlyArray<string>;
  /** Collects one window. `final` is the most recent slice of a run, where current state is read. */
  readonly collect: (
    config: SourceConfig,
    input: { readonly window: TimeWindow; readonly final: boolean },
    context: SourceContext,
  ) => Promise<CollectResult>;
  /** Read-only lookup for agents. Returns redacted text. */
  readonly query: (config: SourceConfig, input: QueryInput, context: SourceContext) => Promise<string>;
}

export const emptyResult: CollectResult = { signals: [], samples: [], notes: [] };

export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
