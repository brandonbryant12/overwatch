import { scratch } from "./scratch.ts";
/**
 * End-to-end owner MCP loop (`POST /mcp`): `ow_handoff`, `ow_correct`, and `ow_investigate`, plus
 * strict owner-only session guards (refusing service runs, retired runs, unconfirmed sessions, and down peers).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { Agents } from "../src/agents.ts";
import { clock } from "../src/clock.ts";
import { Collector } from "../src/collect.ts";
import { AppConfig, parseConfig } from "../src/config.ts";
import { Fixes } from "../src/fixes.ts";
import { McpRoutes } from "../src/mcp.ts";
import { OpenCodeClient } from "../src/opencode.ts";
import { json, Store, type Clean } from "../src/store.ts";
import { Tools } from "../src/tools.ts";
import { Platform } from "./effect.ts";

async function mcpRpc(base: string, token: string, method: string, params: Record<string, unknown>, transport?: string | null): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (transport) headers["mcp-session-id"] = transport;
  const notification = method.startsWith("notifications/");
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: 1 }), method, params }),
  });
  if (!res.ok) throw new Error(`MCP ${res.status}: ${await res.text()}`);
  if (notification) return { transport: res.headers.get("mcp-session-id") };
  const session = res.headers.get("mcp-session-id");
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return { ...(await res.json() as Record<string, unknown>), transport: session };
  }
  const text = await res.text();
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) continue;
    const msg = JSON.parse(data) as Record<string, unknown>;
    if (msg.id === 1) return { ...msg, transport: session };
  }
  throw new Error("MCP stream ended without response");
}

async function openMcp(base: string, token: string) {
  const init = await mcpRpc(base, token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "owner-test", version: "2.4.1" },
  });
  const transport = init.transport as string;
  await mcpRpc(base, token, "notifications/initialized", {}, transport);
  const list = async () => {
    const r = await mcpRpc(base, token, "tools/list", {}, transport);
    return (r.result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: Record<string, unknown> }> }).tools;
  };
  const callRaw = async (sid: string | undefined, name: string, args: Record<string, unknown>) =>
    mcpRpc(base, token, "tools/call", {
      name,
      arguments: args,
      ...(sid === undefined ? {} : { _meta: { "ai.opencode/sessionID": sid } }),
    }, transport);
  const call = async (sid: string, name: string, args: Record<string, unknown>) => {
    const v = await callRaw(sid, name, args);
    const result = v.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
    if (v.error || result?.isError) throw new Error(JSON.stringify(v.error ?? result?.content));
    return JSON.parse(result!.content![0]!.text);
  };
  return { list, call, callRaw };
}

test("POST /mcp owner loop: ow_handoff, ow_correct, ow_investigate, and strict owner-only session guards", async () => {
  const dir = scratch("ow-mcp-owner-");
  const token = "ow_test_mcp_owner_token";
  process.env.OW_TEST_MCP_TOKEN = token;

  // Fake OpenCode peer confirming only sessions in `knownSessions` (unless `peerDown` is toggled).
  const knownSessions = new Set(["ses_owner_live", "ses_run_inv", "ses_run_fixer", "ses_run_retired"]);
  let peerDown = false;
  const ocServer = createServer((req, res) => {
    req.resume();
    if (peerDown) { res.writeHead(503).end("down"); return; }
    const m = /^\/api\/session\/([^/?]+)$/.exec(req.url ?? "");
    if (m && knownSessions.has(decodeURIComponent(m[1]!))) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: decodeURIComponent(m[1]!) } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
  });
  const ocUrl = await new Promise<string>((ok) => ocServer.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(ocServer.address() as { port: number }).port}`)));

  const cfg = parseConfig({
    version: 2,
    dataDir: dir,
    port: 0,
    mcpToken: "env:OW_TEST_MCP_TOKEN",
    opencode: { url: ocUrl, model: "local/glm-5.3" },
    apps: {
      shop: {
        checkout: "/repos/shop",
        fixes: { remote: "origin", base: "main", paths: ["config/settings.json"], verify: [["pnpm", "test"]] },
        environments: {
          production: {
            sources: { pods: { type: "kubernetes", context: "prod-ctx", namespace: "shop", selector: "app=shop" } },
          },
          staging: {
            policy: { investigate: false, readings: 2, fixMode: "off", critical: false },
            sources: { pods: { type: "kubernetes", context: "stg-ctx", namespace: "shop-stg", selector: "app=shop" } },
          },
        },
      },
    },
    watchers: [
      { app: "shop", environment: "production", every: "1m" },
      { app: "shop", environment: "staging", every: "1m" },
    ],
  }, join(dir, "config.json"));

  const Core = Layer.mergeAll(Store.layer(dir), AppConfig.layer(cfg), FetchHttpClient.layer).pipe(Layer.provideMerge(Platform));
  const Services = Layer.mergeAll(Collector.layer, Tools.layer, Agents.layer, Fixes.layer, OpenCodeClient.layer).pipe(Layer.provideMerge(Core));
  const Listener = NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1", gracefulShutdownTimeout: "100 millis" }).pipe(Layer.provide(Platform));
  const Server = HttpRouter.serve(McpRoutes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(Listener),
    Layer.provideMerge(Services),
  );
  const runtime = ManagedRuntime.make(Server);

  try {
    const base = await runtime.runPromise(Effect.map(HttpServer.HttpServer, (s) => `http://127.0.0.1:${s.address._tag === "UnixPathAddress" ? 0 : s.address.port}`));
    // Seed incidents, deploys, completed investigation + evidence handles, and active/retired service runs.
    await runtime.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      const tools = yield* Tools;
      clock.set(Date.UTC(2026, 10, 15, 12, 0, 0), 1_000_000);
      yield* store.tx((w) => Effect.gen(function* () {
        const s1 = yield* w.event("deploy", "shop/production" as Clean, { revision: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111" });
        yield* w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'production', ?, ?)", s1, "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111" as Clean, "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222" as Clean);
        const s2 = yield* w.event("incident", "inc_prod" as Clean, {});
        yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_prod', 'shop', 'production', 'shop/production/pods', 'ERROR payment timeout', 'error', 7, 1, 1000, 2000, ?, ?)", s2, s2);
        const s3 = yield* w.event("incident", "inc_stg" as Clean, {});
        yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_stg', 'shop', 'staging', 'shop/staging/pods', 'ERROR staging cache miss', 'error', 4, 1, 1500, 2500, ?, ?)", s3, s3);
        yield* w.run("INSERT INTO lines (incident, source, at_ms, text) VALUES ('inc_stg', 'shop/staging/pods', 1500, 'ERROR staging cache miss key=foo')");
        // Completed investigation on inc_prod with telemetry evidence handle + retired run.
        const s4 = yield* w.event("investigation_queued", "inc_prod" as Clean, { job: "job_prod_done" });
        yield* w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq, result) VALUES ('job_prod_done', 'investigation', 'inc_prod', 'ERROR payment timeout', 'completed', NULL, ?, ?)", s4, json({ verdict: "real", observed: true, planned: 3, counts: { real: 3, not_real: 0, unsure: 0, missing: 0 }, challenge: { outcome: "upheld" } }));
        yield* w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms, role, slot) VALUES ('run_retired', 'job_prod_done', 1, 'ses_run_retired', 'terminal', 2, '{}', 1000, 'investigator', 1)");
        yield* w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES ('e_prod_0001', 'run_retired', 'ses_run_retired', 'shop/production/pods', '2026-11-15T12:00:00Z ERROR payment timeout on stripe gateway', 1)");
        yield* w.run("INSERT INTO origins (handle, origin) VALUES ('e_prod_0001', 'telemetry')");
        // Active investigator and fixer runs (must be refused on all owner tools).
        yield* w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms, role, slot) VALUES ('run_inv', 'job_prod_done', 2, 'ses_run_inv', 'active', 0, '{}', 1000, 'investigator', 2)");
        yield* w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms, role, slot) VALUES ('run_fixer', 'job_prod_done', 3, 'ses_run_fixer', 'active', 0, '{}', 1000, 'fixer', NULL)");
      }));
      tools.contexts.set("run_inv", { telemetry: {}, repo: "/repos/shop", deadline: clock.mono() + 60_000, role: "investigator" });
      tools.contexts.set("run_fixer", { telemetry: {}, repo: "/repos/shop", deadline: clock.mono() + 60_000, role: "fixer" });
    }));

    const client = await openMcp(base, token);

    // 1. tools/list advertises readonly annotations and closed schemas accurately.
    const listed = await client.list();
    const byName = new Map(listed.map((t) => [t.name, t]));
    assert.equal(byName.get("ow_handoff")?.annotations?.readOnlyHint, true);
    assert.equal(byName.get("ow_correct")?.annotations?.readOnlyHint, false);
    assert.equal(byName.get("ow_investigate")?.annotations?.readOnlyHint, false);

    // 2. ow_handoff returns grounded handoff bundle (checkout, deploy SHAs, diff hint, handles, policy, mcpTools, starter prompt).
    const handoff = await client.call("ses_owner_live", "ow_handoff", { id: "inc_prod" }) as {
      id: string; app: string; env: string; checkout: string; deploy: string; previousDeploy: string;
      policy: { investigate: boolean; readings: number; fixMode: string; critical: boolean };
      handles: Array<{ handle: string; origin: string; text: string }>;
      mcpTools: string[]; commands: string[]; prompt: string; markdown: string;
    };
    assert.equal(handoff.id, "inc_prod");
    assert.equal(handoff.app, "shop");
    assert.equal(handoff.env, "production");
    assert.equal(handoff.checkout, "/repos/shop");
    assert.equal(handoff.deploy, "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111");
    assert.equal(handoff.previousDeploy, "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222");
    assert.equal(handoff.policy.investigate, true);
    assert.equal(handoff.policy.fixMode, "propose");
    assert.equal(handoff.policy.critical, true);
    assert.ok(handoff.handles.some((h) => h.handle === "e_prod_0001" && h.origin === "telemetry"));
    assert.ok(handoff.commands.some((c) => c.includes("git -C /repos/shop diff bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222..aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111")));
    assert.ok(handoff.commands.includes("pnpm test"));
    assert.ok(handoff.mcpTools.includes("ow_handoff"));
    assert.ok(handoff.mcpTools.includes("ow_correct"));
    assert.ok(handoff.mcpTools.includes("ow_investigate"));
    assert.ok(handoff.prompt.includes("inc_prod"));
    assert.ok(handoff.prompt.includes("e_prod_0001"));

    // 3. ow_correct persists a cleaned correction row, rebuilds playbooks, and surfaces in ow_get.
    const corr = await client.call("ses_owner_live", "ow_correct", {
      app: "shop",
      incident: "inc_prod",
      text: "Ignore stripe retry noise when Bearer sk-secret12345678901234567890 rotates during deploy.",
    }) as { app: string; subject: string; seq: number; jobId: string; text: string };
    assert.equal(corr.app, "shop");
    assert.equal(corr.subject, "inc_prod");
    assert.equal(corr.jobId, "job_prod_done");
    assert.doesNotMatch(corr.text, /sk-secret1234567890/);
    assert.match(corr.text, /REDACTED/);

    // Also test ow_correct on an incident WITHOUT a completed investigation (watch-only staging) and app-wide rule.
    const corrStg = await client.call("ses_owner_live", "ow_correct", {
      app: "shop",
      incident: "inc_stg",
      environment: "staging",
      text: "Staging cache misses after Redis flush are expected for 2 minutes.",
    }) as { app: string; subject: string; seq: number; jobId: string; text: string };
    assert.equal(corrStg.subject, "inc_stg");
    assert.match(corrStg.jobId, /^job_/);

    const corrApp = await client.call("ses_owner_live", "ow_correct", {
      app: "shop",
      text: "Always check checkout pool saturation before blaming Stripe.",
    }) as { app: string; subject: string; seq: number; jobId: string; text: string };
    assert.equal(corrApp.subject, "app:shop");

    // Playbook file rebuilt with all 3 cleaned corrections, and ow_get surfaces the incident's correction.
    const playbookLines = readFileSync(join(dir, "playbooks", "shop.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { seq: number; subject: string; text: string });
    assert.equal(playbookLines.length, 3);
    assert.equal(playbookLines[0]!.subject, "inc_prod");
    assert.doesNotMatch(playbookLines[0]!.text, /sk-secret1234567890/);
    assert.equal(playbookLines[1]!.subject, "inc_stg");
    assert.equal(playbookLines[2]!.subject, "app:shop");

    const prodDetail = await client.call("ses_owner_live", "ow_get", { id: "inc_prod" }) as { corrections: Array<{ seq: number; text: string; jobId: string }> };
    assert.equal(prodDetail.corrections.length, 1);
    assert.equal(prodDetail.corrections[0]!.seq, corr.seq);
    assert.equal(prodDetail.corrections[0]!.text, corr.text);

    const stgDetail = await client.call("ses_owner_live", "ow_get", { id: "inc_stg" }) as { corrections: Array<{ seq: number; text: string }> };
    assert.equal(stgDetail.corrections.length, 1);
    assert.equal(stgDetail.corrections[0]!.seq, corrStg.seq);

    // 4. ow_investigate queues a manual investigation even on policy.investigate: false ("watch only") staging env.
    const stgHandoff = await client.call("ses_owner_live", "ow_handoff", { id: "inc_stg" }) as { policy: { investigate: boolean; readings: number } };
    assert.equal(stgHandoff.policy.investigate, false);
    assert.equal(stgHandoff.policy.readings, 2);

    const inv = await client.call("ses_owner_live", "ow_investigate", { id: "inc_stg" }) as { jobId: string; subject: string };
    assert.equal(inv.subject, "inc_stg");
    assert.match(inv.jobId, /^job_/);
    // Calling ow_investigate again while queued returns the same open job idempotently.
    const invAgain = await client.call("ses_owner_live", "ow_investigate", { id: "inc_stg" }) as { jobId: string; subject: string };
    assert.equal(invAgain.jobId, inv.jobId);

    // Verify job + reading work items + frozen playbook (including our ow_correct entries!) in SQLite.
    await runtime.runPromise(Effect.gen(function* () {
      const store = yield* Store;
      const job = yield* store.get<{ state: string; inputs: string }>("SELECT state, inputs FROM jobs WHERE id = ?", inv.jobId);
      assert.equal(job?.state, "queued");
      const frozen = JSON.parse(job!.inputs) as { planned: number; playbook: Array<{ text: string }> };
      assert.equal(frozen.planned, 2);
      assert.equal(frozen.playbook.length, 3);
      const work = yield* store.all("SELECT * FROM work WHERE job_id = ? AND kind = 'reading'", inv.jobId);
      assert.equal(work.length, 2);
      // Backup + restore must succeed with the synthetic correction job rows intact.
      const backupFile = join(dir, "backup.db");
      yield* store.backup(backupFile);
      yield* store.restore(backupFile);
    }));

    // 5. Security invariants: active runs (investigator, fixer), retired runs, unknown sessions, missing session ID, and down peer are refused on ALL 3 tools.
    const calls: Array<[string, Record<string, unknown>]> = [
      ["ow_handoff", { id: "inc_prod" }],
      ["ow_correct", { app: "shop", incident: "inc_prod", text: "unauthorized rule" }],
      ["ow_investigate", { id: "inc_prod" }],
    ];
    for (const [tool, args] of calls) {
      for (const badSession of ["ses_run_inv", "ses_run_fixer", "ses_run_retired", "ses_unknown_peer", undefined]) {
        const res = await client.callRaw(badSession, tool, args);
        const result = res.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
        assert.equal(result?.isError, true, `${tool} must refuse session ${String(badSession)}`);
      }
    }

    // Down peer must refuse even a previously valid owner session.
    peerDown = true;
    for (const [tool, args] of calls) {
      const res = await client.callRaw("ses_owner_live", tool, args);
      const result = res.result as { isError?: boolean } | undefined;
      assert.equal(result?.isError, true, `${tool} must refuse when OpenCode peer is down`);
    }
    peerDown = false;

    // Excess properties and unknown app/incident are refused cleanly.
    const extraRes = await client.callRaw("ses_owner_live", "ow_handoff", { id: "inc_prod", extra: 1 });
    assert.equal((extraRes.result as { isError?: boolean })?.isError, true);
    const badApp = await client.callRaw("ses_owner_live", "ow_correct", { app: "no_such_app", text: "x" });
    assert.equal((badApp.result as { isError?: boolean })?.isError, true);
    const badInc = await client.callRaw("ses_owner_live", "ow_investigate", { id: "inc_missing" });
    assert.equal((badInc.result as { isError?: boolean })?.isError, true);
  } finally {
    await runtime.dispose();
    ocServer.close();
  }
});
