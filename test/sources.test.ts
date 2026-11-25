import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseOptions } from "../src/options.ts";
import { sourceContext, validateSources } from "../src/runtime.ts";
import { datadogLogsSource, datadogMonitorsSource } from "../src/sources/datadog.ts";
import {
  checkKubectlArgs,
  kubernetesSource,
  parseCpu,
  parseMemory,
  parseLogLine,
  parsePods,
  revisionsOf,
  usageSamples,
} from "../src/sources/kubernetes.ts";
import { fakeExec, options, runtime } from "./helpers.ts";

const WINDOW = { from: Date.parse("2026-11-25T10:00:00Z"), to: Date.parse("2026-11-25T12:00:00Z") };

const config = options({
  apps: {
    "shop-api": {
      checkout: "/tmp/shop-api",
      environments: {
        production: {
          sources: {
            pods: { type: "kubernetes", context: "prod-cluster", namespace: "shop", selector: "app=shop-api", workload: "shop-api" },
            errors: { type: "datadog-logs", query: "service:shop-api status:error", indexes: ["main"] },
            monitors: { type: "datadog-monitors", tags: ["service:shop-api"] },
          },
        },
      },
    },
  },
  datadog: { apiKey: "env:OW_TEST_DD_API", appKey: "env:OW_TEST_DD_APP", apiUrl: "http://datadog.test" },
});

const pod = (name: string, overrides: Record<string, unknown> = {}) => ({
  metadata: { name, labels: { app: "shop-api", "app.kubernetes.io/version": "abc1234" }, annotations: {} },
  spec: {
    nodeName: "node-a",
    containers: [{ name: "api", image: "registry.example/shop-api:9f8e7d6", resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } } }],
  },
  status: {
    startTime: "2026-11-25T08:00:00Z",
    conditions: [{ type: "Ready", status: "True" }],
    containerStatuses: [{ name: "api", restartCount: 1, lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-11-25T11:00:00Z" } }, state: { running: {} } }],
  },
  ...overrides,
});

describe("kubectl is read-only", () => {
  test("only get, describe, logs and top run", () => {
    for (const verb of ["delete", "apply", "patch", "scale", "rollout", "exec", "edit", "cp", "drain", "label"]) {
      expect(() => checkKubectlArgs(verb, [])).toThrow("not allowed");
    }
    for (const verb of ["get", "describe", "logs", "top"]) expect(() => checkKubectlArgs(verb, ["pods"])).not.toThrow();
  });

  test("context, namespace, identity and raw access cannot be overridden, and secrets cannot be read", () => {
    for (const flag of ["--context=other", "--namespace", "-n", "--kubeconfig=x", "--as=admin", "--token=x", "-A", "--all-namespaces", "--raw"]) {
      expect(() => checkKubectlArgs("get", ["pods", flag])).toThrow("not allowed");
    }
    expect(() => checkKubectlArgs("get", ["secrets"])).toThrow("secrets");
    expect(() => checkKubectlArgs("describe", ["secret/db"])).toThrow("secrets");
    expect(() => checkKubectlArgs("get", ["pods,secrets"])).toThrow("secrets");
  });
});

