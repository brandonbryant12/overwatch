import { describe, expect, test } from "bun:test";
import config from "../../../overwatch.config.ts";
import {
  DemoSimulator,
  EventHub,
  incidentIdForBreach,
  makeRequestGuard,
  podUtilization,
  resolveStaticPath,
  startOverwatchDaemon,
  worstCoverage,
} from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 80; i++) {
    last = await read();
    if (done(last)) return last;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for: ${label}. Last value: ${JSON.stringify(last)?.slice(0, 400)}`);
}

const startDemo = () =>
  startOverwatchDaemon({
    config: { ...config, mode: "demo" },
    dbPath: ":memory:",
    port: 0,
    silentNotifications: true,
    enableBackgroundTimers: false,
  });

const postIntent = (url: string, intent: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/intents/${intent}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("Autonomous monitor loop", () => {
  test("detects a regression, opens one incident, then verifies recovery and resolves it", async () => {
    const daemon = await startDemo();
    const envKey = "identity-edge:prod";
    const state = async () => (await (await fetch(`${daemon.url}/api/state`)).json()) as any;
    const incidentsFor = (s: any) =>
      Object.values(s.now.incidents as Record<string, any>).filter((i) => `${i.appId}:${i.envId}` === envKey);

    try {
      await eventually(state, (s) => Boolean(s.now?.incidents?.["INC-42"]), "demo seed");

      // A full sweep of the seeded fleet must not duplicate the incident that already owns
      // checkout-api's breaching rules, and must freeze the environment with expired credentials.
      const first = await daemon.monitor.sweepAll("test");
      expect(first.find((o) => o.envKey === "checkout-api:prod")?.actions).toEqual([]);
      expect(first.find((o) => o.envKey === "checkout-api:staging")?.frozen).toBe(true);
      expect(Object.keys((await state()).now.incidents)).toEqual(["INC-42"]);

      // One bad sample is not an incident.
      const regress = await postIntent(daemon.url, "simulate-regression", { envKey });
      expect(regress.status).toBe(200);
      expect(incidentsFor(await state())).toHaveLength(0);

      // The second consecutive bad sample is.
      await sleep(5);
      const sweep = await daemon.monitor.sweep(envKey);
      expect(sweep.actions).toEqual(["open_incident"]);
      const opened = await eventually(
        state,
        (s) => {
          const found = incidentsFor(s)[0] as any;
          return Boolean(found && s.incidentDetails[found.incidentId]?.signals?.length);
        },
        "incident opened",
      );
      const incident = incidentsFor(opened)[0] as any;
      expect(incident.incidentId).toBe(sweep.openedIncidentId);
      expect(incident.severity).toBe("page");
      expect(incident.status).toBe("investigating");
      expect(incident.headline.length).toBeLessThanOrEqual(80);
      expect(incident.headline).toContain("identity-edge prod p95");

      // The signal cites evidence that exists and holds the samples behind it.
      const detail = opened.incidentDetails[incident.incidentId];
      const evidence = opened.evidence[detail.signals[0].evidenceId];
      expect(detail.signals[0].watchRuleId).toBe("rule-identity-p95");
      expect(evidence.excerpt).toContain("Most recent samples");

      // Still breaching: no second incident, no extra signal.
      await sleep(5);
      expect((await daemon.monitor.sweep(envKey)).actions).toEqual([]);
      expect(incidentsFor(await state())).toHaveLength(1);

      // The fix lands. Recovery needs consecutive clean samples, then K clean windows.
      expect((await postIntent(daemon.url, "simulate-recovery", { envKey })).status).toBe(200);
      const seen: string[] = [];
      for (let i = 0; i < 12; i++) {
        await sleep(5);
        const outcome = await daemon.monitor.sweep(envKey);
        seen.push(...outcome.actions);
        // Let the views catch up so the next sweep plans from current state.
        await sleep(60);
        if (outcome.resolvedIncidentIds.length > 0) break;
      }
      expect(seen[0]).toBe("enter_watching");
      expect(seen.filter((a) => a === "record_clean_window")).toHaveLength(3);
      const resolved = await eventually(
        state,
        (s) => (incidentsFor(s)[0] as any)?.status === "resolved",
        "incident resolved",
      );
      expect(resolved.monitor.environments[envKey].frozen).toBe(false);

      // A healthy environment after recovery stays quiet.
      await sleep(5);
      expect((await daemon.monitor.sweep(envKey)).actions).toEqual([]);
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  test("live mode starts empty and refuses scripted agent output", async () => {
    const daemon = await startOverwatchDaemon({
      config: { ...config, mode: "live" },
      dbPath: ":memory:",
      port: 0,
      silentNotifications: true,
      enableBackgroundTimers: false,
    });
    try {
      const state = await eventually(
        async () => (await (await fetch(`${daemon.url}/api/state`)).json()) as any,
        (s) => Object.keys(s.now?.environments ?? {}).length === 5,
        "catalog registered",
      );
      expect(Object.keys(state.now.incidents)).toEqual([]);
      expect(Object.keys(state.telemetry)).toEqual([]);
      expect(state.insights.watchRules).toHaveLength(config.watchRules?.length ?? 0);
      // Nothing has been collected, so nothing is claimed healthy.
      for (const env of Object.values(state.now.environments) as any[]) {
        expect(env.coverage).toBe("unconfigured");
      }
      for (const intent of ["prepare-fix", "trace-walk", "draft-brief", "simulate-regression"]) {
        const res = await postIntent(daemon.url, intent, { incidentId: "INC-1", envKey: "checkout-api:prod" });
        expect(res.status).toBe(501);
      }
    } finally {
      await daemon.stop();
    }
  }, 20_000);
});

describe("Local API request guard", () => {
  const guard = makeRequestGuard({ port: 4720 });
  const req = (method: string, headers: Record<string, string>) =>
    ({ method, headers: new Headers(headers) }) as unknown as Request;
  const json = { "content-type": "application/json" };

  test("accepts the dashboard and native clients", () => {
    expect(guard(req("GET", { host: "127.0.0.1:4720" })).ok).toBe(true);
    expect(guard(req("GET", { host: "localhost:4720" })).ok).toBe(true);
    expect(guard(req("POST", { host: "127.0.0.1:4720", ...json })).ok).toBe(true);
    expect(
      guard(
        req("POST", {
          host: "127.0.0.1:4720",
          origin: "http://127.0.0.1:4720",
          "sec-fetch-site": "same-origin",
          ...json,
        }),
      ).ok,
    ).toBe(true);
  });

  test("rejects another site driving the operator's daemon", () => {
    const crossOrigin = guard(
      req("POST", { host: "127.0.0.1:4720", origin: "https://evil.example", ...json }),
    );
    expect(crossOrigin).toMatchObject({ ok: false, status: 403 });
    // Another local dev server is a different origin too.
    expect(
      guard(req("POST", { host: "127.0.0.1:4720", origin: "http://localhost:3000", ...json })),
    ).toMatchObject({ ok: false, status: 403 });
    // Cross-site form posts carry no preflight; Sec-Fetch-Site and content type both stop them.
    expect(
      guard(req("POST", { host: "127.0.0.1:4720", "sec-fetch-site": "cross-site", ...json })),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      guard(req("POST", { host: "127.0.0.1:4720", "content-type": "text/plain" })),
    ).toMatchObject({ ok: false, status: 415 });
    // Reads are refused cross-origin as well, so state cannot be scraped.
    expect(guard(req("GET", { host: "127.0.0.1:4720", origin: "https://evil.example" }))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  test("rejects DNS rebinding and unknown hosts", () => {
    expect(guard(req("GET", { host: "rebind.evil.example:4720" }))).toMatchObject({ ok: false, status: 421 });
    expect(guard(req("GET", { host: "127.0.0.1:9999" }))).toMatchObject({ ok: false, status: 421 });
    expect(guard(req("GET", {}))).toMatchObject({ ok: false, status: 421 });
    const tailnet = makeRequestGuard({ port: 4720, allowedHosts: ["mac.tailnet.example"] });
    expect(tailnet(req("GET", { host: "mac.tailnet.example:4720" })).ok).toBe(true);
  });

  test("end to end: no CORS grant, cross-origin intent refused, same-origin accepted", async () => {
    const daemon = await startDemo();
    try {
      const ok = await fetch(`${daemon.url}/health`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBeNull();

      const evil = await postIntent(daemon.url, "collect", {}, { origin: "https://evil.example" });
      expect(evil.status).toBe(403);
      const preflight = await fetch(`${daemon.url}/api/intents/collect`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      });
      expect(preflight.status).toBe(403);
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

      const same = await postIntent(daemon.url, "collect", { envKey: "checkout-api:prod" }, { origin: daemon.url });
      expect(same.status).toBe(200);

      expect((await postIntent(daemon.url, "no-such-intent", {})).status).toBe(404);
      expect((await postIntent(daemon.url, "answer-ask", {})).status).toBe(400);
      expect((await postIntent(daemon.url, "constructor", {})).status).toBe(404);
    } finally {
      await daemon.stop();
    }
  }, 20_000);

  test("static paths cannot leave the web root", () => {
    expect(resolveStaticPath("/srv/web", "/")).toBe("/srv/web/index.html");
    expect(resolveStaticPath("/srv/web", "/app.js")).toBe("/srv/web/app.js");
    expect(resolveStaticPath("/srv/web", "/../secret")).toBeUndefined();
    expect(resolveStaticPath("/srv/web", "/a/%2e%2e/%2e%2e/etc/passwd")).toBeUndefined();
    expect(resolveStaticPath("/srv/web", "/..%5c..%5cetc")).toBeUndefined();
    expect(resolveStaticPath("/srv/web", "/%E0%A4%A")).toBeUndefined();
  });
});

describe("Monitor building blocks", () => {
  test("event cursors keep increasing across a restart and replay only what was missed", () => {
    let clock = 1_000_000;
    const before = new EventHub(() => clock);
    before.publish("a", "1");
    const clientCursor = before.publish("b", "2").cursor;

    clock += 5_000; // daemon restarts five seconds later
    const after = new EventHub(() => clock);
    const fresh = after.publish("c", "3");
    expect(fresh.cursor).toBeGreaterThan(clientCursor);
    expect(after.replayAfter(clientCursor).map((e) => e.kind)).toEqual(["c"]);
    expect(after.replayAfter(fresh.cursor)).toEqual([]);
  });

  test("demo telemetry holds its level instead of drifting", () => {
    const sim = new DemoSimulator();
    const history = Array.from({ length: 20 }, (_, i) => ({
      tsMs: i,
      p50LatencyMs: 100,
      p95LatencyMs: 300,
      errorRatePct: 0.1,
      cpuPct: 40,
      memoryPct: 50,
      rps: 400,
    }));
    sim.prime("a:prod", history);
    const p95 = Array.from({ length: 500 }, (_, i) => sim.next("a:prod", 100 + i)!.p95LatencyMs);
    expect(Math.min(...p95)).toBeGreaterThanOrEqual(285);
    expect(Math.max(...p95)).toBeLessThanOrEqual(315);

    sim.injectRegression("a:prod", 3);
    expect(sim.next("a:prod", 1_000)!.p95LatencyMs).toBeGreaterThan(850);
    sim.recover("a:prod");
    expect(sim.next("a:prod", 1_001)!.p95LatencyMs).toBeLessThanOrEqual(315);
  });

  test("coverage and utilization never round unknown up to healthy", () => {
    expect(worstCoverage([{ coverage: "healthy" }, { coverage: "auth_expired" }])).toBe("auth_expired");
    expect(worstCoverage([{ coverage: "unconfigured" }, { coverage: "unconfigured" }])).toBe("unconfigured");
    expect(worstCoverage([{ coverage: "healthy" }, { coverage: "unconfigured" }])).toBe("healthy");
    expect(podUtilization([])).toBeUndefined();
  });

  test("the same breach always maps to the same incident id", () => {
    const signal = {
      rule: {
        ruleId: "rule-a",
        name: "a",
        appId: "x",
        envId: "prod",
        metric: "p95_latency_ms",
        operator: "gt" as const,
        threshold: 1,
        hysteresisCount: 2,
        severity: "page" as const,
        enabled: true,
      },
      verdict: {
        kind: "breach" as const,
        observed: 2,
        limit: 1,
        firstBreachTsMs: 1_764_000_000_000,
        lastTsMs: 1_764_000_060_000,
        consecutive: 2,
      },
    };
    const id = incidentIdForBreach("x:prod", signal);
    expect(id).toMatch(/^INC-[0-9A-Z]{6}$/);
    expect(incidentIdForBreach("x:prod", signal)).toBe(id);
    expect(
      incidentIdForBreach("x:prod", { ...signal, verdict: { ...signal.verdict, firstBreachTsMs: 1 } }),
    ).not.toBe(id);
  });
});
