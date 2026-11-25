import type { ConnectorCoverage, EvidenceId } from "@overwatch/domain";

export interface PodSnapshot {
  readonly name: string;
  readonly namespace: string;
  readonly revision: string;
  readonly track: "canary" | "new" | "stable";
  readonly imageTag: string;
  readonly ready: string; // e.g. "2/2"
  readonly phase: "Running" | "Pending" | "CrashLoopBackOff" | "Failed";
  readonly restarts: number;
  readonly lastTerminationReason?: string;
  readonly cpuMillicores: number;
  readonly cpuRequestMillicores: number;
  readonly cpuLimitMillicores: number;
  readonly memoryMiB: number;
  readonly memoryRequestMiB: number;
  readonly memoryLimitMiB: number;
  readonly nodeName: string;
  readonly sampledAtMs: number;
}

export interface K8sWarningEvent {
  readonly reason: string;
  readonly message: string;
  readonly objectName: string;
  readonly count: number;
  readonly lastTimestampMs: number;
}

export interface BuildRecord {
  readonly buildNumber: number;
  readonly jobPath: string;
  readonly result: "SUCCESS" | "FAILURE" | "UNSTABLE" | "IN_PROGRESS";
  readonly commitSha: string;
  readonly commitMessage: string;
  readonly author: string;
  readonly durationMs: number;
  readonly timestampMs: number;
  readonly url: string;
  readonly consoleTail?: string;
}

export interface MetricPoint {
  readonly tsMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly errorRatePct: number;
  readonly cpuPct: number;
  readonly memoryPct: number;
  readonly rps: number;
}

export interface RouteCohort {
  readonly route: string;
  readonly service: string;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly errorRatePct: number;
  readonly wowDeltaPct: number;
  readonly rpm: number;
}

export interface SpanDiffRow {
  readonly operation: string;
  readonly resource: string;
  readonly slowAvgMs: number;
  readonly medianAvgMs: number;
  readonly deltaMs: number;
  readonly slowCallCount: number;
  readonly medianCallCount: number;
  readonly nPlusOneSuspect: boolean;
  readonly tagSkew?: string;
}

export interface TraceDiffPayload {
  readonly route: string;
  readonly releaseVersion: string;
  readonly slowTraceIds: ReadonlyArray<string>;
  readonly medianTraceIds: ReadonlyArray<string>;
  readonly slowTotalMs: number;
  readonly medianTotalMs: number;
  readonly spans: ReadonlyArray<SpanDiffRow>;
}

export interface EvidenceBlob {
  readonly evidenceId: EvidenceId;
  readonly source: "kubernetes" | "datadog" | "jenkins" | "github" | "eval";
  readonly envKey: string;
  readonly title: string;
  readonly query: string;
  readonly deepLink: string;
  readonly capturedAtMs: number;
  readonly excerpt: string;
  readonly traceDiff?: TraceDiffPayload;
}

export interface ConnectorProbeResult {
  readonly connector: "kubernetes" | "datadog" | "jenkins" | "github";
  readonly coverage: ConnectorCoverage;
  readonly detail: string;
  readonly remediation?: string;
  readonly checkedAtMs: number;
}

export interface EnvironmentTelemetrySnapshot {
  readonly envKey: string;
  readonly appId: string;
  readonly envId: string;
  readonly coverage: ConnectorCoverage;
  readonly coverageDetail: string;
  readonly remediation?: string;
  readonly pods: ReadonlyArray<PodSnapshot>;
  readonly warningEvents: ReadonlyArray<K8sWarningEvent>;
  readonly builds: ReadonlyArray<BuildRecord>;
  readonly metrics: ReadonlyArray<MetricPoint>;
  readonly routeCohorts: ReadonlyArray<RouteCohort>;
  readonly sampledAtMs: number;
}