describe("kubernetes source", () => {
  test("quantities parse", () => {
    expect(parseCpu("250m")).toBe(250);
    expect(parseCpu("1")).toBe(1000);
    expect(parseCpu("1500000n")).toBe(1.5);
    expect(parseMemory("512Mi")).toBe(512 * 1024 ** 2);
    expect(parseMemory("1G")).toBe(1e9);
    expect(parseMemory("lots")).toBeUndefined();
  });

  test("usage is measured against each container's own requests and limits, never assumed ones", () => {
    const pods = parsePods(JSON.stringify({ items: [pod("shop-api-1"), pod("shop-api-2", { spec: { containers: [{ name: "api", image: "x:1", resources: {} }] } })] }));
    const { samples, notes } = usageSamples(
      pods,
      [
        { pod: "shop-api-1", container: "api", cpu: 500, memory: 480 * 1024 ** 2 },
        { pod: "shop-api-2", container: "api", cpu: 900, memory: 900 * 1024 ** 2 },
      ],
      1,
    );
    expect(Object.fromEntries(samples.map((s) => [s.metric, s.value]))).toEqual({
      cpu_pct_of_limit: 50,
      memory_pct_of_limit: 93.75,
      cpu_pct_of_request: 200,
      memory_pct_of_request: 187.5,
    });
    expect(notes).toEqual(["api has no cpu limit", "api has no memory limit"]);
  });

  test("revisions come from the image tag or a configured label", () => {
    const pods = parsePods(JSON.stringify({ items: [pod("a"), pod("b")] }));
    expect(revisionsOf(pods)).toEqual(["9f8e7d6"]);
    expect(revisionsOf(pods, "label:app.kubernetes.io/version")).toEqual(["abc1234"]);
  });

  test("log lines parse with prefix, timestamp and JSON bodies", () => {
    expect(parseLogLine('[pod/shop-api-1/api] 2026-11-25T11:00:00.5Z {"level":"error","msg":"db timeout"}')).toEqual({
      at: Date.parse("2026-11-25T11:00:00.5Z"),
      message: "error db timeout",
      container: "api",
    });
    expect(parseLogLine("not a log line")).toBeUndefined();
  });

  test("collect reads pods, warning events, logs, top, nodes and quotas with the configured context and namespace", async () => {
    const exec = fakeExec(({ args }) => {
      const verb = args.slice(5).join(" ");
      expect(args.slice(0, 5)).toEqual(["--context", "prod-cluster", "--namespace", "shop", "--request-timeout=20s"]);
      if (verb.startsWith("get pods")) return { stdout: JSON.stringify({ items: [pod("shop-api-1")] }) };
      if (verb.startsWith("get events")) {
        return {
          stdout: JSON.stringify({
            items: [
              { metadata: { uid: "e1" }, reason: "BackOff", message: "Back-off restarting failed container", count: 3, lastTimestamp: "2026-11-25T11:30:00Z", involvedObject: { kind: "Pod", name: "shop-api-1" } },
              { metadata: { uid: "e2" }, reason: "BackOff", message: "other app", count: 1, lastTimestamp: "2026-11-25T11:30:00Z", involvedObject: { kind: "Pod", name: "billing-1" } },
              { metadata: { uid: "e3" }, reason: "BackOff", message: "too old", count: 1, lastTimestamp: "2026-11-24T11:30:00Z", involvedObject: { kind: "Pod", name: "shop-api-1" } },
            ],
          }),
        };
      }
      if (verb.startsWith("logs shop-api-1")) {
        expect(verb).toContain("--since-time=2026-11-25T10:00:00Z");
        return {
          stdout: [
            "[pod/shop-api-1/api] 2026-11-25T10:05:00Z ERROR payment 42 timed out after 3000ms",
            "[pod/shop-api-1/api] 2026-11-25T10:06:00Z ERROR payment 77 timed out after 3000ms",
            "[pod/shop-api-1/api] 2026-11-25T10:07:00Z INFO all good",
            "[pod/shop-api-1/api] 2026-11-25T12:30:00Z ERROR after the window",
          ].join("\n"),
        };
      }
      if (verb.startsWith("top pods")) return { stdout: "shop-api-1 api 900m 500Mi\n" };
      if (verb.startsWith("top nodes")) return { stdout: "node-a 1200m 60% 6000Mi 75%\nnode-b 10m 1% 10Mi 1%\n" };
      if (verb.startsWith("get resourcequota")) {
        return { stdout: JSON.stringify({ items: [{ metadata: { name: "q" }, status: { hard: { "limits.memory": "2Gi" }, used: { "limits.memory": "1536Mi" } } }] }) };
      }
      return undefined;
    });
    const rt = runtime(config, { exec });
    const ctx = sourceContext(rt, "shop-api", "production", "pods", new AbortController().signal);
    const result = await kubernetesSource.collect(config.apps["shop-api"]!.environments.production!.sources.pods!, { window: WINDOW, final: true }, ctx);

    const byKind = (kind: string) => result.signals.filter((s) => s.kind === kind);
    expect(byKind("event")).toHaveLength(1);
    expect(byKind("event")[0]!.occurrences).toEqual([{ at: Date.parse("2026-11-25T11:30:00Z"), id: "e1:3" }]);
    expect(byKind("log")).toHaveLength(1);
    expect(byKind("log")[0]!.total).toBe(2);
    expect(byKind("pod").map((s) => s.title)).toEqual(["api container OOMKilled (exit 137)"]);
    const samples = Object.fromEntries(result.samples.map((s) => [s.metric, s.value]));
    expect(samples).toMatchObject({ not_ready_pods: 0, cpu_pct_of_limit: 90, node_memory_pct_of_allocatable: 75, quota_limits_memory_pct: 75 });
    expect(samples.memory_pct_of_limit).toBeCloseTo(97.66, 1);
    expect(result.revisions).toEqual(["9f8e7d6"]);
    expect(result.capacity).toContain("node node-a: cpu 60% / memory 75% of allocatable");
    expect(exec.calls.every((c) => c.command === "kubectl" && ["get", "logs", "top"].includes(c.args[5]!))).toBe(true);
  });

  test("an unreachable cluster fails the collection instead of looking healthy", async () => {
    const exec = fakeExec(() => ({ code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" }));
    const ctx = sourceContext(runtime(config, { exec }), "shop-api", "production", "pods", new AbortController().signal);
    await expect(kubernetesSource.collect(config.apps["shop-api"]!.environments.production!.sources.pods!, { window: WINDOW, final: true }, ctx)).rejects.toThrow("get pods failed");
  });
});

describe("datadog sources", () => {
  process.env.OW_TEST_DD_API = "fake-api";
  process.env.OW_TEST_DD_APP = "fake-app";

  test("log search covers exactly the window, uses the configured indexes, pages, and groups", async () => {
    const bodies: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("http://datadog.test/api/v2/logs/events/search");
      expect((init.headers as Record<string, string>)["DD-API-KEY"]).toBe("fake-api");
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const page = body.page.cursor ? 2 : 1;
      const log = (id: string, ts: string, message: string) => ({ id, attributes: { timestamp: ts, status: "error", service: "shop-api", message } });
      return Response.json(
        page === 1
          ? { data: [log("l1", "2026-11-25T10:01:00Z", "db timeout after 3000ms"), log("l2", "2026-11-25T10:02:00Z", "db timeout after 2900ms")], meta: { page: { after: "next" } } }
          : { data: [log("l3", "2026-11-25T11:00:00Z", "card declined for order 9")], meta: {} },
      );
    }) as unknown as typeof globalThis.fetch;
    const ctx = sourceContext(runtime(config, { fetch }), "shop-api", "production", "errors", new AbortController().signal);
    const result = await datadogLogsSource.collect(config.apps["shop-api"]!.environments.production!.sources.errors!, { window: WINDOW, final: true }, ctx);
    expect(bodies[0].filter).toEqual({ query: "service:shop-api status:error", from: "2026-11-25T10:00:00Z", to: "2026-11-25T12:00:00Z", indexes: ["main"] });
    expect(bodies).toHaveLength(2);
    expect(result.signals.map((s) => [s.total, s.occurrences.map((o) => o.id)])).toEqual([
      [2, ["l1", "l2"]],
      [1, ["l3"]],
    ]);
  });

  test("monitors are read as current state in the newest slice only", async () => {
    let calls = 0;
    const fetch = (async (url: string) => {
      calls++;
      expect(url).toContain("monitor_tags=service%3Ashop-api");
      return Response.json([
        { id: 1, name: "API 5xx", overall_state: "Alert", overall_state_modified: "2026-11-25T11:00:00Z", query: "sum:errors{*} > 5" },
        { id: 2, name: "Latency", overall_state: "OK", query: "avg:latency{*} > 1" },
      ]);
    }) as unknown as typeof globalThis.fetch;
    const ctx = sourceContext(runtime(config, { fetch }), "shop-api", "production", "monitors", new AbortController().signal);
    const monitors = config.apps["shop-api"]!.environments.production!.sources.monitors!;
    expect((await datadogMonitorsSource.collect(monitors, { window: WINDOW, final: false }, ctx)).signals).toEqual([]);
    const result = await datadogMonitorsSource.collect(monitors, { window: WINDOW, final: true }, ctx);
    expect(calls).toBe(1);
    expect(result.signals.map((s) => [s.title, s.state])).toEqual([["API 5xx is Alert", true]]);
  });

  test("an HTTP error is a failure, not an empty result", async () => {
    const fetch = (async () => new Response("", { status: 403 })) as unknown as typeof globalThis.fetch;
    const ctx = sourceContext(runtime(config, { fetch }), "shop-api", "production", "errors", new AbortController().signal);
    await expect(datadogLogsSource.collect(config.apps["shop-api"]!.environments.production!.sources.errors!, { window: WINDOW, final: true }, ctx)).rejects.toThrow("HTTP 403");
  });
});

describe("options", () => {
  test("the shipped example config parses without errors", () => {
    const raw = Bun.JSONC.parse(readFileSync(new URL("../examples/opencode.jsonc", import.meta.url), "utf8")) as any;
    const parsed = parseOptions(raw.plugins[0].options);
    expect([...parsed.errors, ...validateSources(parsed.options)]).toEqual([]);
    expect(parsed.options.watchers.map((w) => [w.id, w.everyMs, w.fix])).toEqual([
      ["shop-api/production", 15 * 60_000, true],
      ["shop-api/staging", 60 * 60_000, false],
    ]);
    expect(parsed.options.lookback).toEqual({ initialMs: 86_400_000, maxMs: 14 * 86_400_000, overlapMs: 120_000, sliceMs: 6 * 3_600_000 });
  });

  test("mistakes are reported, not thrown", () => {
    const parsed = parseOptions({
      apps: { a: { environments: { prod: { sources: { x: { type: "nope" } } } } } },
      watchers: [{ app: "a", environment: "dev", every: "soon" }],
      datadog: { apiKey: "plain-text-key", appKey: "env:X" },
    });
    const errors = [...parsed.errors, ...validateSources(parsed.options)];
    expect(errors.some((e) => e.includes("checkout"))).toBe(true);
    expect(errors.some((e) => e.includes('"dev" is not an environment'))).toBe(true);
    expect(errors.some((e) => e.includes("every must be a duration"))).toBe(true);
    expect(errors.some((e) => e.includes("datadog keys"))).toBe(true);
    expect(errors.some((e) => e.includes('unknown type "nope"'))).toBe(true);
  });

  test("there are no budget or spend settings", () => {
    const parsed = parseOptions({});
    expect(JSON.stringify(parsed.options)).not.toMatch(/budget|spend|cost|usd|dollar/i);
  });
});
