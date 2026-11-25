import { describe, expect, test } from "bun:test";
import config from "../../../overwatch.config.ts";
import {
  buildSessionHandoff,
  compileSessionPermissions,
  createOpenCodeSessionId,
  startOverwatchDaemon,
  WakeCoordinator,
} from "../src/index.ts";

describe("Overwatch Daemon, OpenCode Permissions & Sleep-Native WakeCoordinator", () => {
  test("OpenCode SessionID, portable handoff, and telemetry prompt-injection permission isolation", () => {
    const sid = createOpenCodeSessionId();
    expect(sid.startsWith("ses_")).toBe(true);

    const handoff = buildSessionHandoff({
      serviceUrl: "http://127.0.0.1:4096",
      sessionId: sid,
      locationDir: "/srv/repos/checkout-api",
    });
    expect(handoff.cliCommand).toContain(`--session ${sid}`);
    expect(handoff.desktopDeepLink).toContain("opencode://open-project?directory=");

    // Triage/Explorer agents must deny shell, edit, write, and webfetch completely
    const triagePerms = compileSessionPermissions("triage");
    expect(triagePerms.every((p) => p.effect === "deny")).toBe(true);
    expect(triagePerms.some((p) => p.action === "shell" && p.effect === "deny")).toBe(true);
    expect(triagePerms.some((p) => p.action === "webfetch" && p.effect === "deny")).toBe(true);

    // Fixer agent must deny git push, gh, kubectl, aws, curl, wget
    const fixerPerms = compileSessionPermissions("fix", "/tmp/wt/inc-42");
    for (const dangerous of ["git push*", "gh *", "kubectl *", "aws *", "curl *", "wget *"]) {
      expect(
        fixerPerms.some((p) => p.action === "shell" && p.resource === dangerous && p.effect === "deny"),
      ).toBe(true);
    }
  });

  test("WakeCoordinator detects overnight wall-clock jump against monotonic clock", async () => {
    const events: Array<{ tier: string; gapMs: number }> = [];
    const coord = new WakeCoordinator(
      (ev) => {
        events.push({ tier: ev.tier, gapMs: ev.gapMs });
      },
      { settleBarrierMs: 0 },
    );

    const t0 = 1_764_000_000_000;
    await coord.tick(t0, 1000);
    // Normal 5s tick -> no wake
    const normal = await coord.tick(t0 + 5_000, 6_000);
    expect(normal).toBeUndefined();
    // +10h laptop sleep (wall clock jumps 10h, monotonic barely advances)
    const wake = await coord.tick(t0 + 5_000 + 10 * 3600_000, 6_050);
    expect(wake?.tier).toBe("overnight");
    expect(events.length).toBe(1);
  });

  test("Live HTTP + OpenAPI + SSE + Intents roundtrip on in-memory SQLite daemon", async () => {
    const daemon = await startOverwatchDaemon({
      config: { ...config, mode: "demo" },
      dbPath: ":memory:",
      port: 0,
      silentNotifications: true,
      enableBackgroundTimers: false,
    });

    try {
      // Wait for initial cold-start view backfill to complete
      let state: any;
      for (let i = 0; i < 60; i++) {
        const res = await fetch(`${daemon.url}/api/state`);
        expect(res.status).toBe(200);
        state = await res.json();
        if (state.now?.incidents?.["INC-42"] && state.needsMe?.pending?.length > 0) break;
        await new Promise((r) => setTimeout(r, 120));
      }

      expect(state.now.incidents["INC-42"]).toBeDefined();
      expect(state.needsMe.pending.length).toBeGreaterThanOrEqual(1);
      expect(state.telemetry["checkout-api:staging"]?.coverage).toBe("auth_expired");

      // OpenAPI document generated directly from DomainHttp.toHttpApi
      const openapiRes = await fetch(`${daemon.url}/openapi.json`);
      expect(openapiRes.status).toBe(200);
      const openapi = (await openapiRes.json()) as { openapi: string; paths: Record<string, unknown> };
      expect(openapi.openapi.startsWith("3.")).toBe(true);
      expect(Object.keys(openapi.paths).length).toBeGreaterThan(10);

      // Trigger Collect Now intent
      const collectRes = await fetch(`${daemon.url}/api/intents/collect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envKey: "checkout-api:prod" }),
      });
      expect(collectRes.status).toBe(200);

      // Post incident chat steering
      const chatRes = await fetch(`${daemon.url}/api/intents/incident-chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ incidentId: "INC-42", text: "Should we rollback?" }),
      });
      expect(chatRes.status).toBe(200);

      // Approve Needs Me Draft PR Ask -> triggers ExecuteAction Saga!
      const pendingAsk = state.needsMe.pending[0];
      const approveRes = await fetch(`${daemon.url}/api/intents/answer-ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ askId: pendingAsk.askId, selectedOptionId: "approve" }),
      });
      expect(approveRes.status).toBe(200);

      // Trigger trace walk insight & promote to WatchRule
      const walkRes = await fetch(`${daemon.url}/api/intents/trace-walk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(walkRes.status).toBe(200);
      const walkData = (await walkRes.json()) as { insightId: string };
      expect(walkData.insightId).toBeTruthy();

      // Verify updated state
      await new Promise((r) => setTimeout(r, 150));
      const afterState = (await (await fetch(`${daemon.url}/api/state`)).json()) as any;
      expect(afterState.incidentDetails["INC-42"].chat.length).toBeGreaterThanOrEqual(4);
      expect(afterState.now.actions["act-pr-42"]?.status).toBe("completed");
      expect(afterState.now.actions["act-pr-42"]?.artifactUrl).toContain("https://github.com/");
    } finally {
      await daemon.stop();
    }
  }, 20_000);
});
