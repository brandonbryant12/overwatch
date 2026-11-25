import type { OverwatchConfig } from "@overwatch/domain";
import type * as Effect from "effect/Effect";
import type { EventHub } from "./event-hub.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

export type RunEffect = <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>;

/** Everything a daemon module needs. Built once in `startOverwatchDaemon` and passed down. */
export interface DaemonContext {
  readonly config: OverwatchConfig;
  readonly mode: "live" | "demo";
  readonly serviceUrl: string;
  /** Parent directory for per-run git worktrees. */
  readonly worktreeRoot: string;
  readonly telemetry: TelemetryStore;
  readonly events: EventHub;
  readonly runEffect: RunEffect;
  readonly now: () => number;
}

export function splitEnvKey(envKey: string): { appId: string; envId: string } | undefined {
  const idx = envKey.indexOf(":");
  if (idx <= 0 || idx === envKey.length - 1) return undefined;
  return { appId: envKey.slice(0, idx), envId: envKey.slice(idx + 1) };
}

export function findEnvironmentConfig(config: OverwatchConfig, envKey: string) {
  const parts = splitEnvKey(envKey);
  if (!parts) return undefined;
  const app = config.apps.find((a) => a.id === parts.appId);
  const env = app?.environments[parts.envId];
  return app && env ? { app, env, ...parts } : undefined;
}

/** GitHub repository for an app, or undefined when the app has none configured. */
export function repoForApp(config: OverwatchConfig, appId: string): string | undefined {
  return config.apps.find((a) => a.id === appId)?.githubRepo;
}
