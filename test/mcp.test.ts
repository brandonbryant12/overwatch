/**
 * The session-bound MCP tools: who may call them, and what they refuse. Also the MCP server over HTTP, with the
 * session id in the call's `_meta` as OpenCode sends it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileFinding, gitHistory, queryTelemetry, type McpPorts } from "../src/service/mcp.ts";
import { recordShown } from "../src/service/tables.ts";
import { testService } from "./fixtures/service.ts";
import { tempDir } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

const finding = (quote: string) => ({
  product: { impact: "Some card payments fail", affected: "card payers", since: "unknown", status: "ongoing" },
  engineering: {
    verdict: "real",
    confidence: "high",
    cause: "Payment calls time out after 300ms.",
    causeBasis: "observed",
    evidence: [
      { source: "pods", quote },
      { source: "payments.ts", quote: "export const TIMEOUT_MS = 300" },
    ],
    codeLocation: "payments.ts:1",
    notChecked: ["provider status"],
    nextCheck: "Check provider latency.",
  },
  ruledOut: ["a database failover"],
});

async function setup() {
  const { service, cluster } = await testService();
  cluster.log(Date.now() - 5 * 60_000, "ERROR payment 42 timed out after 300ms");
  await service.collect("shop-api/production");
  const incident = await service.read((db) => (db.prepare("SELECT stream FROM journal WHERE type = 'IncidentOpened'").get() as { stream: string }).stream.split("/")[1]!);
  const worktree = tempDir("worktree");
  writeFileSync(join(worktree, "payments.ts"), "export const TIMEOUT_MS = 300\n");
  const runs = new Map<string, string>([["run-a", "sent"], ["run-b", "sent"], ["run-done", "completed"]]);
  const completed: string[] = [];
  await service.atomically((db) => {
    const insert = db.prepare("INSERT INTO run_tokens (token, run_id, session_id, thread_id, subject, role, created_at) VALUES (?, ?, ?, ?, ?, 'investigator', 0)");
    insert.run("tok-a", "run-a", "ses_a", "thr_a", incident);
    insert.run("tok-b", "run-b", "ses_b", "thr_b", incident);
    insert.run("tok-done", "run-done", "ses_a", "thr_a", incident);
    recordShown(db, { sessionId: "ses_a", threadId: "thr_a", runId: "run-a", source: "brief", text: "Incident in shop-api/production", at: 0 });
  });
  const ports: McpPorts = {
    options: (await import("./fixtures/service.ts")).testConfig(tempDir("x")).options,
    runtime: { options: (await import("./fixtures/service.ts")).testConfig(tempDir("y")).options, exec: cluster.exec, fetch, now: Date.now, log: () => undefined, sleep: async () => undefined },
    read: service.read,
    atomically: service.atomically,
    runStatus: async (runId) => runs.get(runId),
    incident: async () => ({ app: "shop-api", environment: "production" }),
    worktree: async () => worktree,
    codeBasis: async () => ({ commit: null, deployed: false, note: "test worktree" }),
    complete: async (runId) => {
      completed.push(runId);
      runs.set(runId, "completed");
    },
    now: Date.now,
  };
  return { service, cluster, ports, completed };
}

describe("query_telemetry and file_finding are bound to the calling session and its run", () => {
  test("a call with no session, an unknown token, another session's token or a finished run is refused", async () => {
    const { service, ports } = await setup();
    try {
      expect(await queryTelemetry(ports, undefined, { token: "tok-a", source: "pods" })).toContain("carries no OpenCode session id");
      expect(await queryTelemetry(ports, "ses_a", { token: "made-up", source: "pods" })).toContain("unknown run token");
      expect(await queryTelemetry(ports, "ses_a", { token: "tok-b", source: "pods" })).toContain("belongs to another session's run (run-b)");
      expect(await fileFinding(ports, "ses_a", { token: "tok-b", finding: finding("x") })).toContain("belongs to another session's run");
      expect(await queryTelemetry(ports, "ses_a", { token: "tok-done", source: "pods" })).toContain("run-done is finished");
    } finally {
      await service.stop();
    }
  });

  test("kubectl runs read-only verbs only, scoped to the run's incident; what it returns is recorded as shown to the session", async () => {
    const { service, ports, cluster } = await setup();
    try {
      const logs = await queryTelemetry(ports, "ses_a", { token: "tok-a", source: "pods", since: "1h", args: { operation: "logs", pod: "shop-api-1" } });
      expect(logs).toContain("ERROR payment 42 timed out after 300ms");
      for (const operation of ["delete", "exec", "apply", "scale"]) {
        expect(await queryTelemetry(ports, "ses_a", { token: "tok-a", source: "pods", args: { operation, pod: "shop-api-1" } })).toContain("free-form kubectl arguments are not accepted");
      }
      expect(await queryTelemetry(ports, "ses_a", { token: "tok-a", source: "pods", args: { verb: "delete", args: ["pod", "x"] } })).toContain("free-form kubectl arguments are not accepted");
      expect(await queryTelemetry(ports, "ses_a", { token: "tok-a", source: "pods", args: { operation: "get", resource: "secrets" } })).toContain("Reading secrets is not allowed");
      expect(await queryTelemetry(ports, "ses_a", { token: "tok-a", source: "pods", args: { operation: "logs", pod: "--kubeconfig=/tmp/x" } })).toContain("not allowed");
      expect(await queryTelemetry(ports, "ses_a", { token: "tok-a", source: "other" })).toContain('Unknown source "other"');
      const kubectlVerbs = cluster.exec.calls.filter((c) => c.command === "kubectl").map((c) => c.args[5]);
      expect(kubectlVerbs.every((verb) => ["get", "describe", "logs", "top"].includes(verb!))).toBe(true);
      const shown = await service.read((db) => db.prepare("SELECT source FROM shown WHERE session_id = 'ses_a'").all().map((r) => r.source));
      expect(shown).toEqual(["brief", "pods"]);
    } finally {
      await service.stop();
    }
  });

  test("a made-up citation is refused with the reason; a checked finding completes the run, once", async () => {
    const { service, ports, completed } = await setup();
    try {
      await queryTelemetry(ports, "ses_a", { token: "tok-a", source: "pods", since: "1h", args: { operation: "logs", pod: "shop-api-1" } });
      const invented = await fileFinding(ports, "ses_a", { token: "tok-a", finding: finding("ERROR payment 99 failed because the moon was full") });
      expect(invented).toContain("Not recorded");
      expect(invented).toContain('the quote is not in anything source "pods" returned');
      expect(await fileFinding(ports, "ses_a", { token: "tok-a", finding: { nonsense: true } })).toContain("does not match the schema");
      // Another session cannot use quotes this session was shown.
      expect(await fileFinding(ports, "ses_b", { token: "tok-b", finding: finding("ERROR payment 42 timed out after 300ms") })).toContain("Not recorded");
      expect(await fileFinding(ports, "ses_a", { token: "tok-a", finding: finding("ERROR payment 42 timed out after 300ms") })).toBe("Recorded. Stop now.");
      expect(completed).toEqual(["run-a"]);
      expect(await fileFinding(ports, "ses_a", { token: "tok-a", finding: finding("ERROR payment 42 timed out after 300ms") })).toContain("is finished");
    } finally {
      await service.stop();
    }
  });
});

describe("git_history", () => {
  test("reads the thread's worktree history, records it as shown, and refuses options and paths outside it", async () => {
    const { service, ports } = await setup();
    try {
      const worktree = (await ports.worktree("thr_a"))!;
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: worktree });
      git("init", "-q");
      git("add", ".");
      git("commit", "-q", "-m", "set the payment timeout");
      const log = await gitHistory(ports, "ses_a", { token: "tok-a", operation: "log", path: "payments.ts" });
      expect(log).toContain("set the payment timeout");
      expect(await gitHistory(ports, "ses_a", { token: "tok-a", operation: "blame", path: "payments.ts" })).toContain("TIMEOUT_MS = 300");
      expect(await gitHistory(ports, "ses_a", { token: "tok-a", operation: "show", commit: "--output=/tmp/owned" })).toContain("Refused");
      expect(await gitHistory(ports, "ses_a", { token: "tok-a", operation: "log", path: "../../etc" })).toContain("Refused");
      expect(await gitHistory(ports, "ses_b", { token: "tok-a", operation: "log" })).toContain("another session's run");
      const shown = await service.read((db) => db.prepare("SELECT source FROM shown WHERE session_id = 'ses_a'").all().map((r) => r.source));
      expect(shown).toContain("git:log");
    } finally {
      await service.stop();
    }
  });
});

describe("the MCP server over HTTP", () => {
  test("lists the session tools and the allowlisted reads, and reads the session from the call's _meta", async () => {
    const { service } = await setup();
    try {
      const rpc = async (body: unknown, session?: string) => {
        const response = await fetch(`${service.url}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
            ...(session ? { "mcp-session-id": session } : {}),
          },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        const data = text.split("\n").find((l) => l.startsWith("data:"));
        const json = text.startsWith("{") ? JSON.parse(text) : data ? JSON.parse(data.slice(5)) : null;
        return { json, session: response.headers.get("mcp-session-id") ?? session };
      };
      const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session ?? undefined);
      const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.session ?? undefined);
      const names = (list.json.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
      expect(names).toEqual(["OverwatchApi_Inbox_get", "OverwatchApi_IncidentPage_get", "OverwatchApi_Search_ask", "OverwatchApi_ThreadPage_get", "file_finding", "git_history", "query_telemetry"]);
      const call = (meta: Record<string, unknown> | undefined) =>
        rpc(
          { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "query_telemetry", arguments: { token: "tok-a", source: "other" }, ...(meta ? { _meta: meta } : {}) } },
          init.session ?? undefined,
        );
      // The session matched its token; this service has no aggregate for the hand-made run, so it counts as finished.
      expect(JSON.stringify((await call({ "ai.opencode/sessionID": "ses_a" })).json)).toContain("Refused: run run-a is finished");
      expect(JSON.stringify((await call({ "ai.opencode/sessionID": "ses_b" })).json)).toContain("another session's run");
      expect(JSON.stringify((await call(undefined)).json)).toContain("no OpenCode session id");
    } finally {
      await service.stop();
    }
  });
});

void mkdirSync;
