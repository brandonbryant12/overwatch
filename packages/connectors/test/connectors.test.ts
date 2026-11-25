import { describe, expect, test } from "bun:test";
import {
  classifyKubectlError,
  diffTraceTrees,
  generateDemoFleetSnapshots,
  redactText,
  redactValue,
  runReadOnlyKubectl,
  scoreExplorationCandidate,
} from "../src/index.ts";

describe("Connector Security, Redaction & Trace-Diff Contracts", () => {
  test("Two-pass Redactor scrubs Bearer, JWT, AWS keys, GitHub PATs, DSN passwords, and sensitive keys", () => {
    const raw = [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abc1234567890",
      "aws_access_key=AKIAIOSFODNN7EXAMPLE",
      "github=ghp_1234567890abcdefghijklmnop",
      "db=postgres://admin:superSecretPass99@db.internal:5432/checkout",
      "DD-API-KEY: abcdef1234567890",
      "Cookie: session=xyz987654",
    ].join("\n");

    const scrubbed = redactText(raw);
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(scrubbed).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(scrubbed).not.toContain("ghp_1234567890abcdefghijklmnop");
    expect(scrubbed).not.toContain("superSecretPass99");
    expect(scrubbed).not.toContain("abcdef1234567890");
    expect(scrubbed).not.toContain("xyz987654");
    expect(scrubbed).toContain("[REDACTED:");

    const structured = redactValue({
      ok: true,
      nested: {
        api_key: "secret-val-123",
        safe: "hello",
      },
    });
    expect(structured.nested.api_key).toBe("[REDACTED:sensitive_field]");
    expect(structured.nested.safe).toBe("hello");
  });

  test("Redactor enforces bounded byte cap truncation", () => {
    const huge = "x".repeat(50_000);
    const bounded = redactText(huge, { maxBytes: 1024 });
    expect(bounded.length).toBeLessThan(1200);
    expect(bounded).toContain("[TRUNCATED:");
  });

  test("Kubernetes connector hard-denies mutating verbs", async () => {
    await expect(
      runReadOnlyKubectl(
        { context: "eks-prod", namespace: "checkout", selector: "app=checkout-api" },
        "delete",
        ["pod/foo"],
      ),
    ).rejects.toThrow("hard-denied");
  });

  test("Kubernetes error classifier distinguishes auth_expired vs unreachable", () => {
    expect(classifyKubectlError("Error: You must be logged in to the server (Unauthorized)").coverage).toBe(
      "auth_expired",
    );
    expect(classifyKubectlError("Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout").coverage).toBe(
      "unreachable",
    );
  });

  test("Datadog paired trace-tree diff flags N+1 fan-out and self-time delta", () => {
    const diff = diffTraceTrees({
      route: "POST /v1/checkout/confirm",
      releaseVersion: "9f31c2a",
      slowTraces: [
        {
          traceId: "t_slow",
          spans: Array.from({ length: 20 }, (_, i) => ({
            traceId: "t_slow",
            spanId: `s${i}`,
            operation: "pg.query",
            resource: "SELECT * FROM items WHERE cart_id = $1",
            durationMs: 30,
            tags: { pod_name: "checkout-new-1" },
          })),
        },
      ],
      medianTraces: [
        {
          traceId: "t_med",
          spans: [
            {
              traceId: "t_med",
              spanId: "m0",
              operation: "pg.query",
              resource: "SELECT * FROM items WHERE cart_id = $1",
              durationMs: 25,
              tags: { pod_name: "checkout-old-1" },
            },
          ],
        },
      ],
    });
    expect(diff.spans[0]?.nPlusOneSuspect).toBe(true);
    expect(diff.spans[0]?.deltaMs).toBe(575);
    expect(diff.spans[0]?.slowCallCount).toBe(20);
    expect(diff.spans[0]?.medianCallCount).toBe(1);
  });

  test("Exploration frontier scorer prioritizes stale high-tail recent-deploy routes", () => {
    const hot = scoreExplorationCandidate({
      cohort: {
        route: "POST /checkout",
        service: "checkout-api",
        p50Ms: 200,
        p95Ms: 2000,
        p99Ms: 3000,
        errorRatePct: 1.5,
        wowDeltaPct: 120,
        rpm: 1500,
      },
      hoursSinceLastExplored: 24,
      recentDeploy: true,
    });
    const cold = scoreExplorationCandidate({
      cohort: {
        route: "GET /health",
        service: "checkout-api",
        p50Ms: 10,
        p95Ms: 15,
        p99Ms: 20,
        errorRatePct: 0,
        wowDeltaPct: 0,
        rpm: 100,
      },
      hoursSinceLastExplored: 2,
      recentDeploy: false,
    });
    expect(hot).toBeGreaterThan(cold * 10);
  });

  test("Demo fleet generator yields multi-env snapshots with degraded staging coverage and evidence blobs", () => {
    const demo = generateDemoFleetSnapshots();
    expect(demo.snapshots.length).toBeGreaterThanOrEqual(5);
    const staging = demo.snapshots.find((s) => s.envKey === "checkout-api:staging");
    expect(staging?.coverage).toBe("auth_expired");
    expect(demo.evidence.length).toBeGreaterThanOrEqual(5);
  });
});
