import { defineEmulator } from "emulate";
import { diffTraceTrees, type RawSpan } from "@overwatch/connectors";

export interface DatadogEmulatorState {
  validApiKey: string;
  degraded: boolean;
  releaseVersion: string;
  p50Ms: number;
  p95Ms: number;
  errorRatePct: number;
  logs: Array<{
    id: string;
    timestamp: string;
    service: string;
    env: string;
    status: "info" | "warn" | "error";
    message: string;
    attributes: Record<string, unknown>;
  }>;
}

export function initialDatadogState(): DatadogEmulatorState {
  const now = new Date().toISOString();
  return {
    validApiKey: "dd-emulated-key",
    degraded: true,
    releaseVersion: "9f31c2a",
    p50Ms: 410,
    p95Ms: 2150,
    errorRatePct: 1.84,
    logs: [
      {
        id: "log-1",
        timestamp: now,
        service: "checkout-api",
        env: "prod",
        status: "error",
        message: "POST /v1/checkout/confirm timed out after 46 sequential pg.query calls on rev-482",
        attributes: { revision: "rev-482", commit: "9f31c2a", duration_ms: 2180 },
      },
      {
        id: "log-2",
        timestamp: now,
        service: "checkout-api",
        env: "prod",
        status: "warn",
        message: "High DB pool wait time on cart_line_items lookup",
        attributes: { revision: "rev-482", pool_waiting: 18 },
      },
    ],
  };
}

/**
 * Stateful Datadog Logs & APM Emulator built on `vercel-labs/emulate`.
 */
export const datadogEmulator = defineEmulator<DatadogEmulatorState>({
  name: "overwatch-datadog",
  stateVersion: 1,
  state: initialDatadogState,
  setup({ app, state }) {
    app.get("/api/v1/validate", (c) => {
      const key = c.req.header("dd-api-key");
      if (key && key === "invalid") {
        return c.json({ errors: ["Invalid API key"] }, 403);
      }
      return c.json({ valid: true });
    });

    app.post("/api/v2/logs/events/search", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { filter?: { query?: string } };
      const q = (body.filter?.query ?? "").toLowerCase();
      const filtered = state.logs.filter(
        (l) => !q || l.service.toLowerCase().includes(q) || l.message.toLowerCase().includes(q) || q.includes(l.service),
      );
      return c.json({
        data: filtered.map((l) => ({
          id: l.id,
          type: "log",
          attributes: {
            timestamp: l.timestamp,
            service: l.service,
            status: l.status,
            message: l.message,
            attributes: l.attributes,
          },
        })),
      });
    });

    app.get("/api/v1/overwatch/metrics", (c) => {
      return c.json({
        service: c.req.query("service") ?? "checkout-api",
        env: c.req.query("env") ?? "prod",
        releaseVersion: state.releaseVersion,
        degraded: state.degraded,
        p50LatencyMs: state.p50Ms,
        p95LatencyMs: state.p95Ms,
        errorRatePct: state.errorRatePct,
        sampledAtMs: Date.now(),
      });
    });

    app.get("/api/v1/overwatch/trace-diff", (c) => {
      const route = c.req.query("route") ?? "POST /v1/checkout/confirm";
      const slowQueryCount = state.degraded ? 46 : 1;
      const slowSpans: RawSpan[] = [
        {
          traceId: "tr_emu_slow",
          spanId: "sp_root",
          operation: "http.request",
          resource: route,
          durationMs: state.p95Ms,
          tags: { pod_name: `checkout-api-${state.releaseVersion}-a101` },
        },
        ...Array.from({ length: slowQueryCount }, (_, i) => ({
          traceId: "tr_emu_slow",
          spanId: `sp_pg_${i}`,
          operation: "pg.query",
          resource: state.degraded
            ? "SELECT * FROM cart_line_items WHERE cart_id = $1 AND promo_tier = $2"
            : "SELECT * FROM cart_line_items WHERE cart_id = $1 AND promo_tier = ANY($2)",
          durationMs: state.degraded ? 35 : 22,
          tags: { pod_name: `checkout-api-${state.releaseVersion}-a101` },
        })),
      ];

      const medianSpans: RawSpan[] = [
        {
          traceId: "tr_emu_med",
          spanId: "sp_root",
          operation: "http.request",
          resource: route,
          durationMs: 390,
          tags: { pod_name: "checkout-api-4c88e1b-3a1e" },
        },
        {
          traceId: "tr_emu_med",
          spanId: "sp_pg_0",
          operation: "pg.query",
          resource: state.degraded
            ? "SELECT * FROM cart_line_items WHERE cart_id = $1 AND promo_tier = $2"
            : "SELECT * FROM cart_line_items WHERE cart_id = $1 AND promo_tier = ANY($2)",
          durationMs: 24,
          tags: { pod_name: "checkout-api-4c88e1b-3a1e" },
        },
      ];

      return c.json(
        diffTraceTrees({
          route,
          releaseVersion: state.releaseVersion,
          slowTraces: [{ traceId: "tr_emu_slow", spans: slowSpans }],
          medianTraces: [{ traceId: "tr_emu_med", spans: medianSpans }],
        }),
      );
    });

    app.post("/overwatch-control/set-health", async (c) => {
      const body = (await c.req.json()) as {
        degraded: boolean;
        releaseVersion: string;
        p95Ms?: number;
        errorRatePct?: number;
      };
      state.degraded = body.degraded;
      state.releaseVersion = body.releaseVersion;
      state.p95Ms = body.p95Ms ?? (body.degraded ? 2150 : 420);
      state.p50Ms = body.degraded ? 410 : 185;
      state.errorRatePct = body.errorRatePct ?? (body.degraded ? 1.84 : 0.06);
      state.logs.unshift({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        service: "checkout-api",
        env: "prod",
        status: body.degraded ? "error" : "info",
        message: body.degraded
          ? `Regression detected on ${body.releaseVersion}: p95=${state.p95Ms}ms`
          : `Release ${body.releaseVersion} healthy: batched promo lookup p95=${state.p95Ms}ms`,
        attributes: { release: body.releaseVersion, p95Ms: state.p95Ms },
      });
      return c.json({ ok: true, degraded: state.degraded, p95Ms: state.p95Ms });
    });
  },
});
