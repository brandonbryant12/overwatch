import type { EvidenceId } from "@overwatch/domain";
import { diffTraceTrees } from "./datadog.ts";
import type {
  BuildRecord,
  EnvironmentTelemetrySnapshot,
  EvidenceBlob,
  MetricPoint,
  PodSnapshot,
  RouteCohort,
  TraceDiffPayload,
} from "./types.ts";

function buildSeries(
  nowMs: number,
  baseP50: number,
  baseP95: number,
  spikeLastN: number,
  spikeP95: number,
  baseErr: number,
  spikeErr: number,
  cpuBase: number,
  memBase: number,
): MetricPoint[] {
  const pts: MetricPoint[] = [];
  const total = 36;
  for (let i = 0; i < total; i++) {
    const tsMs = nowMs - (total - 1 - i) * 60_000;
    const wave = Math.sin(i * 0.55) * 0.08 + Math.cos(i * 0.27) * 0.04;
    const isSpike = spikeLastN > 0 && i >= total - spikeLastN;
    const ramp = isSpike ? (i - (total - spikeLastN) + 1) / spikeLastN : 0;
    const p50 = Math.round(baseP50 * (1 + wave) + (isSpike ? ramp * 120 : 0));
    const p95 = Math.round(
      (isSpike ? baseP95 + (spikeP95 - baseP95) * (0.65 + 0.35 * ramp) : baseP95) * (1 + wave),
    );
    const err = Number(
      Math.max(0.02, isSpike ? baseErr + (spikeErr - baseErr) * ramp : baseErr * (1 + wave)).toFixed(2),
    );
    const cpu = Math.min(96, Math.round(cpuBase * (1 + wave * 0.6) + (isSpike ? 18 * ramp : 0)));
    const mem = Math.min(94, Math.round(memBase * (1 + wave * 0.3) + (isSpike ? 7 * ramp : 0)));
    pts.push({
      tsMs,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      errorRatePct: err,
      cpuPct: cpu,
      memoryPct: mem,
      rps: Math.round(420 * (1 + wave)),
    });
  }
  return pts;
}

export function generateDemoTraceDiff(): TraceDiffPayload {
  return diffTraceTrees({
    route: "POST /v1/checkout/confirm",
    releaseVersion: "9f31c2a",
    slowTraces: [
      {
        traceId: "tr_slow_991a",
        spans: [
          {
            traceId: "tr_slow_991a",
            spanId: "sp_1",
            operation: "http.request",
            resource: "POST /v1/checkout/confirm",
            durationMs: 2180,
            tags: { pod_name: "checkout-api-9f31c2a-7b4d", revision: "rev-482" },
          },
          ...Array.from({ length: 47 }, (_, idx) => ({
            traceId: "tr_slow_991a",
            spanId: `sp_db_${idx}`,
            operation: "pg.query",
            resource: "SELECT * FROM cart_line_items WHERE cart_id = $1 AND promo_tier = $2",
            durationMs: 36,
            tags: { pod_name: "checkout-api-9f31c2a-7b4d", revision: "rev-482" },
          })),
          {
            traceId: "tr_slow_991a",
            spanId: "sp_stripe",
            operation: "http.client",
            resource: "POST https://api.stripe.com/v1/payment_intents",
            durationMs: 265,
            tags: { pod_name: "checkout-api-9f31c2a-7b4d" },
          },
        ],
      },
      {
        traceId: "tr_slow_992b",
        spans: [
          {
            traceId: "tr_slow_992b",
            spanId: "sp_1",
            operation: "http.request",
            resource: "POST /v1/checkout/confirm",
            durationMs: 2110,
            tags: { pod_name: "checkout-api-9f31c2a-9c2f", revision: "rev-482" },
          },
          ...Array.from({ length: 45 }, (_, idx) => ({
            traceId: "tr_slow_992b",
            spanId: `sp_db_${idx}`,
            operation: "pg.query",
            resource: "SELECT * FROM cart_line_items WHERE cart_id = $1 AND promo_tier = $2",
            durationMs: 35,
            tags: { pod_name: "checkout-api-9f31c2a-9c2f", revision: "rev-482" },
          })),
          {
            traceId: "tr_slow_992b",
            spanId: "sp_stripe",
            operation: "http.client",
            resource: "POST https://api.stripe.com/v1/payment_intents",
            durationMs: 252,
            tags: { pod_name: "checkout-api-9f31c2a-9c2f" },
          },
        ],
      },
    ],
    medianTraces: [
      {
        traceId: "tr_med_110c",
        spans: [
          {
            traceId: "tr_med_110c",
            spanId: "sp_1",
            operation: "http.request",
            resource: "POST /v1/checkout/confirm",
            durationMs: 410,
            tags: { pod_name: "checkout-api-4c88e1b-3a1e", revision: "rev-481" },
          },
          {
            traceId: "tr_med_110c",
            spanId: "sp_db_0",
            operation: "pg.query",
            resource: "SELECT * FROM cart_line_items WHERE cart_id = $1 AND promo_tier = $2",
            durationMs: 28,
            tags: { pod_name: "checkout-api-4c88e1b-3a1e", revision: "rev-481" },
          },
          {
            traceId: "tr_med_110c",
            spanId: "sp_db_1",
            operation: "pg.query",
            resource: "SELECT * FROM cart_line_items WHERE cart_id = $1 AND promo_tier = $2",
            durationMs: 24,
            tags: { pod_name: "checkout-api-4c88e1b-3a1e", revision: "rev-481" },
          },
          {
            traceId: "tr_med_110c",
            spanId: "sp_stripe",
            operation: "http.client",
            resource: "POST https://api.stripe.com/v1/payment_intents",
            durationMs: 258,
            tags: { pod_name: "checkout-api-4c88e1b-3a1e" },
          },
        ],
      },
    ],
  });
}

