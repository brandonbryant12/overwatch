import { describe, expect, test } from "./harness.ts";
import { parseWhen, queryWindow } from "../src/duration.ts";
import { configureRedaction, looksGenerated, redactText } from "../src/redact.ts";
import { sourceContext } from "../src/runtime.ts";
import { datadogLogsSource, datadogMetricsSource, datadogMonitorsSource, retryAfterMs } from "../src/sources/datadog.ts";
import { kubernetesSource, parsePods, parseWorkloads, selects } from "../src/sources/kubernetes.ts";
import { keys, loadWatcher, memoryKV, NewerSchemaError, readRecord, scanRecords, SCHEMA_VERSION, writeRecord } from "../src/store.ts";
import { runWatcher } from "../src/sweep.ts";
import { items, parseJson, pick, time } from "../src/tolerant.ts";
import { fakeExec, options, runtime, type Call } from "./helpers.ts";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const WINDOW = { from: Date.parse("2026-11-25T10:00:00Z"), to: NOW };

const config = options({
  apps: {
    "shop-api": {
      checkout: "/tmp/shop-api",
      environments: {
        production: {
          sources: {
            pods: { type: "kubernetes", context: "prod-cluster", namespace: "shop", selector: "app=shop-api" },
            errors: { type: "datadog-logs", query: "service:shop-api status:error" },
            monitors: { type: "datadog-monitors", tags: ["service:shop-api"] },
            latency: { type: "datadog-metrics", queries: { p95: "p95:latency{*} by {host}" } },
          },
        },
      },
    },
  },
  watchers: [{ app: "shop-api", environment: "production", sources: ["pods"], investigate: false }],
  datadog: { apiKey: "env:OW_TEST_DD_API", appKey: "env:OW_TEST_DD_APP", apiUrl: "http://datadog.test" },
  notify: false,
});
process.env.OW_TEST_DD_API = "fake-api";
process.env.OW_TEST_DD_APP = "fake-app";

const sources = config.apps["shop-api"]!.environments.production!.sources;

describe("stored records carry a schema version", () => {
  test("records are written in an envelope and read back without it", async () => {
    const kv = memoryKV();
    await writeRecord(kv, keys.incident("inc_1"), { id: "inc_1", status: "open" });
    expect(kv.data.get("incident/inc_1")).toEqual({ v: SCHEMA_VERSION, data: { id: "inc_1", status: "open" } });
    expect(await readRecord(kv, keys.incident("inc_1"))).toEqual({ id: "inc_1", status: "open" });
  });

  test("a record from before versioning is still read", async () => {
    const kv = memoryKV();
    await kv.set(keys.watcher("app/prod"), { lastRunAt: 5, checkpoints: { logs: 4 }, series: {} });
    expect((await loadWatcher(kv, "app/prod")).checkpoints).toEqual({ logs: 4 });
  });

  test("a record from a newer version is neither read nor overwritten, and scans skip it", async () => {
    const kv = memoryKV();
    const newer = { v: SCHEMA_VERSION + 1, data: { shape: "unknown to this version" } };
    await kv.set(keys.watcher("app/prod"), newer);
    await kv.set(keys.incident("inc_new"), newer);
    await writeRecord(kv, keys.incident("inc_old"), { id: "inc_old" });
    await expect(loadWatcher(kv, "app/prod")).rejects.toThrow("newer Overwatch");
    await expect(writeRecord(kv, keys.watcher("app/prod"), { checkpoints: {} })).rejects.toThrow("newer Overwatch");
    expect(kv.data.get("watcher/app/prod")).toEqual(newer);
    expect(await scanRecords(kv, "incident/")).toEqual({ records: [{ id: "inc_old" }], skipped: 1 });
    expect(new NewerSchemaError("k", 9).name).toBe("NewerSchemaError");
  });
});

