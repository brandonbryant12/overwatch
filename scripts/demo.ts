/**
 * Demo mode (`pnpm run demo`): starts the Overwatch service against a temporary data directory with fake sources
 * and seeds a varied, believable command-center state (no real cluster, Datadog, repository host or OpenCode
 * required). Stays running on loopback so you can explore the UI, archive items, and send prompts.
 *
 * Usage:
 *   pnpm run demo
 *   pnpm run demo -- --port 7455
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import {
  ArchiveIncident,
  AskThread,
  CompleteRun,
  FailRun,
  Incident,
  incidentIdOf,
  MarkRunSent,
  ReportSignal,
  Run,
  runIdOf,
  sessionIdOf,
  Thread,
  threadIdOf,
  WatcherId,
  type Finding,
} from "../src/domain/index.ts";
import { parseConfig } from "../src/service/config.ts";
import type { OpenCodePort } from "../src/service/opencode.ts";
import { startService } from "../src/service/service.ts";
import { fakeCluster } from "../test/fixtures/cluster.ts";

const args = process.argv.slice(2);
const emptyMode = args.includes("--empty");
const portFlag = (() => {
  const idx = args.indexOf("--port");
  if (idx >= 0 && args[idx + 1]) return Number(args[idx + 1]);
  if (process.env.OVERWATCH_PORT) return Number(process.env.OVERWATCH_PORT);
  return 7450;
})();

const MIN = 60_000;
const HOUR = 60 * MIN;

/** OpenCode intentionally unreachable in demo mode so the page shows offline agent status and waiting runs. */
const offlineOpenCode: OpenCodePort = {
  connect: async () => undefined,
  createSession: async () => {
    throw new Error("OpenCode is not connected in demo mode");
  },
  prompt: async () => {
    throw new Error("OpenCode is not connected in demo mode");
  },
  synthetic: async () => {
    throw new Error("OpenCode is not connected in demo mode");
  },
  newUserMessages: async () => [],
  promptState: async () => ({ kind: "session-missing" }),
  interrupt: async () => undefined,
  answer: async () => undefined,
};

