import type { Exec } from "./exec.ts";
import type { Options } from "./options.ts";
import { sourceType, type SourceContext } from "./sources/index.ts";
import type { KV } from "./store.ts";

/** Everything a watcher run or an investigation touches outside itself. Swapped for fakes in tests. */
export interface Runtime {
  readonly kv: KV;
  readonly options: Options;
  readonly exec: Exec;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export function sourceContext(
  runtime: Runtime,
  appName: string,
  environment: string,
  source: string,
  signal: AbortSignal,
): SourceContext {
  const app = runtime.options.apps[appName];
  const env = app?.environments[environment];
  if (!app || !env) throw new Error(`Unknown app or environment: ${appName}/${environment}`);
  return { name: source, app, environment, env, options: runtime.options, exec: runtime.exec, fetch: runtime.fetch, signal };
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