describe("redaction looks at the value, not only its name", () => {
  test("generated values are redacted whatever they are called; the name before them is kept", () => {
    const line = "connecting with session=Zk9xT2mQ7vB4nL8pR1sW6yD3 and k8Hq2ZpL9xVb3NcR7tYw5MdF1sGj4AeU";
    const out = redactText(line);
    expect(out).not.toContain("Zk9xT2mQ7vB4nL8pR1sW6yD3");
    expect(out).not.toContain("k8Hq2ZpL9xVb3NcR7tYw5MdF1sGj4AeU");
    expect(out).toContain("session=[REDACTED:high_entropy:");
    // The same value redacts to the same marker, so it can still be followed across lines.
    expect(redactText("a k8Hq2ZpL9xVb3NcR7tYw5MdF1sGj4AeU")).toBe(redactText("a k8Hq2ZpL9xVb3NcR7tYw5MdF1sGj4AeU"));
  });

  test("what an investigation needs survives: commits, digests, UUIDs, pod names, paths, class names", () => {
    for (const line of [
      "deployed 9f8e7d6a1b2c3d4e5f60718293a4b5c6d7e8f901 trace 550e8400-e29b-41d4-a716-446655440000",
      "image registry.example/shop-api@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "2026-11-25T10:05:00Z shop-api-7d9f8b6c5-x2x4z ERROR payment 42 timed out after 3000ms",
      "at src/payments/PaymentProviderTimeoutHandler.ts:12 in OAuth2AuthorizationRequestRedirectFilter.doFilterInternal",
      "GET https://app.example.com/orders/12345/items?page=2 took 1532ms",
    ]) {
      expect(redactText(line)).toBe(line);
    }
    expect(looksGenerated("OAuth2AuthorizationRequestRedirectFilter")).toBe(false);
    expect(looksGenerated("9f8e7d6a1b2c3d4e5f60718293a4b5c6d7e8f901")).toBe(false);
  });

  test("named credentials are still caught, and the entropy check can be tuned from the options", () => {
    expect(redactText("Authorization: Bearer abc.def.ghi")).toContain("[REDACTED:auth_header]");
    try {
      configureRedaction({ entropy: true, allow: [/^req_/], patterns: [/internal-\d+/g] });
      expect(redactText("req_Zk9xT2mQ7vB4nL8pR1sW6yD3 internal-4417")).toBe("req_Zk9xT2mQ7vB4nL8pR1sW6yD3 [REDACTED:custom]");
      configureRedaction({ entropy: false });
      expect(redactText("k8Hq2ZpL9xVb3NcR7tYw5MdF1sGj4AeU")).toBe("k8Hq2ZpL9xVb3NcR7tYw5MdF1sGj4AeU");
    } finally {
      configureRedaction({});
    }
  });
});