const waitUntil = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 10_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error("demo seed timed out waiting for domain policy");
    await new Promise((r) => setTimeout(r, 30));
  }
};

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "overwatch-demo-"));
  const cluster = fakeCluster({ pods: 3, image: "registry.example/checkout-api:a4f91c2" });
  const now = Date.now();

  const config = parseConfig({
    service: { port: portFlag },
    apps: {
      "checkout-api": {
        checkout: join(dataDir, "no-checkout-checkout-api"),
        environments: {
          production: { sources: { pods: { type: "kubernetes", context: "prod-us-east", namespace: "commerce", selector: "app=checkout-api" } } },
          staging: { sources: { pods: { type: "kubernetes", context: "staging-us-east", namespace: "commerce", selector: "app=checkout-api" } } },
        },
      },
      "auth-gateway": {
        checkout: join(dataDir, "no-checkout-auth-gateway"),
        environments: {
          production: { sources: { pods: { type: "kubernetes", context: "prod-us-east", namespace: "identity", selector: "app=auth-gateway" } } },
          staging: { sources: { pods: { type: "kubernetes", context: "staging-us-east", namespace: "identity", selector: "app=auth-gateway" } } },
        },
      },
      "ledger-worker": {
        checkout: join(dataDir, "no-checkout-ledger-worker"),
        environments: {
          production: { sources: { pods: { type: "kubernetes", context: "prod-us-east", namespace: "finance", selector: "app=ledger-worker" } } },
        },
      },
      "search-indexer": {
        checkout: join(dataDir, "no-checkout-search-indexer"),
        environments: {
          staging: { sources: { pods: { type: "kubernetes", context: "staging-us-east", namespace: "discovery", selector: "app=search-indexer" } } },
        },
      },
      "billing-cron": {
        checkout: join(dataDir, "no-checkout-billing-cron"),
        environments: {
          qa: { sources: { pods: { type: "kubernetes", context: "qa-us-east", namespace: "finance", selector: "app=billing-cron" } } },
        },
      },
    },
    watchers: [
      { app: "checkout-api", environment: "production", every: "10m" },
      { app: "checkout-api", environment: "staging", every: "10m" },
      { app: "auth-gateway", environment: "production", every: "10m" },
      { app: "auth-gateway", environment: "staging", every: "15m" },
      { app: "ledger-worker", environment: "production", every: "10m" },
      { app: "search-indexer", environment: "staging", every: "15m" },
      { app: "billing-cron", environment: "qa", every: "30m" },
    ],
    dataDir,
    lookback: { initial: "2h", slice: "1h", overlap: "2m", max: "14d" },
    notify: false,
    opencode: { autoInvestigate: true },
  });
  if (config.errors.length) throw new Error(`Demo config invalid: ${config.errors.join("; ")}`);

  const service = await startService(config, {
    exec: cluster.exec,
    opencode: offlineOpenCode,
    port: portFlag,
    background: false,
    log: (msg) => console.log(`[demo] ${msg}`),
  });

  const run = <A, E>(effect: Effect.Effect<A, E, any>) => service.runtime.runPromise(effect as Effect.Effect<A, E, never>);

  if (emptyMode) {
    await service.work();
    await service.atomically((db) => {
      const update = db.prepare("UPDATE watcher_runs SET last_started = ?, last_finished = ?, next_at = ?, last_error = ?, last_summary = ? WHERE watcher = ?");
      for (const w of config.options.watchers) {
        update.run(now - 2 * MIN, now - 2 * MIN + 900, now + 8 * MIN, null, JSON.stringify({ reported: 0, gaps: 0 }), w.id);
      }
    });
    console.log(`\n  Overwatch demo (empty inbox) ready at ${service.url}`);
    console.log(`  Data directory: ${dataDir} (temporary, deleted on exit)`);
    console.log(`  Press Ctrl+C to stop.\n`);
    const stop = async () => {
      await service.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  const waitRunRequested = (runId: ReturnType<typeof runIdOf>) =>
    waitUntil(
      () =>
        run(
          Effect.gen(function* () {
            const runs = yield* Run;
            const s = yield* runs.get(Run.ref(runId));
            return s._tag === "Run" ? s.status : undefined;
          }),
        ),
      (status) => status !== undefined,
    );

  const report = (input: {
    app: string;
    environment: string;
    source: string;
    fingerprint: string;
    title: string;
    severity: "info" | "warn" | "error";
    at: number;
    firstAt?: number;
    count: number;
    sample?: string;
    query?: string;
    commandId: string;
  }) => {
    const id = incidentIdOf(input.app, input.environment, input.fingerprint);
    return run(
      Effect.gen(function* () {
        const incidents = yield* Incident;
        yield* incidents.send(
          Incident.ref(id),
          new ReportSignal({
            app: input.app,
            environment: input.environment,
            watcher: WatcherId.make(`${input.app}/${input.environment}`),
            source: input.source,
            fingerprint: input.fingerprint,
            title: input.title,
            severity: input.severity,
            at: input.at,
            count: input.count,
            ...(input.firstAt !== undefined ? { firstAt: input.firstAt } : {}),
            ...(input.sample !== undefined ? { sample: input.sample } : {}),
            ...(input.query !== undefined ? { query: input.query } : {}),
          }),
          { commandId: input.commandId },
        );
      }),
    ).then(() => id);
  };

  // ------------------------------------------------------------------ 1. Answered (real, high confidence, verified + unverifiable citations + follow-up)
  const checkoutProdId = await report({
    app: "checkout-api",
    environment: "production",
    source: "pods",
    fingerprint: "stripe-authorize-timeout-300ms",
    title: "ERROR stripe-charge: upstream timeout after 300ms on /v2/authorize",
    severity: "error",
    firstAt: now - 52 * MIN,
    at: now - 46 * MIN,
    count: 14,
    sample:
      '[pod/checkout-api-6d9f8-kx2m1/api] 2026-11-25T19:01:12Z ERROR stripe-charge req=ch_9921a upstream timeout after 300ms route=/v2/authorize attempt=1/1',
    query: 'kubectl --context prod-us-east -n commerce logs -l app=checkout-api --since=1h | grep "stripe-charge"',
    commandId: "demo_checkout_prod_open",
  });
  await report({
    app: "checkout-api",
    environment: "production",
    source: "pods",
    fingerprint: "stripe-authorize-timeout-300ms",
    title: "ERROR stripe-charge: upstream timeout after 300ms on /v2/authorize",
    severity: "error",
    at: now - 21 * MIN,
    count: 19,
    sample:
      '[pod/checkout-api-6d9f8-m4q8r/api] 2026-11-25T19:26:04Z ERROR stripe-charge req=ch_9948f upstream timeout after 300ms route=/v2/authorize attempt=1/1',
    commandId: "demo_checkout_prod_rec1",
  });
  await report({
    app: "checkout-api",
    environment: "production",
    source: "pods",
    fingerprint: "stripe-authorize-timeout-300ms",
    title: "ERROR stripe-charge: upstream timeout after 300ms on /v2/authorize",
    severity: "error",
    at: now - 4 * MIN,
    count: 9,
    commandId: "demo_checkout_prod_rec2",
  });

  const checkoutThread = threadIdOf(checkoutProdId);
  const checkoutTriageRun = runIdOf(checkoutThread, "triage");
  const checkoutSession = sessionIdOf(checkoutThread, "triage");
  await waitRunRequested(checkoutTriageRun);
  const checkoutFinding: Finding = {
    product: {
      impact: "Roughly 6% of card authorizations fail with 504 on first attempt; customers have to retry checkout.",
      affected: "US-East web & iOS card checkouts hitting /v2/authorize",
      since: "52 minutes ago (deploy a4f91c2)",
      status: "ongoing",
    },
    engineering: {
      verdict: "real",
      confidence: "high",
      cause: "Deploy a4f91c2 lowered STRIPE_AUTHORIZE_TIMEOUT_MS from 2500ms to 300ms while p95 gateway latency sits at 410ms.",
      causeBasis: "observed",
      evidence: [
        {
          source: "pods",
          quote: "ERROR stripe-charge req=ch_9921a upstream timeout after 300ms route=/v2/authorize attempt=1/1",
          verified: true,
        },
        {
          source: "src/payments/stripe.ts",
          quote: "export const STRIPE_AUTHORIZE_TIMEOUT_MS = 300 // tightened for fail-fast",
          verified: true,
        },
        {
          source: "datadog-apm",
          quote: "stripe.authorize p95 latency 412ms steady over the last 6h (no upstream degradation)",
          verified: false,
        },
      ],
      codeLocation: "src/payments/stripe.ts:14",
      notChecked: ["Stripe status page for EU-West", "whether retry idempotency keys double-post on client retry"],
      nextCheck: "Revert STRIPE_AUTHORIZE_TIMEOUT_MS to 2500ms or restore per-route budget in config/timeouts.json.",
    },
    ruledOut: [
      "Upstream Stripe outage (success latency distribution is unchanged since yesterday)",
      "Pod CPU throttling in commerce namespace (all 3 pods below 35% of CPU limit)",
    ],
  };
  await run(
    Effect.gen(function* () {
      const runs = yield* Run;
      yield* runs.send(Run.ref(checkoutTriageRun), new MarkRunSent({}), { commandId: "demo_checkout_sent" });
      yield* runs.send(Run.ref(checkoutTriageRun), new CompleteRun({ sessionId: checkoutSession, finding: checkoutFinding }), {
        commandId: "demo_checkout_done",
      });
    }),
  );
  // Wait for Outcome policy to mark session idle & record handoff before adding owner follow-up
  await waitUntil(
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* Thread;
          const s = yield* t.get(Thread.ref(checkoutThread));
          return s._tag === "Active" && s.sessions.some((x) => x.status === "idle") ? s : undefined;
        }),
      ),
    (s) => s !== undefined,
  );
  await run(
    Effect.gen(function* () {
      const t = yield* Thread;
      yield* t.send(
        Thread.ref(checkoutThread),
        new AskThread({
          subject: checkoutProdId,
          title: "ERROR stripe-charge: upstream timeout after 300ms on /v2/authorize",
          promptId: "p-followup-1",
          text: "Does staging have the same 300ms timeout or did it get overridden there?",
          mode: "investigate",
          origin: "opencode",
          override: "here",
          inSession: checkoutSession,
        }),
        { commandId: "demo_checkout_followup" },
      );
    }),
  );
  const checkoutFollowRun = runIdOf(checkoutThread, "p-followup-1");
  await waitRunRequested(checkoutFollowRun);
  const checkoutFollowFinding: Finding = {
    product: {
      impact: "Staging uses a mock gateway (~12ms), so the 300ms timeout was never triggered before promotion.",
      affected: "Production US-East card checkouts only (staging masked by stub)",
      since: "52 minutes ago (deploy a4f91c2)",
      status: "ongoing",
    },
    engineering: {
      verdict: "real",
      confidence: "high",
      cause: "Deploy a4f91c2 lowered STRIPE_AUTHORIZE_TIMEOUT_MS from 2500ms to 300ms; staging points at stripe-stub (p99 18ms), hiding the regression.",
      causeBasis: "observed",
      evidence: [
        {
          source: "src/payments/stripe.ts",
          quote: "export const STRIPE_AUTHORIZE_TIMEOUT_MS = 300 // tightened for fail-fast",
          verified: true,
        },
        {
          source: "config/staging.json",
          quote: '"stripeBaseUrl": "http://stripe-stub.commerce.svc:8080"',
          verified: true,
        },
        {
          source: "datadog-apm",
          quote: "stripe.authorize p95 latency 412ms steady over the last 6h (no upstream degradation)",
          verified: false,
        },
      ],
      codeLocation: "src/payments/stripe.ts:14",
      notChecked: ["Stripe status page for EU-West", "whether client retry double-posts idempotency keys"],
      nextCheck: "Revert STRIPE_AUTHORIZE_TIMEOUT_MS to 2500ms in prod, then add 350ms jitter to stripe-stub in staging.",
    },
    ruledOut: [
      "Upstream Stripe outage (success latency distribution is unchanged since yesterday)",
      "Environment-specific override in Helm values",
    ],
  };
  await run(
    Effect.gen(function* () {
      const runs = yield* Run;
      yield* runs.send(Run.ref(checkoutFollowRun), new MarkRunSent({}), { commandId: "demo_checkout_f_sent" });
      yield* runs.send(
        Run.ref(checkoutFollowRun),
        new CompleteRun({
          sessionId: checkoutSession,
          finding: checkoutFollowFinding,
        }),
        { commandId: "demo_checkout_f_done" },
      );
    }),
  );

  // ------------------------------------------------------------------ 2. Under investigation (sent) + queued follow-up behind it
  const authProdId = await report({
    app: "auth-gateway",
    environment: "production",
    source: "pods",
    fingerprint: "auth-gateway-oomkilled-137",
    title: "CrashLoopBackOff: auth-gateway-7b9d4 OOMKilled (exit 137, 512Mi limit)",
    severity: "error",
    firstAt: now - 34 * MIN,
    at: now - 2 * MIN,
    count: 6,
    sample:
      "Warning BackOff pod/auth-gateway-7b9d4-9v2pl Back-off restarting failed container gateway (last termination: OOMKilled exit=137 mem=512Mi/512Mi)",
    query: "kubectl --context prod-us-east -n identity describe pod -l app=auth-gateway",
    commandId: "demo_auth_prod_open",
  });
  const authThread = threadIdOf(authProdId);
  const authTriageRun = runIdOf(authThread, "triage");
  await waitRunRequested(authTriageRun);
  await run(
    Effect.gen(function* () {
      const runs = yield* Run;
      yield* runs.send(Run.ref(authTriageRun), new MarkRunSent({}), { commandId: "demo_auth_sent" });
    }),
  );
  await waitUntil(
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* Thread;
          const s = yield* t.get(Thread.ref(authThread));
          return s._tag === "Active" && s.sessions.some((x) => x.status === "running") ? s : undefined;
        }),
      ),
    (s) => s !== undefined,
  );
  await run(
    Effect.gen(function* () {
      const t = yield* Thread;
      yield* t.send(
        Thread.ref(authThread),
        new AskThread({
          subject: authProdId,
          title: "CrashLoopBackOff: auth-gateway-7b9d4 OOMKilled (exit 137, 512Mi limit)",
          promptId: "p-owner-queue",
          text: "Compare heap retention against revision 7b9c1 before the JWKS cache refactor.",
          mode: "investigate",
          origin: "page",
          override: "auto",
        }),
        { commandId: "demo_auth_queued_followup" },
      );
    }),
  );
  await waitRunRequested(runIdOf(authThread, "p-owner-queue"));

  // ------------------------------------------------------------------ 3. Failed triage run + needs attention (staging DB pool exhaustion)
  const checkoutStagingId = await report({
    app: "checkout-api",
    environment: "staging",
    source: "pods",
    fingerprint: "pg-pool-exhausted-25",
    title: "ERROR postgres pool exhausted (max=25, waiting=48) during load test",
    severity: "error",
    firstAt: now - 95 * MIN,
    at: now - 16 * MIN,
    count: 27,
    sample:
      "[pod/checkout-api-5c41a-zz90q/api] 2026-11-25T19:31:09Z ERROR pg-pool acquire timed out after 5000ms (active=25 idle=0 waiting=48)",
    query: 'kubectl --context staging-us-east -n commerce logs -l app=checkout-api --since=2h | grep "pg-pool"',
    commandId: "demo_checkout_stg_open",
  });
  const checkoutStgThread = threadIdOf(checkoutStagingId);
  const checkoutStgRun = runIdOf(checkoutStgThread, "triage");
  await waitRunRequested(checkoutStgRun);
  await run(
    Effect.gen(function* () {
      const runs = yield* Run;
      yield* runs.send(Run.ref(checkoutStgRun), new MarkRunSent({}), { commandId: "demo_stg_sent" });
      yield* runs.send(Run.ref(checkoutStgRun), new FailRun({ reason: "the session stopped twice without filing a finding" }), {
        commandId: "demo_stg_fail",
      });
    }),
  );
  await waitUntil(
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* Thread;
          const s = yield* t.get(Thread.ref(checkoutStgThread));
          return s._tag === "Active" && s.sessions.some((x) => x.status === "failed") ? s : undefined;
        }),
      ),
    (s) => s !== undefined,
  );

  // ------------------------------------------------------------------ 4. Queued (waiting on OpenCode to connect)
  const ledgerProdId = await report({
    app: "ledger-worker",
    environment: "production",
    source: "pods",
    fingerprint: "ledger-reconciliation-lag-120s",
    title: "WARN reconciliation lag exceeded 120s on shard-04 (depth=18,420)",
    severity: "warn",
    firstAt: now - 19 * MIN,
    at: now - 6 * MIN,
    count: 4,
    sample:
      "[pod/ledger-worker-0/worker] 2026-11-25T19:41:18Z WARN reconciliation lag=148.3s shard=04 pending_entries=18420 consumer=ledger-0",
    query: 'kubectl --context prod-us-east -n finance logs ledger-worker-0 --since=30m | grep "reconciliation lag"',
    commandId: "demo_ledger_prod_open",
  });
  await waitRunRequested(runIdOf(threadIdOf(ledgerProdId), "triage"));

  // ------------------------------------------------------------------ 5. Held (triage recorded as held; waiting for owner to prompt)
  const searchStgId = incidentIdOf("search-indexer", "staging", "es-circuit-breaker-parent");
  const searchStgThread = threadIdOf(searchStgId);
  // Pre-seed the held triage prompt with promptId "triage" so Triage policy stays idempotent and keeps it held.
  await run(
    Effect.gen(function* () {
      const t = yield* Thread;
      yield* t.send(
        Thread.ref(searchStgThread),
        new AskThread({
          subject: searchStgId,
          title: "ERROR bulk index rejected: parent circuit_breaking_exception (data too large)",
          promptId: "triage",
          text: "Investigate this incident.",
          mode: "investigate",
          origin: "system",
          override: "auto",
          hold: true,
        }),
        { commandId: "demo_search_held" },
      );
    }),
  );
  await report({
    app: "search-indexer",
    environment: "staging",
    source: "pods",
    fingerprint: "es-circuit-breaker-parent",
    title: "ERROR bulk index rejected: parent circuit_breaking_exception (data too large)",
    severity: "warn",
    firstAt: now - 41 * MIN,
    at: now - 11 * MIN,
    count: 8,
    sample:
      "[pod/search-indexer-2/indexer] 2026-11-25T19:36:40Z ERROR bulk-upsert status=429 type=circuit_breaking_exception bytes_wanted=912MB limit=896MB",
    query: 'kubectl --context staging-us-east -n discovery logs -l app=search-indexer --since=1h | grep "circuit_breaking"',
    commandId: "demo_search_stg_open",
  });

  // ------------------------------------------------------------------ 6. Answered (unsure / low confidence, QA environment)
  const billingQaId = await report({
    app: "billing-cron",
    environment: "qa",
    source: "pods",
    fingerprint: "invoice-pdf-render-slow",
    title: "INFO invoice-pdf worker took 4.8s on batch #410 (threshold 3.0s)",
    severity: "info",
    firstAt: now - 2 * HOUR,
    at: now - 58 * MIN,
    count: 2,
    sample:
      "[pod/billing-cron-28914420-h7k1q/pdf] 2026-11-25T18:49:02Z INFO pdf-render batch=410 duration_ms=4812 pages=64 fonts=embedded",
    query: 'kubectl --context qa-us-east -n finance logs -l app=billing-cron --since=3h',
    commandId: "demo_billing_qa_open",
  });
  const billingThread = threadIdOf(billingQaId);
  const billingRun = runIdOf(billingThread, "triage");
  const billingSession = sessionIdOf(billingThread, "triage");
  await waitRunRequested(billingRun);
  await run(
    Effect.gen(function* () {
      const runs = yield* Run;
      yield* runs.send(Run.ref(billingRun), new MarkRunSent({}), { commandId: "demo_billing_sent" });
      yield* runs.send(
        Run.ref(billingRun),
        new CompleteRun({
          sessionId: billingSession,
          finding: {
            product: {
              impact: "No customer impact; QA nightly batch finished 1.8s past its soft warning target.",
              affected: "QA invoice generator only",
              since: "2 hours ago",
              status: "resolved",
            },
            engineering: {
              verdict: "not_real",
              confidence: "medium",
              cause: "Batch #410 had 64 embedded-font pages (3x median size); per-page render rate was unchanged.",
              causeBasis: "inferred",
              evidence: [
                { source: "pods", quote: "INFO pdf-render batch=410 duration_ms=4812 pages=64 fonts=embedded", verified: true },
              ],
              notChecked: ["Node disk I/O contention during batch #410"],
              nextCheck: "Archive or raise QA batch warning threshold to per-page latency.",
            },
            ruledOut: ["Memory leak in headless PDF renderer"],
          },
        }),
        { commandId: "demo_billing_done" },
      );
    }),
  );

  // ------------------------------------------------------------------ 7. Archived incidents (out of inbox, searchable, one with quiet recurrence)
  const archivedAuthStgId = await report({
    app: "auth-gateway",
    environment: "staging",
    source: "pods",
    fingerprint: "jwks-cold-start-miss",
    title: "WARN jwks key rotation cache miss on cold pod startup",
    severity: "warn",
    firstAt: now - 5 * HOUR,
    at: now - 4 * HOUR,
    count: 3,
    sample: "[pod/auth-gateway-stg-1/gateway] 2026-11-25T15:45:01Z WARN jwks cache miss kid=2026-11-a fetching synchronously",
    commandId: "demo_archived_1_open",
  });
  await waitRunRequested(runIdOf(threadIdOf(archivedAuthStgId), "triage"));
  await run(
    Effect.gen(function* () {
      const incidents = yield* Incident;
      yield* incidents.send(
        Incident.ref(archivedAuthStgId),
        new ArchiveIncident({ reason: "Expected on staging cold boot; does not return to inbox.", actor: "owner (page)" }),
        { commandId: "demo_archived_1_arc" },
      );
    }),
  );
  // Quiet recurrence after archive (updates occurrences/timeline, never re-enters inbox)
  await report({
    app: "auth-gateway",
    environment: "staging",
    source: "pods",
    fingerprint: "jwks-cold-start-miss",
    title: "WARN jwks key rotation cache miss on cold pod startup",
    severity: "warn",
    at: now - 12 * MIN,
    count: 2,
    commandId: "demo_archived_1_rec",
  });

  const archivedWebhookId = await report({
    app: "checkout-api",
    environment: "production",
    source: "pods",
    fingerprint: "deprecated-webhook-v1",
    title: "INFO deprecated webhook v1 payload received from partner-legacy",
    severity: "info",
    firstAt: now - 6 * HOUR,
    at: now - 3 * HOUR,
    count: 11,
    sample: "[pod/checkout-api-6d9f8-kx2m1/api] 2026-11-25T16:40:22Z INFO webhook v1 sunset notice partner=partner-legacy",
    commandId: "demo_archived_2_open",
  });
  await waitRunRequested(runIdOf(threadIdOf(archivedWebhookId), "triage"));
  await run(
    Effect.gen(function* () {
      const incidents = yield* Incident;
      yield* incidents.send(
        Incident.ref(archivedWebhookId),
        new ArchiveIncident({ reason: "Partner migration tracked in Jira COMM-4812.", actor: "owner (page)" }),
        { commandId: "demo_archived_2_arc" },
      );
    }),
  );

  // Run one worker pass so /status records OpenCode as disconnected with accurate waitingRuns / runningRuns.
  await service.work();

  // Seed realistic watcher timestamps so /status shows live watcher telemetry too.
  await service.atomically((db) => {
    const update = db.prepare("UPDATE watcher_runs SET last_started = ?, last_finished = ?, next_at = ?, last_error = ?, last_summary = ? WHERE watcher = ?");
    update.run(now - 3 * MIN, now - 3 * MIN + 1400, now + 7 * MIN, null, JSON.stringify({ reported: 3, gaps: 0 }), "checkout-api/production");
    update.run(now - 4 * MIN, now - 4 * MIN + 1100, now + 6 * MIN, null, JSON.stringify({ reported: 1, gaps: 0 }), "checkout-api/staging");
    update.run(now - 2 * MIN, now - 2 * MIN + 980, now + 8 * MIN, null, JSON.stringify({ reported: 1, gaps: 0 }), "auth-gateway/production");
    update.run(now - 8 * MIN, now - 8 * MIN + 820, now + 7 * MIN, null, JSON.stringify({ reported: 1, gaps: 0 }), "auth-gateway/staging");
    update.run(now - 6 * MIN, now - 6 * MIN + 1300, now + 4 * MIN, null, JSON.stringify({ reported: 1, gaps: 0 }), "ledger-worker/production");
    update.run(now - 11 * MIN, now - 11 * MIN + 1600, now + 4 * MIN, null, JSON.stringify({ reported: 1, gaps: 0 }), "search-indexer/staging");
    update.run(now - 14 * MIN, now - 14 * MIN + 900, now + 16 * MIN, null, JSON.stringify({ reported: 1, gaps: 0 }), "billing-cron/qa");
  });

  console.log(`\n  Overwatch demo ready at ${service.url}`);
  console.log(`  Data directory: ${dataDir} (temporary, deleted on exit)`);
  console.log(`  OpenCode: intentionally disconnected (prompts will queue visibly)`);
  console.log(`  Press Ctrl+C to stop.\n`);

  const stop = async () => {
    console.log("\n[demo] shutting down...");
    await service.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
