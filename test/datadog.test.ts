/**
 * Datadog through the service: logs and monitors read by the collector with a fake Datadog, to incidents. The keys
 * are secret references resolved at run time; they go in request headers and nowhere else.
 */
import { startService } from "../src/service/service.ts";
import { parseConfig } from "../src/service/config.ts";
import { fakeCluster } from "./fixtures/cluster.ts";
import { tempDir } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

describe("Datadog through the service", () => {
  test("error logs and an alerting monitor become incidents; a second poll counts nothing twice; keys stay out of storage", async () => {
    process.env.OW_TEST_DD_API_KEY = "ddapikey-not-a-real-value-1234";
    process.env.OW_TEST_DD_APP_KEY = "ddappkey-not-a-real-value-5678";
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (url.includes("/api/v2/logs/events/search")) {
        return Response.json({
          data: [
            { id: "l1", attributes: { timestamp: iso(now - 10 * 60_000), status: "error", service: "shop-api", message: "payment 42 timed out after 300ms" } },
            { id: "l2", attributes: { timestamp: iso(now - 9 * 60_000), status: "error", service: "shop-api", message: "payment 43 timed out after 300ms" } },
          ],
          meta: {},
        });
      }
      if (url.includes("/api/v1/monitor")) {
        return Response.json([{ id: 101, name: "checkout p95 latency", overall_state: "Alert", overall_state_modified: iso(now - 5 * 60_000), query: "avg(last_5m):p95:checkout.latency{*} > 2" }]);
      }
      return new Response("not faked", { status: 404 });
    }) as typeof globalThis.fetch;
    const config = parseConfig({
      apps: {
        "shop-api": {
          checkout: "/nonexistent",
          environments: {
            production: {
              sources: {
                errors: { type: "datadog-logs", query: "service:shop-api status:error" },
                monitors: { type: "datadog-monitors", tags: ["service:shop-api"] },
              },
            },
          },
        },
      },
      watchers: [{ app: "shop-api", environment: "production" }],
      datadog: { apiKey: "env:OW_TEST_DD_API_KEY", appKey: "env:OW_TEST_DD_APP_KEY", apiUrl: "http://datadog.test" },
      dataDir: tempDir("datadog"),
      lookback: { initial: "1h", slice: "1h" },
      opencode: { autoInvestigate: false },
    });
    expect(config.errors).toEqual([]);
    const service = await startService(config, { exec: fakeCluster().exec, fetch, port: 0, background: false, log: () => undefined, notify: async () => undefined });
    try {
      await service.collect("shop-api/production");
      await service.collect("shop-api/production");
      const journal = await service.read((db) => db.prepare("SELECT type, data FROM journal ORDER BY position").all() as Array<{ type: string; data: string }>);
      const opened = journal.filter((e) => e.type === "IncidentOpened").map((e) => JSON.parse(e.data));
      expect(opened.map((e) => e.source).sort()).toEqual(["errors", "monitors"]);
      const logs = opened.find((e) => e.source === "errors");
      expect(logs.count).toBe(2);
      expect(opened.find((e) => e.source === "monitors").title).toBe("checkout p95 latency is Alert");
      // The logs were counted once: the second poll's overlap re-read them and added nothing.
      const recurred = journal.filter((e) => e.type === "SignalRecurred").map((e) => JSON.parse(e.data));
      expect(recurred.filter((e) => e.sample?.includes("timed out")).length).toBe(0);
      // The keys reached Datadog in headers, and nothing Overwatch stored.
      expect(calls.some((c) => c.headers["dd-api-key"] === process.env.OW_TEST_DD_API_KEY)).toBe(true);
      const stored = await service.read((db) => ["journal", "objects", "pending_reports", "checkpoints", "coverage", "search_docs"].map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join(""));
      expect(stored).not.toContain("not-a-real-value");
    } finally {
      await service.stop();
    }
  });
});