describe("other systems' JSON is read without trusting its shape", () => {
  test("stray text around the document, other spellings of a field and other forms of a time are tolerated", () => {
    expect(parseJson('Warning: v1 is deprecated\n{"items": []}\n', "kubectl get pods")).toEqual({ items: [] });
    expect(() => parseJson("<html>502 Bad Gateway</html>", "Datadog /api/v1/monitor")).toThrow("Datadog /api/v1/monitor did not return JSON");
    expect(() => parseJson('{"items": [{"metadata"', "kubectl get pods")).toThrow("cut off before the end");
    expect(() => parseJson("", "kubectl get pods")).toThrow("returned nothing");
    expect(pick({ LastTimestamp: "x" }, "lastTimestamp")).toBe("x");
    expect(pick({ overall_state: "Alert" }, "overallState", "overall_state")).toBe("Alert");
    expect(time("2026-11-25T10:00:00Z")).toBe(Date.parse("2026-11-25T10:00:00Z"));
    expect(time(1795514400)).toBe(1795514400000);
    expect(time("1795514400000")).toBe(1795514400000);
    expect(Number.isNaN(time("soon"))).toBe(true);
    expect(items({ kind: "Node", metadata: { name: "node-a" } })).toHaveLength(1);
    expect(items({ kind: "PodList" })).toEqual([]);
    expect(items(null)).toEqual([]);
  });

  test("pods with missing or mistyped fields parse to what can be known, not an exception", () => {
    const pods = parsePods(
      JSON.stringify({
        items: [
          { metadata: { name: "a" }, spec: { containers: { name: "api", image: "x:1" } }, status: { conditions: null, containerStatuses: "none" } },
          { metadata: null, spec: null, status: null },
          "not a pod",
        ],
      }),
    );
    expect(pods).toHaveLength(2);
    expect(pods[0]).toMatchObject({ name: "a", ready: false, restarts: 0, phase: "Unknown", statuses: [] });
    expect(pods[0]!.containers[0]).toMatchObject({ name: "api", image: "x:1" });
    expect(parsePods("{}")).toEqual([]);
  });

  test("label selectors are matched the way kubectl matches them", () => {
    const labels = { app: "shop-api", tier: "web" };
    expect(selects("app=shop-api", labels)).toBe(true);
    expect(selects("app==shop-api,tier!=batch", labels)).toBe(true);
    expect(selects("app in (shop-api, billing),!canary", labels)).toBe(true);
    expect(selects("app=shop-api,tier notin (web)", labels)).toBe(false);
    expect(selects("app=other", labels)).toBe(false);
  });
});

describe("overwatch_query windows", () => {
  test("a time that cannot be read is an error, not a silent default", () => {
    expect(queryWindow({}, NOW)).toEqual({ since: NOW - 3_600_000, until: NOW });
    expect(queryWindow({ since: "6h" }, NOW)).toEqual({ since: NOW - 6 * 3_600_000, until: NOW });
    expect(queryWindow({ since: "2026-11-25T09:00:00Z", until: "2026-11-25T10:00:00Z" }, NOW)).toEqual({
      since: Date.parse("2026-11-25T09:00:00Z"),
      until: Date.parse("2026-11-25T10:00:00Z"),
    });
    for (const garbage of ["yesterday", "last deploy", "6", "10:00", "2026-13-45", {}, true]) {
      const result = queryWindow({ since: garbage }, NOW);
      expect("error" in result && result.error).toContain("is not a time");
    }
    expect((queryWindow({ until: "noon" }, NOW) as { error: string }).error).toContain("until");
  });

  test("an empty or future window is refused; an until past now is brought back to now", () => {
    expect((queryWindow({ since: "1h", until: "2h" }, NOW) as { error: string }).error).toContain("window is empty");
    expect((queryWindow({ since: "2026-12-01T00:00:00Z" }, NOW) as { error: string }).error).toContain("in the future");
    expect(queryWindow({ since: "1h", until: "2026-12-01T00:00:00Z" }, NOW)).toEqual({ since: NOW - 3_600_000, until: NOW });
    expect(parseWhen("1795514400", NOW)).toBe(1795514400000);
  });
});

