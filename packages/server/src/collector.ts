import {
  collectDatadogMetrics,
  collectJenkinsBuilds,
  collectKubernetes,
  LocalSecretVaultLive,
  type ConnectorProbeResult,
  type EnvironmentTelemetrySnapshot,
  type MetricPoint,
  type PodSnapshot,
} from "@overwatch/connectors";
import type { ConnectorCoverage } from "@overwatch/domain";
import * as Effect from "effect/Effect";
import { findEnvironmentConfig, type DaemonContext } from "./context.ts";
import type { DemoSimulator } from "./demo-simulator.ts";

export interface CollectionResult {
  readonly snapshot: EnvironmentTelemetrySnapshot;
  /** Whether this collection produced a new metric sample. Detection only runs on fresh samples. */
  readonly fresh: boolean;
  /** Metrics the fresh sample actually measured. A rule on any other metric gets no verdict. */
  readonly measuredMetrics: ReadonlySet<string>;
}

const COVERAGE_SEVERITY: Record<ConnectorCoverage, number> = {
  healthy: 0,
  unconfigured: 0,
  rate_limited: 1,
  unreachable: 2,
  auth_expired: 3,
};

/** The least healthy connector decides the environment's coverage. */
export function worstCoverage(probes: ReadonlyArray<Pick<ConnectorProbeResult, "coverage">>): ConnectorCoverage {
  if (probes.length > 0 && probes.every((p) => p.coverage === "unconfigured")) return "unconfigured";
  let worst: ConnectorCoverage = "healthy";
  for (const probe of probes) {
    if (COVERAGE_SEVERITY[probe.coverage] > COVERAGE_SEVERITY[worst]) worst = probe.coverage;
  }
  return worst;
}

/** Fleet CPU and memory as a percentage of limits, or undefined when no pod reports a limit. */
export function podUtilization(
  pods: ReadonlyArray<PodSnapshot>,
): { readonly cpuPct: number; readonly memoryPct: number } | undefined {
  const cpuLimit = pods.reduce((sum, p) => sum + p.cpuLimitMillicores, 0);
  const memLimit = pods.reduce((sum, p) => sum + p.memoryLimitMiB, 0);
  if (pods.length === 0 || cpuLimit <= 0 || memLimit <= 0) return undefined;
  const cpu = pods.reduce((sum, p) => sum + p.cpuMillicores, 0);
  const mem = pods.reduce((sum, p) => sum + p.memoryMiB, 0);
  return {
    cpuPct: Math.min(100, Math.round((cpu / cpuLimit) * 100)),
    memoryPct: Math.min(100, Math.round((mem / memLimit) * 100)),
  };
}

const unconfigured = (connector: ConnectorProbeResult["connector"], nowMs: number): ConnectorProbeResult => ({
  connector,
  coverage: "unconfigured",
  detail: "Not configured",
  checkedAtMs: nowMs,
});

