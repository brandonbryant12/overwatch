import { commandSource } from "./command.ts";
import { datadogLogsSource, datadogMetricsSource, datadogMonitorsSource } from "./datadog.ts";
import { githubCiSource } from "./github.ts";
import { kubernetesSource } from "./kubernetes.ts";
import type { SourceType } from "./types.ts";

export type { CollectResult, SourceContext, SourceType } from "./types.ts";

const registry = new Map<string, SourceType>(
  [kubernetesSource, datadogLogsSource, datadogMonitorsSource, datadogMetricsSource, githubCiSource, commandSource].map(
    (source) => [source.type, source],
  ),
);

/** Adds or replaces a source type. Built-ins use the same path. */
export function registerSourceType(source: SourceType): void {
  registry.set(source.type, source);
}

export function sourceType(type: string): SourceType | undefined {
  return registry.get(type);
}

export function sourceTypes(): string[] {
  return [...registry.keys()];
}
