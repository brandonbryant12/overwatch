import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  collectDatadogMetrics,
  datadogMetricQueries,
  EnvSecretVaultLive,
  latestDatadogPoint,
  type DatadogEnvConfig,
} from "../src/index.ts";

const config: DatadogEnvConfig = {
  site: "datadoghq.com",
  apiKey: "env:OW_TEST_DD_API",
  appKey: "env:OW_TEST_DD_APP",
  indexes: ["main"],
  service: "checkout-api",
  env: "prod",
};

const seriesBody = (value: number | null) => ({
  status: "ok",
  series: [{ pointlist: [[1_764_000_000_000, 0.5], [1_764_000_060_000, value]] }],
});

function fakeDatadog(values: Record<string, number | null | "empty" | number>, status = 200) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (status !== 200) return new Response("nope", { status });
    const query = decodeURIComponent(new URL(url).searchParams.get("query") ?? "");
    const key = Object.keys(values).find((k) => query.startsWith(k));
    const value = key ? values[key] : "empty";
    return Response.json(value === "empty" ? { status: "ok", series: [] } : seriesBody(value as number | null));
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const run = (fetchImpl: typeof fetch) => {
  process.env.OW_TEST_DD_API = "api-secret-value";
  process.env.OW_TEST_DD_APP = "app-secret-value";
  return Effect.runPromise(
    collectDatadogMetrics(config, { nowMs: 1_764_000_100_000, fetchImpl }).pipe(Effect.provide(EnvSecretVaultLive)),
  );
};

describe("Datadog service metrics", () => {
  test("default queries follow APM naming and can be overridden per metric", () => {
    expect(datadogMetricQueries(config).p95LatencySeconds).toBe(
      "p95:trace.http.request{service:checkout-api,env:prod}",
    );
    const custom = datadogMetricQueries({
      ...config,
      apmOperation: "express.request",
      metricQueries: { hitsPerSecond: "sum:my.hits{*}.as_rate()" },
    });
    expect(custom.p50LatencySeconds).toContain("trace.express.request");
    expect(custom.hitsPerSecond).toBe("sum:my.hits{*}.as_rate()");
  });

  test("takes the latest non-null point", () => {
    expect(latestDatadogPoint(seriesBody(null))).toEqual({ tsMs: 1_764_000_000_000, value: 0.5 });
    expect(latestDatadogPoint({ series: [] })).toBeUndefined();
    expect(latestDatadogPoint(undefined)).toBeUndefined();
  });

  test("converts seconds to milliseconds and errors to a percentage", async () => {
    const { fetchImpl, seen } = fakeDatadog({ "p50:": 0.12, "p95:": 2.15, "sum:trace.http.request.hits": 400, "sum:trace.http.request.errors": 8 });
    const result = await run(fetchImpl);
    expect(result).toEqual({
      ok: true,
      metrics: { tsMs: 1_764_000_100_000, p50LatencyMs: 120, p95LatencyMs: 2150, errorRatePct: 2, rps: 400 },
    });
    expect(seen).toHaveLength(4);
    expect(seen[0]!.url).toContain("https://api.datadoghq.com/api/v1/query?from=1763999800&to=1764000100");
    // Credentials travel in headers only, never in the URL.
    expect(seen.every((s) => !s.url.includes("secret"))).toBe(true);
    expect(seen[0]!.headers["dd-api-key"]).toBe("api-secret-value");
  });

  test("no error series means zero errors, but missing latency is lost coverage", async () => {
    const quiet = await run(fakeDatadog({ "p50:": 0.1, "p95:": 0.3, "sum:trace.http.request.hits": 50 }).fetchImpl);
    expect(quiet.ok && quiet.metrics.errorRatePct).toBe(0);

    const blind = await run(fakeDatadog({ "sum:trace.http.request.hits": 50 }).fetchImpl);
    expect(blind).toMatchObject({ ok: false, coverage: "unreachable" });
  });

  test("maps HTTP failures to coverage states", async () => {
    expect(await run(fakeDatadog({}, 403).fetchImpl)).toMatchObject({ ok: false, coverage: "auth_expired" });
    expect(await run(fakeDatadog({}, 429).fetchImpl)).toMatchObject({ ok: false, coverage: "rate_limited" });
    expect(await run(fakeDatadog({}, 500).fetchImpl)).toMatchObject({ ok: false, coverage: "unreachable" });
  });
});

describe("Redaction keeps prose readable", () => {
  test("credential-shaped values are scrubbed, ordinary sentences are not", async () => {
    const { redactText } = await import("../src/index.ts");
    expect(redactText("EKS SSO token expired for eks-staging-us-east-1")).toBe(
      "EKS SSO token expired for eks-staging-us-east-1",
    );
    expect(redactText("falling back to basic auth")).toBe("falling back to basic auth");
    const bearer = redactText("sent Bearer abcdefghijklmnopqrstuvwxyz012345 upstream");
    expect(bearer).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    const short = redactText("Authorization: Basic YTpi");
    expect(short).not.toContain("YTpi");
  });
});
