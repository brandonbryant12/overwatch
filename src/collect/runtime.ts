import type { Exec } from "./exec.ts";
import type { Options } from "./options.ts";
import { sourceType, type SourceContext } from "./sources/index.ts";

/** Everything a watcher run or an investigation touches outside itself. Swapped for fakes in tests. */
export interface Runtime {
  readonly options: Options;
  readonly exec: Exec;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly log: (message: string) => void;
  /** Waits between retries. Defaults to a real timer. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Resolves after `ms`, or as soon as the signal aborts. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

export function sourceContext(
  runtime: Runtime,
  appName: string,
  environment: string,
  source: string,
  signal: AbortSignal,
  run: { readonly deadline?: number; readonly scratch?: Map<string, unknown> } = {},
): SourceContext {
  const app = runtime.options.apps[appName];
  const env = app?.environments[environment];
  if (!app || !env) throw new Error(`Unknown app or environment: ${appName}/${environment}`);
  return {
    name: source,
    app,
    environment,
    env,
    options: runtime.options,
    exec: runtime.exec,
    fetch: runtime.fetch,
    signal,
    deadline: run.deadline ?? Date.now() + runtime.options.timeouts.sliceMs,
    scratch: run.scratch ?? new Map(),
    sleep: runtime.sleep ?? sleep,
  };
}

/** Checks every configured source against its type. */
export function validateSources(options: Options): string[] {
  const errors: string[] = [];
  for (const app of Object.values(options.apps)) {
    for (const [envName, env] of Object.entries(app.environments)) {
      for (const [name, config] of Object.entries(env.sources)) {
        const type = sourceType(config.type);
        if (!type) {
          errors.push(`apps.${app.name}.environments.${envName}.sources.${name}: unknown type "${config.type}"`);
          continue;
        }
        errors.push(...type.validate(config, options).map((e) => `apps.${app.name}.environments.${envName}.sources.${name}: ${e}`));
      }
    }
  }
  return errors;
}