async function collectLive(ctx: DaemonContext, envKey: string): Promise<CollectionResult | undefined> {
  const found = findEnvironmentConfig(ctx.config, envKey);
  if (!found) return undefined;
  const { env, appId, envId } = found;
  const nowMs = ctx.now();

  const [k8s, datadog, jenkins] = await Promise.all([
    env.kubernetes
      ? collectKubernetes(env.kubernetes)
      : Promise.resolve({ probe: unconfigured("kubernetes", nowMs), pods: [], warningEvents: [] }),
    env.datadog
      ? Effect.runPromise(
          collectDatadogMetrics(env.datadog, { nowMs }).pipe(Effect.provide(LocalSecretVaultLive)),
        )
      : Promise.resolve(undefined),
    env.jenkins
      ? Effect.runPromise(collectJenkinsBuilds(env.jenkins).pipe(Effect.provide(LocalSecretVaultLive)))
      : Promise.resolve({ probe: unconfigured("jenkins", nowMs), builds: [] }),
  ]);

  const datadogProbe: ConnectorProbeResult = !env.datadog
    ? unconfigured("datadog", nowMs)
    : datadog?.ok
      ? {
          connector: "datadog",
          coverage: "healthy",
          detail: `Datadog service:${env.datadog.service} env:${env.datadog.env}`,
          checkedAtMs: nowMs,
        }
      : {
          connector: "datadog",
          coverage: datadog?.coverage ?? "unreachable",
          detail: datadog?.detail ?? "Datadog query failed",
          checkedAtMs: nowMs,
        };

  const probes = [k8s.probe, datadogProbe, jenkins.probe];
  const history = ctx.telemetry.getMetricSeries(envKey, 59);
  const utilization = podUtilization(k8s.pods);
  const measured = new Set<string>();
  let point: MetricPoint | undefined;

  // A sample is only written when Datadog measured latency. Fields nothing measured carry the
  // previous value for chart continuity and are left out of `measuredMetrics`, so no rule is ever
  // judged against a number that was not observed in this collection.
  if (datadog?.ok) {
    const previous = history[history.length - 1];
    point = {
      tsMs: nowMs,
      p50LatencyMs: datadog.metrics.p50LatencyMs,
      p95LatencyMs: datadog.metrics.p95LatencyMs,
      errorRatePct: datadog.metrics.errorRatePct,
      rps: datadog.metrics.rps,
      cpuPct: utilization?.cpuPct ?? previous?.cpuPct ?? 0,
      memoryPct: utilization?.memoryPct ?? previous?.memoryPct ?? 0,
    };
    for (const m of ["p50_latency_ms", "p95_latency_ms", "error_rate_pct", "rps"]) measured.add(m);
    if (utilization) {
      measured.add("cpu_pct");
      measured.add("memory_pct");
    }
  }
  if (k8s.probe.coverage === "healthy") measured.add("pod_restarts");
  if (jenkins.probe.coverage === "healthy") measured.add("build_failure");

  const snapshot: EnvironmentTelemetrySnapshot = {
    envKey,
    appId,
    envId,
    coverage: worstCoverage(probes),
    coverageDetail: probes
      .filter((p) => p.coverage !== "unconfigured")
      .map((p) => p.detail)
      .join(" · ") || "No connectors configured",
    remediation: probes.find((p) => p.remediation)?.remediation,
    pods: k8s.pods,
    warningEvents: k8s.warningEvents,
    builds: jenkins.builds,
    metrics: point ? [...history, point] : history,
    routeCohorts: ctx.telemetry.getEnvironmentSnapshot(envKey)?.routeCohorts ?? [],
    sampledAtMs: nowMs,
  };
  ctx.telemetry.saveEnvironmentSnapshot(snapshot);
  return { snapshot, fresh: point !== undefined || measured.size > 0, measuredMetrics: measured };
}

const DEMO_MEASURED = new Set(["p50_latency_ms", "p95_latency_ms", "error_rate_pct", "cpu_pct", "memory_pct", "rps"]);

function collectDemo(
  ctx: DaemonContext,
  simulator: DemoSimulator,
  envKey: string,
): CollectionResult | undefined {
  const existing = ctx.telemetry.getEnvironmentSnapshot(envKey);
  if (!existing) return undefined;

  // Degraded coverage means no new data arrived. The snapshot keeps its old sample time so the
  // dashboard shows how stale it is.
  if (existing.coverage !== "healthy") {
    return { snapshot: existing, fresh: false, measuredMetrics: new Set() };
  }

  simulator.prime(envKey, existing.metrics);
  const nowMs = ctx.now();
  const point = simulator.next(envKey, nowMs);
  if (!point) return { snapshot: existing, fresh: false, measuredMetrics: new Set() };

  const snapshot: EnvironmentTelemetrySnapshot = {
    ...existing,
    metrics: [...existing.metrics.slice(-59), point],
    sampledAtMs: nowMs,
  };
  ctx.telemetry.saveEnvironmentSnapshot(snapshot);
  return { snapshot, fresh: true, measuredMetrics: DEMO_MEASURED };
}

export function makeCollector(ctx: DaemonContext, simulator: DemoSimulator) {
  return (envKey: string): Promise<CollectionResult | undefined> =>
    ctx.mode === "live" ? collectLive(ctx, envKey) : Promise.resolve(collectDemo(ctx, simulator, envKey));
}