/** A fake cluster: `podCount` pods, each answering `kubectl logs` after `logDelayMs`. */
function cluster(input: { podCount: number; logDelayMs?: number; logs?: (pod: string, call: Call) => Partial<{ code: number; stdout: string; stderr: string; killed: boolean }>; extra?: (verb: string) => unknown }) {
  const podNames = Array.from({ length: input.podCount }, (_, i) => `shop-api-${i + 1}`);
  const stats = { inFlight: 0, maxInFlight: 0, logs: 0, pods: 0, events: 0 };
  const pod = (name: string) => ({
    metadata: { name, labels: { app: "shop-api" }, creationTimestamp: "2026-11-20T08:00:00Z", ownerReferences: [{ kind: "ReplicaSet", name: "shop-api-7d9f8" }] },
    spec: { nodeName: "node-a", containers: [{ name: "api", image: "registry.example/shop-api:9f8e7d6", resources: { limits: { cpu: "1", memory: "512Mi" } } }] },
    status: { phase: "Running", startTime: "2026-11-20T08:00:00Z", conditions: [{ type: "Ready", status: "True" }, { type: "PodScheduled", status: "True" }], containerStatuses: [{ name: "api", restartCount: 0, state: { running: {} } }] },
  });
  const exec = Object.assign(
    async (command: string, args: ReadonlyArray<string>, opts: Call["options"]) => {
      const call = { command, args, options: opts };
      exec.calls.push(call);
      const verb = args.slice(5).join(" ");
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", killed: false });
      if (verb.startsWith("get pods")) return stats.pods++, ok(JSON.stringify({ items: podNames.map(pod) }));
      if (verb.startsWith("get events")) return stats.events++, ok(JSON.stringify({ items: [] }));
      if (verb.startsWith("logs ")) {
        stats.logs++;
        stats.inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        await new Promise((resolve) => setTimeout(resolve, input.logDelayMs ?? 5));
        stats.inFlight--;
        const name = args[6]!;
        const answer = input.logs?.(name, call) ?? { stdout: `[pod/${name}/api] 2026-11-25T11:00:00Z ERROR payment 42 timed out` };
        return { code: 0, stdout: "", stderr: "", killed: false, ...answer };
      }
      const extra = input.extra?.(verb);
      if (extra !== undefined) return ok(typeof extra === "string" ? extra : JSON.stringify(extra));
      return { code: 1, stdout: "", stderr: "forbidden", killed: false };
    },
    { calls: [] as Call[] },
  );
  return { exec, stats, podNames };
}

