import type { DatadogEnvConfigSchema } from "@overwatch/domain";
import type * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { redactText, redactValue } from "./redactor.ts";
import { SecretVault } from "./secrets.ts";
import type {
  ConnectorProbeResult,
  RouteCohort,
  SpanDiffRow,
  TraceDiffPayload,
} from "./types.ts";

export type DatadogEnvConfig = typeof DatadogEnvConfigSchema.Type;

export interface RawSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly operation: string;
  readonly resource: string;
  readonly durationMs: number;
  readonly tags: Readonly<Record<string, string>>;
}

/**
 * Deterministic structural span-tree diffing between paired slow (p95-p99) and median (p50) traces.
 * Computes self-time deltas, N+1 child-span fan-out counts, and tag skew in a compact ~2 KB payload.
 */
export function diffTraceTrees(input: {
  readonly route: string;
  readonly releaseVersion: string;
  readonly slowTraces: ReadonlyArray<{ readonly traceId: string; readonly spans: ReadonlyArray<RawSpan> }>;
  readonly medianTraces: ReadonlyArray<{ readonly traceId: string; readonly spans: ReadonlyArray<RawSpan> }>;
}): TraceDiffPayload {
  const slowCount = Math.max(1, input.slowTraces.length);
  const medCount = Math.max(1, input.medianTraces.length);

  type Bucket = {
    operation: string;
    resource: string;
    slowDurationTotal: number;
    slowCalls: number;
    medDurationTotal: number;
    medCalls: number;
    slowPodTags: Map<string, number>;
  };

  const buckets = new Map<string, Bucket>();
  const ensure = (op: string, res: string): Bucket => {
    const key = `${op}::${res}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        operation: op,
        resource: res,
        slowDurationTotal: 0,
        slowCalls: 0,
        medDurationTotal: 0,
        medCalls: 0,
        slowPodTags: new Map(),
      };
      buckets.set(key, b);
    }
    return b;
  };

  let slowTotal = 0;
  for (const t of input.slowTraces) {
    for (const sp of t.spans) {
      slowTotal += sp.durationMs;
      const b = ensure(sp.operation, redactText(sp.resource, { maxBytes: 180 }));
      b.slowDurationTotal += sp.durationMs;
      b.slowCalls += 1;
      const pod = sp.tags.pod_name ?? sp.tags.revision;
      if (pod) b.slowPodTags.set(pod, (b.slowPodTags.get(pod) ?? 0) + 1);
    }
  }

  let medTotal = 0;
  for (const t of input.medianTraces) {
    for (const sp of t.spans) {
      medTotal += sp.durationMs;
      const b = ensure(sp.operation, redactText(sp.resource, { maxBytes: 180 }));
      b.medDurationTotal += sp.durationMs;
      b.medCalls += 1;
    }
  }

  const spans: SpanDiffRow[] = [...buckets.values()]
    .map((b) => {
      const slowAvgMs = Math.round(b.slowDurationTotal / slowCount);
      const medianAvgMs = Math.round(b.medDurationTotal / medCount);
      const slowCallCount = Math.round((b.slowCalls / slowCount) * 10) / 10;
      const medianCallCount = Math.round((b.medCalls / medCount) * 10) / 10;
      const nPlusOneSuspect =
        slowCallCount >= 5 && slowCallCount >= Math.max(1, medianCallCount) * 3;
      const topTag = [...b.slowPodTags.entries()].sort((a, z) => z[1] - a[1])[0];
      return {
        operation: b.operation,
        resource: b.resource,
        slowAvgMs,
        medianAvgMs,
        deltaMs: slowAvgMs - medianAvgMs,
        slowCallCount,
        medianCallCount,
        nPlusOneSuspect,
        tagSkew: topTag ? `${topTag[0]} (${topTag[1]}x)` : undefined,
      };
    })
    .sort((a, b) => b.deltaMs - a.deltaMs)
    .slice(0, 12);

  return redactValue({
    route: input.route,
    releaseVersion: input.releaseVersion,
    slowTraceIds: input.slowTraces.map((t) => t.traceId),
    medianTraceIds: input.medianTraces.map((t) => t.traceId),
    slowTotalMs: Math.round(slowTotal / slowCount),
    medianTotalMs: Math.round(medTotal / medCount),
    spans,
  });
}

export function probeDatadog(
  config: DatadogEnvConfig,
): Effect.Effect<ConnectorProbeResult, never, SecretVault> {
  return Effect.gen(function* () {
    const vault = yield* SecretVault;
    const now = Date.now();
    const apiKeyEither = yield* Effect.result(vault.resolve(config.apiKey));
    const appKeyEither = yield* Effect.result(vault.resolve(config.appKey));
    if (apiKeyEither._tag === "Failure" || appKeyEither._tag === "Failure") {
      return {
        connector: "datadog" as const,
        coverage: "auth_expired" as const,
        detail: "Datadog SecretRef unavailable in Keychain/env",
        remediation: `Store secrets for ${config.apiKey} and ${config.appKey}.`,
        checkedAtMs: now,
      };
    }

    const res = yield* Effect.tryPromise({
      try: async () => {
        const resp = await fetch(`https://api.${config.site}/api/v1/validate`, {
          headers: {
            "DD-API-KEY": Redacted.value(apiKeyEither.success),
            "DD-APPLICATION-KEY": Redacted.value(appKeyEither.success),
          },
          signal: AbortSignal.timeout(8_000),
        });
        return resp.status;
      },
      catch: () => -1,
    }).pipe(Effect.catch(() => Effect.succeed(-1)));

    if (res === 200) {
      return {
        connector: "datadog" as const,
        coverage: "healthy" as const,
        detail: `Connected to ${config.site} (service:${config.service}, env:${config.env})`,
        checkedAtMs: now,
      };
    }
    if (res === 401 || res === 403) {
      return {
        connector: "datadog" as const,
        coverage: "auth_expired" as const,
        detail: `Datadog API returned HTTP ${res}`,
        remediation: "Rotate Datadog API/App keys in macOS Keychain.",
        checkedAtMs: now,
      };
    }
    if (res === 429) {
      return {
        connector: "datadog" as const,
        coverage: "rate_limited" as const,
        detail: "Datadog API rate-limited (HTTP 429)",
        checkedAtMs: now,
      };
    }
    return {
      connector: "datadog" as const,
      coverage: "unreachable" as const,
      detail: `Could not reach api.${config.site}`,
      remediation: "Verify network / VPN access to Datadog API.",
      checkedAtMs: now,
    };
  });
}

export function buildDatadogDeepLink(
  config: DatadogEnvConfig,
  kind: "logs" | "apm" | "trace",
  queryOrTraceId: string,
): string {
  const base = `https://app.${config.site}`;
  if (kind === "trace") {
    return `${base}/apm/trace/${encodeURIComponent(queryOrTraceId)}`;
  }
  if (kind === "apm") {
    return `${base}/apm/service/${encodeURIComponent(config.service)}?env=${encodeURIComponent(config.env)}`;
  }
  return `${base}/logs?query=${encodeURIComponent(`service:${config.service} env:${config.env} ${queryOrTraceId}`)}`;
}

export function scoreExplorationCandidate(input: {
  readonly cohort: RouteCohort;
  readonly hoursSinceLastExplored: number;
  readonly recentDeploy: boolean;
}): number {
  const staleness = Math.min(72, Math.max(1, input.hoursSinceLastExplored));
  const trafficWeight = Math.log10(Math.max(10, input.cohort.rpm));
  const p95ToP50 = input.cohort.p95Ms / Math.max(1, input.cohort.p50Ms);
  const deployBoost = input.recentDeploy ? 1.8 : 1.0;
  return Number((staleness * trafficWeight * p95ToP50 * deployBoost).toFixed(2));
}