export function generateDemoFleetSnapshots(nowMs = Date.now()): {
  readonly snapshots: ReadonlyArray<EnvironmentTelemetrySnapshot>;
  readonly evidence: ReadonlyArray<EvidenceBlob>;
} {
  const traceDiff = generateDemoTraceDiff();

  const checkoutProdPods: PodSnapshot[] = [
    {
      name: "checkout-api-9f31c2a-7b4d",
      namespace: "checkout",
      revision: "rev-482",
      track: "new",
      imageTag: "9f31c2a",
      ready: "2/2",
      phase: "Running",
      restarts: 0,
      cpuMillicores: 840,
      cpuRequestMillicores: 500,
      cpuLimitMillicores: 1000,
      memoryMiB: 712,
      memoryRequestMiB: 512,
      memoryLimitMiB: 1024,
      nodeName: "ip-10-42-14-88.ec2.internal",
      sampledAtMs: nowMs,
    },
    {
      name: "checkout-api-9f31c2a-9c2f",
      namespace: "checkout",
      revision: "rev-482",
      track: "new",
      imageTag: "9f31c2a",
      ready: "2/2",
      phase: "Running",
      restarts: 1,
      lastTerminationReason: "OOMKilled",
      cpuMillicores: 875,
      cpuRequestMillicores: 500,
      cpuLimitMillicores: 1000,
      memoryMiB: 790,
      memoryRequestMiB: 512,
      memoryLimitMiB: 1024,
      nodeName: "ip-10-42-18-12.ec2.internal",
      sampledAtMs: nowMs,
    },
    {
      name: "checkout-api-4c88e1b-3a1e",
      namespace: "checkout",
      revision: "rev-481",
      track: "stable",
      imageTag: "4c88e1b",
      ready: "2/2",
      phase: "Running",
      restarts: 0,
      cpuMillicores: 410,
      cpuRequestMillicores: 500,
      cpuLimitMillicores: 1000,
      memoryMiB: 482,
      memoryRequestMiB: 512,
      memoryLimitMiB: 1024,
      nodeName: "ip-10-42-11-04.ec2.internal",
      sampledAtMs: nowMs,
    },
  ];

  const checkoutProdBuilds: BuildRecord[] = [
    {
      buildNumber: 482,
      jobPath: "job/payments/job/checkout-api/job/main",
      result: "SUCCESS",
      commitSha: "9f31c2a",
      commitMessage: "feat(promos): evaluate tiered bundle discounts per cart item",
      author: "m.patel",
      durationMs: 184_000,
      timestampMs: nowMs - 14 * 60_000,
      url: "https://jenkins.internal.example.com/job/payments/job/checkout-api/482",
    },
    {
      buildNumber: 481,
      jobPath: "job/payments/job/checkout-api/job/main",
      result: "SUCCESS",
      commitSha: "4c88e1b",
      commitMessage: "chore(metrics): emit replica revision label on checkout spans",
      author: "b.bryant",
      durationMs: 171_000,
      timestampMs: nowMs - 6 * 3600_000,
      url: "https://jenkins.internal.example.com/job/payments/job/checkout-api/481",
    },
  ];

  const checkoutRoutes: RouteCohort[] = [
    {
      route: "POST /v1/checkout/confirm",
      service: "checkout-api",
      p50Ms: 410,
      p95Ms: 2150,
      p99Ms: 3120,
      errorRatePct: 1.84,
      wowDeltaPct: 138,
      rpm: 1420,
    },
    {
      route: "GET /v1/cart/quote",
      service: "checkout-api",
      p50Ms: 92,
      p95Ms: 240,
      p99Ms: 410,
      errorRatePct: 0.08,
      wowDeltaPct: 4,
      rpm: 3890,
    },
  ];

  const billingProdPods: PodSnapshot[] = [
    {
      name: "billing-worker-6a12d9-f41c",
      namespace: "billing",
      revision: "rev-219",
      track: "stable",
      imageTag: "6a12d9",
      ready: "1/1",
      phase: "Running",
      restarts: 0,
      cpuMillicores: 390,
      cpuRequestMillicores: 400,
      cpuLimitMillicores: 1000,
      memoryMiB: 624,
      memoryRequestMiB: 512,
      memoryLimitMiB: 1024,
      nodeName: "ip-10-42-22-41.ec2.internal",
      sampledAtMs: nowMs,
    },
    {
      name: "billing-worker-6a12d9-88aa",
      namespace: "billing",
      revision: "rev-219",
      track: "stable",
      imageTag: "6a12d9",
      ready: "1/1",
      phase: "Running",
      restarts: 0,
      cpuMillicores: 365,
      cpuRequestMillicores: 400,
      cpuLimitMillicores: 1000,
      memoryMiB: 608,
      memoryRequestMiB: 512,
      memoryLimitMiB: 1024,
      nodeName: "ip-10-42-22-90.ec2.internal",
      sampledAtMs: nowMs,
    },
  ];

  const authProdPods: PodSnapshot[] = [
    {
      name: "identity-edge-d04e71-11b0",
      namespace: "identity",
      revision: "rev-108",
      track: "stable",
      imageTag: "d04e71",
      ready: "2/2",
      phase: "Running",
      restarts: 0,
      cpuMillicores: 180,
      cpuRequestMillicores: 250,
      cpuLimitMillicores: 1000,
      memoryMiB: 230,
      memoryRequestMiB: 256,
      memoryLimitMiB: 512,
      nodeName: "ip-10-42-05-19.ec2.internal",
      sampledAtMs: nowMs,
    },
    {
      name: "identity-edge-d04e71-44e2",
      namespace: "identity",
      revision: "rev-108",
      track: "stable",
      imageTag: "d04e71",
      ready: "2/2",
      phase: "Running",
      restarts: 0,
      cpuMillicores: 195,
      cpuRequestMillicores: 250,
      cpuLimitMillicores: 1000,
      memoryMiB: 241,
      memoryRequestMiB: 256,
      memoryLimitMiB: 512,
      nodeName: "ip-10-42-05-71.ec2.internal",
      sampledAtMs: nowMs,
    },
  ];

  const ledgerProdPods: PodSnapshot[] = [
    {
      name: "ledger-ingest-c390b1-09d1",
      namespace: "payments",
      revision: "rev-304",
      track: "stable",
      imageTag: "c390b1",
      ready: "2/2",
      phase: "Running",
      restarts: 0,
      cpuMillicores: 510,
      cpuRequestMillicores: 500,
      cpuLimitMillicores: 1500,
      memoryMiB: 845,
      memoryRequestMiB: 768,
      memoryLimitMiB: 1536,
      nodeName: "ip-10-42-31-07.ec2.internal",
      sampledAtMs: nowMs,
    },
  ];

  const snapshots: EnvironmentTelemetrySnapshot[] = [
    {
      envKey: "checkout-api:prod",
      appId: "checkout-api",
      envId: "prod",
      coverage: "healthy",
      coverageDetail: "Rollout Watch active (build #482 · 9f31c2a) · K8s, Datadog, Jenkins healthy",
      pods: checkoutProdPods,
      warningEvents: [
        {
          reason: "OOMKilling",
          message: "Memory cgroup out of memory: Killed process 42 (bun) in checkout-api-9f31c2a-9c2f",
          objectName: "checkout-api-9f31c2a-9c2f",
          count: 1,
          lastTimestampMs: nowMs - 8 * 60_000,
        },
      ],
      builds: checkoutProdBuilds,
      metrics: buildSeries(nowMs, 360, 890, 9, 2150, 0.14, 1.84, 46, 54),
      routeCohorts: checkoutRoutes,
      sampledAtMs: nowMs,
    },
    {
      envKey: "checkout-api:staging",
      appId: "checkout-api",
      envId: "staging",
      coverage: "auth_expired",
      coverageDetail: "EKS SSO token expired for eks-staging-us-east-1 (detectors frozen)",
      remediation: "Run `aws sso login --profile staging` to restore Kubernetes coverage.",
      pods: [],
      warningEvents: [],
      builds: [
        {
          buildNumber: 484,
          jobPath: "job/payments/job/checkout-api/job/staging",
          result: "SUCCESS",
          commitSha: "9f31c2a",
          commitMessage: "feat(promos): evaluate tiered bundle discounts per cart item",
          author: "m.patel",
          durationMs: 160_000,
          timestampMs: nowMs - 40 * 60_000,
          url: "https://jenkins.internal.example.com/job/payments/job/checkout-api/484",
        },
      ],
      metrics: buildSeries(nowMs, 210, 460, 0, 460, 0.09, 0.09, 28, 41),
      routeCohorts: [],
      sampledAtMs: nowMs - 42 * 60_000,
    },
    {
      envKey: "billing-worker:prod",
      appId: "billing-worker",
      envId: "prod",
      coverage: "healthy",
      coverageDetail: "All connectors healthy · 2/2 pods ready",
      pods: billingProdPods,
      warningEvents: [],
      builds: [
        {
          buildNumber: 219,
          jobPath: "job/payments/job/billing-worker/job/main",
          result: "SUCCESS",
          commitSha: "6a12d9",
          commitMessage: "fix(invoices): retry transient stripe webhook timeouts",
          author: "a.chen",
          durationMs: 142_000,
          timestampMs: nowMs - 18 * 3600_000,
          url: "https://jenkins.internal.example.com/job/payments/job/billing-worker/219",
        },
      ],
      metrics: buildSeries(nowMs, 290, 740, 0, 740, 0.11, 0.11, 38, 60),
      routeCohorts: [
        {
          route: "JOB invoice.reconcile_batch",
          service: "billing-worker",
          p50Ms: 320,
          p95Ms: 1180,
          p99Ms: 1940,
          errorRatePct: 0.12,
          wowDeltaPct: 34,
          rpm: 210,
        },
      ],
      sampledAtMs: nowMs,
    },
    {
      envKey: "identity-edge:prod",
      appId: "identity-edge",
      envId: "prod",
      coverage: "healthy",
      coverageDetail: "All connectors healthy · 2/2 pods ready",
      pods: authProdPods,
      warningEvents: [],
      builds: [
        {
          buildNumber: 108,
          jobPath: "job/platform/job/identity-edge/job/main",
          result: "SUCCESS",
          commitSha: "d04e71",
          commitMessage: "perf(jwks): extend key-set cache TTL to 15m",
          author: "s.kim",
          durationMs: 98_000,
          timestampMs: nowMs - 30 * 3600_000,
          url: "https://jenkins.internal.example.com/job/platform/job/identity-edge/108",
        },
      ],
      metrics: buildSeries(nowMs, 24, 62, 0, 62, 0.03, 0.03, 19, 45),
      routeCohorts: [
        {
          route: "POST /oauth2/token",
          service: "identity-edge",
          p50Ms: 24,
          p95Ms: 62,
          p99Ms: 118,
          errorRatePct: 0.03,
          wowDeltaPct: -6,
          rpm: 6100,
        },
      ],
      sampledAtMs: nowMs,
    },
    {
      envKey: "ledger-ingest:prod",
      appId: "ledger-ingest",
      envId: "prod",
      coverage: "healthy",
      coverageDetail: "All connectors healthy · watching steady throughput",
      pods: ledgerProdPods,
      warningEvents: [],
      builds: [
        {
          buildNumber: 304,
          jobPath: "job/payments/job/ledger-ingest/job/main",
          result: "SUCCESS",
          commitSha: "c390b1",
          commitMessage: "feat(kafka): enable zstd batch compression on settlement topic",
          author: "b.bryant",
          durationMs: 156_000,
          timestampMs: nowMs - 5 * 3600_000,
          url: "https://jenkins.internal.example.com/job/payments/job/ledger-ingest/304",
        },
      ],
      metrics: buildSeries(nowMs, 115, 290, 0, 290, 0.05, 0.05, 34, 55),
      routeCohorts: [],
      sampledAtMs: nowMs,
    },
  ];

  const evidence: EvidenceBlob[] = [
    {
      evidenceId: "ev_dd_p95_482" as EvidenceId,
      source: "datadog",
      envKey: "checkout-api:prod",
      title: "Datadog APM p95 latency jump after build #482",
      query: "service:checkout-api env:prod resource_name:POST_/v1/checkout/confirm",
      deepLink: "https://app.datadoghq.com/apm/service/checkout-api?env=prod",
      capturedAtMs: nowMs - 11 * 60_000,
      excerpt:
        "Baseline (pre-deploy 30m): p50=360ms, p95=890ms, 5xx=0.14%. Post-deploy rev-482 (9f31c2a): p50=410ms, p95=2150ms (+141%), 5xx=1.84% (upstream timeout).",
    },
    {
      evidenceId: "ev_trace_diff_482" as EvidenceId,
      source: "datadog",
      envKey: "checkout-api:prod",
      title: "Paired trace tree diff: 46x pg.query fan-out on rev-482 pods",
      query: "paired_trace_diff(POST /v1/checkout/confirm, release=9f31c2a)",
      deepLink: "https://app.datadoghq.com/apm/trace/tr_slow_991a",
      capturedAtMs: nowMs - 10 * 60_000,
      excerpt:
        "pg.query `SELECT * FROM cart_line_items WHERE cart_id = $1 AND promo_tier = $2` executes 46x per slow trace (1615ms) vs 2x in median traces (52ms). Skewed 100% to rev-482 pods.",
      traceDiff,
    },
    {
      evidenceId: "ev_k8s_rev_482" as EvidenceId,
      source: "kubernetes",
      envKey: "checkout-api:prod",
      title: "Kubernetes ReplicaSet split: old rev-481 healthy, new rev-482 degraded",
      query: "kubectl --context eks-prod-us-east-1 -n checkout get pods -l app=checkout-api",
      deepLink: "https://console.aws.amazon.com/eks/home#/clusters/eks-prod-us-east-1",
      capturedAtMs: nowMs - 9 * 60_000,
      excerpt:
        "rev-482 pods (checkout-api-9f31c2a-7b4d, 9c2f): CPU 840-875m, 1 OOMKilled restart, p95 2150ms. rev-481 pod (4c88e1b-3a1e): CPU 410m, 0 restarts, p95 880ms.",
    },
    {
      evidenceId: "ev_jk_482" as EvidenceId,
      source: "jenkins",
      envKey: "checkout-api:prod",
      title: "Jenkins build #482 commit 9f31c2a diff correlation",
      query: "job/payments/job/checkout-api/job/main/482",
      deepLink: "https://jenkins.internal.example.com/job/payments/job/checkout-api/482",
      capturedAtMs: nowMs - 14 * 60_000,
      excerpt:
        "Commit 9f31c2a by m.patel: 'feat(promos): evaluate tiered bundle discounts per cart item' introduced unbatched per-item promo lookup inside confirm loop.",
    },
    {
      evidenceId: "ev_explore_billing_n1" as EvidenceId,
      source: "datadog",
      envKey: "billing-worker:prod",
      title: "Overnight trace walk: N+1 ledger lookup in invoice.reconcile_batch",
      query: "service:billing-worker env:prod operation:invoice.reconcile_batch",
      deepLink: "https://app.datadoghq.com/apm/service/billing-worker?env=prod",
      capturedAtMs: nowMs - 3 * 3600_000,
      excerpt:
        "Recurred 14 times over 6h: p95 grew +34% WoW (880ms -> 1180ms) from sequential SELECT per invoice line instead of batched IN query.",
    },
    {
      evidenceId: "ev_explore_redis_drift" as EvidenceId,
      source: "kubernetes",
      envKey: "ledger-ingest:prod",
      title: "Memory working set trending toward 70% limit over 7d",
      query: "kubectl -n payments top pods -l app=ledger-ingest",
      deepLink: "https://console.aws.amazon.com/eks/home#/clusters/eks-prod-us-east-1",
      capturedAtMs: nowMs - 2 * 3600_000,
      excerpt:
        "ledger-ingest-c390b1-09d1 steady memory climb 610 MiB -> 845 MiB (+38% in 7 days) without matching RPS growth; suspect unbounded topic metadata cache.",
    },
  ];

  return { snapshots, evidence };
}
