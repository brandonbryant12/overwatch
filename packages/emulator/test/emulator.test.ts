import { describe, expect, test } from "bun:test";
import { startOverwatchEmulatorStack } from "../src/index.ts";

describe("Overwatch Stateful Local Emulator Stack (vercel-labs/emulate)", () => {
  test("Emulates K8s pods/logs, Datadog paired trace diffs, Jenkins builds, GitHub issues, and live recovery deploy", async () => {
    const stack = await startOverwatchEmulatorStack();
    try {
      // 1. Kubernetes: prod pods healthy-coverage with OOMKilled restart, staging auth_expired (401)
      const k8sProd = (await (
        await fetch(`${stack.kubernetesUrl}/api/v1/namespaces/checkout/pods`)
      ).json()) as { items: Array<any> };
      expect(k8sProd.items.length).toBe(3);

      const k8sStaging = await fetch(`${stack.kubernetesUrl}/api/v1/namespaces/checkout-staging/pods`);
      expect(k8sStaging.status).toBe(401);

      const podLogs = await (
        await fetch(`${stack.kubernetesUrl}/api/v1/namespaces/checkout/pods/checkout-api-9f31c2a-7b4d/log`)
      ).text();
      expect(podLogs).toContain("46 sequential pg.query calls");

      // 2. Datadog: paired trace-diff exposes N+1 regression on rev-482
      const traceDiff = (await (
        await fetch(`${stack.datadogUrl}/api/v1/overwatch/trace-diff`)
      ).json()) as { spans: Array<{ operation: string; nPlusOneSuspect: boolean; slowCallCount: number }> };
      const dbSpan = traceDiff.spans.find((s) => s.operation === "pg.query");
      expect(dbSpan?.nPlusOneSuspect).toBe(true);
      expect(dbSpan?.slowCallCount).toBe(46);

      // 3. Jenkins: real /api/json format reports build #482 commit 9f31c2a
      const jk = (await (
        await fetch(`${stack.jenkinsUrl}/job/payments/job/checkout-api/job/main/api/json`)
      ).json()) as { builds: Array<{ number: number }> };
      expect(jk.builds[0]?.number).toBe(482);

      // 4. Official vercel-labs/emulate stateful GitHub API: create an issue and read it back
      const createIssue = await fetch(
        `${stack.githubUrl}/repos/${stack.githubRepo}/issues`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${stack.githubToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: "Fix N+1 promo tier query (INC-42)",
            body: "<!-- overwatch-action-id: act-emu-42 -->",
          }),
        },
      );
      expect(createIssue.status).toBe(201);
      const issue = (await createIssue.json()) as { number: number; title: string };
      expect(issue.number).toBeGreaterThanOrEqual(1);

      // 5. Deploy fixed build #483 across Jenkins -> K8s -> Datadog and verify clean telemetry!
      const deployed = await stack.deployRelease({
        commitSha: "7e88f2c11223344556677889900aabbccddeeff0",
        commitMessage: "fix(promos): batch cart_line_items tier lookup with single IN query",
        healthy: true,
      });
      expect(deployed.buildNumber).toBe(483);

      const postMetrics = (await (
        await fetch(`${stack.datadogUrl}/api/v1/overwatch/metrics`)
      ).json()) as { degraded: boolean; p95LatencyMs: number };
      expect(postMetrics.degraded).toBe(false);
      expect(postMetrics.p95LatencyMs).toBeLessThan(600);

      const postTrace = (await (
        await fetch(`${stack.datadogUrl}/api/v1/overwatch/trace-diff`)
      ).json()) as { spans: Array<{ nPlusOneSuspect: boolean }> };
      expect(postTrace.spans.every((s) => !s.nPlusOneSuspect)).toBe(true);
    } finally {
      await stack.close();
    }
  }, 15_000);
});