describe("kubernetes: many pods do not stall a watcher", () => {
  test("logs of twelve pods are read a few at a time, not one after another", async () => {
    const { exec, stats } = cluster({ podCount: 12 });
    const ctx = sourceContext(runtime(config, { exec }), "shop-api", "production", "pods", new AbortController().signal);
    const result = await kubernetesSource.collect(sources.pods!, { window: WINDOW, final: false }, ctx);
    expect(stats.logs).toBe(12);
    expect(stats.maxInFlight).toBe(config.concurrency.sourceCalls);
    expect(result.signals.find((s) => s.kind === "log")!.total).toBe(12);
    expect(result.notes).toEqual([]);
  });

  test("each kubectl call gets the per-call limit, and kubectl is told the same limit", async () => {
    const { exec } = cluster({ podCount: 1 });
    const ctx = sourceContext(runtime(config, { exec }), "shop-api", "production", "pods", new AbortController().signal);
    await kubernetesSource.collect(sources.pods!, { window: WINDOW, final: false }, ctx);
    expect(exec.calls.every((c) => c.args[4] === "--request-timeout=60s" && c.options.timeoutMs === 62_000)).toBe(true);
  });

  test("when the slice runs out of time, what was read counts and the rest is reported, so the checkpoint moves", async () => {
    const { exec, stats } = cluster({ podCount: 12, logDelayMs: 80 });
    const rt = runtime(config, { exec });
    // 3.1s of budget against a 3s safety margin: time for the first few pods only.
    const ctx = sourceContext(rt, "shop-api", "production", "pods", new AbortController().signal, { deadline: Date.now() + 3_100 });
    const result = await kubernetesSource.collect(sources.pods!, { window: WINDOW, final: false }, ctx);
    expect(stats.logs).toBeGreaterThan(0);
    expect(stats.logs).toBeLessThan(12);
    expect(result.signals.find((s) => s.kind === "log")!.total).toBe(stats.logs);
    expect(result.notes.join("\n")).toContain(`logs of ${12 - stats.logs} of 12 pods`);
    expect(result.notes.join("\n")).toContain("ran out of time; raise timeouts.slice");
  });

  test("one unreadable pod is a reported gap; every pod unreadable is a failed source", async () => {
    const some = cluster({ podCount: 6, logs: (pod) => (pod === "shop-api-2" ? { code: 1, stderr: "error: context deadline exceeded" } : pod === "shop-api-3" ? { code: 1, stderr: 'pods "shop-api-3" not found' } : {}) });
    const ctx = sourceContext(runtime(config, { exec: some.exec }), "shop-api", "production", "pods", new AbortController().signal);
    const result = await kubernetesSource.collect(sources.pods!, { window: WINDOW, final: false }, ctx);
    expect(result.notes.join("\n")).toContain("logs of shop-api-2 from 2026-11-25T10:00:00Z were not read");
    expect(result.notes.join("\n")).toContain("shop-api-3 went away");

    const none = cluster({ podCount: 6, logs: () => ({ code: 1, stderr: "Unauthorized" }) });
    const ctx2 = sourceContext(runtime(config, { exec: none.exec }), "shop-api", "production", "pods", new AbortController().signal);
    await expect(kubernetesSource.collect(sources.pods!, { window: WINDOW, final: false }, ctx2)).rejects.toThrow("Unauthorized (and 5 more pods)");
  });

  test("a log cut short part way is used as far as it goes and reported", async () => {
    const { exec } = cluster({ podCount: 1, logs: (pod) => ({ code: 1, killed: true, stdout: `[pod/${pod}/api] 2026-11-25T11:00:00Z ERROR payment 42 timed out\n[pod/${pod}/api] 2026-11-25T11:0` }) });
    const ctx = sourceContext(runtime(config, { exec }), "shop-api", "production", "pods", new AbortController().signal);
    const result = await kubernetesSource.collect(sources.pods!, { window: WINDOW, final: false }, ctx);
    expect(result.signals.find((s) => s.kind === "log")!.total).toBe(1);
    expect(result.notes[0]).toContain("were cut short");
  });

  test("a catch-up over several slices lists pods and events once and downloads each pod's log once", async () => {
    const { exec, stats } = cluster({ podCount: 8 });
    const rt = runtime(config, { exec });
    const record = await runWatcher(rt, config.watchers[0]!);
    // First run: 24h back in 6h slices, so four slices of one source.
    expect(record.failedSources).toEqual([]);
    expect(stats.logs).toBe(8);
    expect(stats.events).toBe(1);
    expect(stats.pods).toBe(1);
    expect((await loadWatcher(rt.kv, "shop-api/production")).checkpoints.pods).toBe(rt.clock.now);
  });

  test("garbage from kubectl is a clear failure, never a crash on a field", async () => {
    const exec = fakeExec(({ args }) => (args.slice(5).join(" ").startsWith("get pods") ? { stdout: "<html>proxy sign-in</html>" } : undefined));
    const ctx = sourceContext(runtime(config, { exec }), "shop-api", "production", "pods", new AbortController().signal);
    await expect(kubernetesSource.collect(sources.pods!, { window: WINDOW, final: true }, ctx)).rejects.toThrow("kubectl get pods did not return JSON");
  });
});

describe("kubernetes: capacity that usage numbers alone miss", () => {
  const workloads = {
    items: [
      {
        kind: "Deployment",
        metadata: { name: "shop-api" },
        spec: { replicas: 4, template: { metadata: { labels: { app: "shop-api" } } } },
        status: { availableReplicas: 2, conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: 'ReplicaSet "shop-api-7d9f8" has timed out progressing.' }] },
      },
      { kind: "Deployment", metadata: { name: "billing" }, spec: { replicas: 9, template: { metadata: { labels: { app: "billing" } } } }, status: { availableReplicas: 0 } },
      {
        kind: "ReplicaSet",
        metadata: { name: "shop-api-7d9f8", creationTimestamp: "2026-11-25T09:58:00Z", annotations: { "deployment.kubernetes.io/revision": "7" }, ownerReferences: [{ kind: "Deployment", name: "shop-api" }] },
        spec: { template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{ image: "registry.example/shop-api:9f8e7d6" }] } } },
        status: { replicas: 4 },
      },
      {
        kind: "HorizontalPodAutoscaler",
        metadata: { name: "shop-api" },
        spec: { scaleTargetRef: { kind: "Deployment", name: "shop-api" }, minReplicas: 2, maxReplicas: 4 },
        status: { currentReplicas: 4, conditions: [{ type: "ScalingActive", status: "False", reason: "FailedGetResourceMetric", message: "unable to get metrics for resource cpu" }] },
      },
      { kind: "HorizontalPodAutoscaler", metadata: { name: "billing" }, spec: { scaleTargetRef: { kind: "Deployment", name: "billing" }, maxReplicas: 3 }, status: { currentReplicas: 3 } },
    ],
  };

  test("only the workloads behind the selector are read, with their autoscalers and ReplicaSets", () => {
    const parsed = parseWorkloads(JSON.stringify(workloads), "app=shop-api");
    expect(parsed.workloads.map((w) => [w.kind, w.name, w.desired, w.available])).toEqual([["Deployment", "shop-api", 4, 2]]);
    expect(parsed.autoscalers.map((a) => [a.name, a.current, a.max])).toEqual([["shop-api", 4, 4]]);
    expect(parsed.replicaSets.map((r) => [r.name, r.revision, r.replicas])).toEqual([["shop-api-7d9f8", 7, 4]]);
  });

  test("missing replicas, an autoscaler at its ceiling or blind, a stuck rollout, unschedulable pods and node pressure all surface", async () => {
    const { exec } = cluster({
      podCount: 2,
      extra: (verb) => {
        if (verb.startsWith("get deployments.apps")) return workloads;
        if (verb.startsWith("get nodes")) {
          return { kind: "Node", metadata: { name: "node-a" }, status: { conditions: [{ type: "Ready", status: "True" }, { type: "MemoryPressure", status: "True", message: "kubelet has insufficient memory available" }] } };
        }
        if (verb.startsWith("get resourcequota")) return { items: [] };
        return undefined;
      },
    });
    const pending = {
      metadata: { name: "shop-api-pending", labels: { app: "shop-api" }, creationTimestamp: "2026-11-25T11:00:00Z" },
      spec: { containers: [{ name: "api", image: "registry.example/shop-api:9f8e7d6" }] },
      status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/12 nodes are available: 12 Insufficient memory." }] },
    };
    const withPending: typeof exec = Object.assign(
      async (command: string, args: ReadonlyArray<string>, opts: Call["options"]) => {
        const result = await exec(command, args, opts);
        if (!args.slice(5).join(" ").startsWith("get pods")) return result;
        return { ...result, stdout: JSON.stringify({ items: [...JSON.parse(result.stdout).items, pending] }) };
      },
      { calls: exec.calls },
    );
    const ctx = sourceContext(runtime(config, { exec: withPending }), "shop-api", "production", "pods", new AbortController().signal);
    const result = await kubernetesSource.collect(sources.pods!, { window: WINDOW, final: true }, ctx);

    const samples = Object.fromEntries(result.samples.map((s) => [s.metric, s.value]));
    expect(samples).toMatchObject({ unavailable_replicas: 2, hpa_pct_of_max_replicas: 100, pending_pods: 1, not_ready_pods: 1 });
    const states = Object.fromEntries(result.signals.filter((s) => s.state).map((s) => [s.key, s]));
    expect(Object.keys(states).sort()).toEqual(["hpa:shop-api:blind", "node:node-a:MemoryPressure", "rollout:shop-api", "unschedulable"]);
    expect(states.unschedulable!.sample).toContain("0/12 nodes are available: 12 Insufficient memory.");
    expect(states["rollout:shop-api"]!.title).toBe("Rollout of shop-api is stuck");
    expect(result.capacity).toContain("deployment shop-api: 2 of 4 replicas available");
    expect(result.capacity).toContain("autoscaler shop-api (Deployment/shop-api): 4 replicas, min 2, max 4");
    // Every kubectl call stayed read-only and in the configured namespace.
    expect(exec.calls.every((c) => c.command === "kubectl" && ["get", "logs", "top"].includes(c.args[5]!) && c.args[3] === "shop")).toBe(true);
  });

  test("no pods and no workload for the selector is reported, not read as healthy", async () => {
    const { exec } = cluster({ podCount: 0, extra: (verb) => (verb.startsWith("get deployments.apps") ? { items: [] } : undefined) });
    const ctx = sourceContext(runtime(config, { exec }), "shop-api", "production", "pods", new AbortController().signal);
    const result = await kubernetesSource.collect(sources.pods!, { window: WINDOW, final: true }, ctx);
    expect(result.notes.join("\n")).toContain('no pods match "app=shop-api"');
  });

  test("a cluster that will not show workloads or nodes costs those checks only, and says so", async () => {
    const { exec } = cluster({ podCount: 2 });
    const ctx = sourceContext(runtime(config, { exec }), "shop-api", "production", "pods", new AbortController().signal);
    const result = await kubernetesSource.collect(sources.pods!, { window: WINDOW, final: true }, ctx);
    const notes = result.notes.join("\n");
    expect(notes).toContain("workloads and autoscalers unreadable (forbidden); replica and autoscaler capacity was not checked");
    expect(notes).toContain("node conditions unreadable (forbidden)");
    expect(result.samples.some((s) => s.metric === "unavailable_replicas")).toBe(false);
    expect(result.samples.some((s) => s.metric === "not_ready_pods")).toBe(true);
  });
});

describe("datadog: rate limits and gateway errors", () => {
  function datadog(answers: Array<Response | Error>) {
    const waits: number[] = [];
    let calls = 0;
    const fetch = (async () => {
      const answer = answers[Math.min(calls++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer.clone();
    }) as unknown as typeof globalThis.fetch;
    const rt = runtime(config, { fetch, sleep: async (ms) => void waits.push(ms) });
    const context = (source: string, deadline?: number) => sourceContext(rt, "shop-api", "production", source, new AbortController().signal, deadline ? { deadline } : {});
    return { waits, context, calls: () => calls };
  }
  const page = Response.json({ data: [{ id: "l1", attributes: { timestamp: "2026-11-25T10:01:00Z", status: "error", service: "shop-api", message: "db timeout" } }], meta: {} });

  test("a 429 waits as long as the response asks, then carries on", async () => {
    const dd = datadog([new Response("", { status: 429, headers: { "Retry-After": "7" } }), new Response("", { status: 429, headers: { "X-RateLimit-Reset": "3" } }), page]);
    const result = await datadogLogsSource.collect(sources.errors!, { window: WINDOW, final: true }, dd.context("errors"));
    expect(dd.waits).toEqual([7_000, 3_000]);
    expect(result.signals).toHaveLength(1);
    expect(retryAfterMs(new Headers({ "retry-after": "Wed, 25 Nov 2026 12:00:30 GMT" }), NOW)).toBe(30_000);
  });

  test("502, 503 and a dropped connection are retried with a growing wait", async () => {
    const dd = datadog([new Response("<html>Bad Gateway</html>", { status: 502 }), new Response("", { status: 503 }), new TypeError("fetch failed"), page]);
    const result = await datadogLogsSource.collect(sources.errors!, { window: WINDOW, final: true }, dd.context("errors"));
    expect(result.signals).toHaveLength(1);
    expect(dd.waits).toHaveLength(3);
    expect(dd.waits[0]! >= 800 && dd.waits[0]! <= 1_200).toBe(true);
    expect(dd.waits[2]! >= 3_200 && dd.waits[2]! <= 4_800).toBe(true);
  });

  test("it gives up after five tries, and the failure is a failure, not an empty result", async () => {
    const dd = datadog([new Response("", { status: 502 })]);
    await expect(datadogLogsSource.collect(sources.errors!, { window: WINDOW, final: true }, dd.context("errors"))).rejects.toThrow(
      "Datadog /api/v2/logs/events/search failed 5 times, last with HTTP 502",
    );
    expect(dd.calls()).toBe(5);
  });

  test("it never waits past the slice's time limit", async () => {
    const dd = datadog([new Response("", { status: 429, headers: { "Retry-After": "120" } })]);
    await expect(datadogLogsSource.collect(sources.errors!, { window: WINDOW, final: true }, dd.context("errors", Date.now() + 30_000))).rejects.toThrow(
      "HTTP 429 (rate limited); waiting 60s to retry would run past this slice's time limit",
    );
    expect(dd.waits).toEqual([]);
  });

  test("a bad key or a sign-in page is not retried", async () => {
    const denied = datadog([new Response('{"errors":["Forbidden"]}', { status: 403 })]);
    await expect(datadogLogsSource.collect(sources.errors!, { window: WINDOW, final: true }, denied.context("errors"))).rejects.toThrow("HTTP 403 (check the Datadog keys");
    expect(denied.calls()).toBe(1);
    const proxy = datadog([new Response("<html>Sign in</html>", { status: 200 })]);
    await expect(datadogLogsSource.collect(sources.errors!, { window: WINDOW, final: true }, proxy.context("errors"))).rejects.toThrow("is a proxy or sign-in page answering");
    expect(proxy.calls()).toBe(1);
  });

  test("logs, monitors and metrics tolerate other shapes of the same answer", async () => {
    const logs = datadog([
      Response.json({
        data: [
          { id: "a", attributes: { timestamp: 1795514460000, status: "ERROR", service: "shop-api", message: { text: "db timeout" } } },
          { id: "b", attributes: { attributes: { "@timestamp": "2026-11-25T10:02:00Z", level: "Warn", msg: "slow query" } } },
          { id: "c", attributes: { status: "error", message: "no time at all" } },
          "not an event",
        ],
        meta: { page: {} },
      }),
    ]);
    const window = { from: 0, to: NOW };
    const result = await datadogLogsSource.collect(sources.errors!, { window, final: true }, logs.context("errors"));
    expect(result.signals.map((s) => [s.severity, s.occurrences.length])).toEqual([["error", 1], ["warn", 1]]);
    expect(result.notes).toEqual(["errors: 1 log(s) had no readable timestamp and were not counted"]);

    const monitors = datadog([Response.json({ monitors: [{ id: 7, name: "API 5xx", overallState: "NO DATA", overall_state_modified: 1795514400 }, { id: 8, name: "ok", overall_state: "OK" }, null] })]);
    const states = await datadogMonitorsSource.collect(sources.monitors!, { window, final: true }, monitors.context("monitors"));
    expect(states.signals.map((s) => [s.key, s.title])).toEqual([["monitor:7", "API 5xx is NO DATA"]]);

    const metrics = datadog([Response.json({ series: [{ pointlist: [[1795514400000, 1], [1795514460000, null]] }, { pointlist: [[1795514400000, "3.5"], "junk"] }] })]);
    const series = await datadogMetricsSource.collect(sources.latency!, { window, final: true }, metrics.context("latency"));
    expect(series.samples).toEqual([{ metric: "p95", at: 1795514400000, value: 3.5 }]);
    expect(series.notes[0]).toContain("returned 2 series");

    const rejected = datadog([Response.json({ status: "error", error: "Rule of 0 violated" })]);
    await expect(datadogMetricsSource.collect(sources.latency!, { window, final: true }, rejected.context("latency"))).rejects.toThrow("Datadog rejected the metric query");
  });
});
