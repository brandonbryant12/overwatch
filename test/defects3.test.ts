/**
 * Defects reproduced by the third grading. Each test fails on the code before its fix, including by the routes the
 * reviewer used to get around the previous fixes.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

const CONTENDER = fileURLToPath(new URL("./fixtures/lock-contender.ts", import.meta.url));

describe("1. the writer lock is atomic", () => {
  test("separate processes started at the same instant: exactly one takes the lock, every round", { timeout: 180_000 }, async () => {
    const rounds = 25;
    const contenders = 8;
    const doubles: number[] = [];
    for (let round = 0; round < rounds; round++) {
      const file = join(tempDir("lockrace"), "overwatch.sqlite");
      const startAt = Date.now() + 600;
      const results = await Promise.all(
        Array.from(
          { length: contenders },
          () =>
            new Promise<string>((resolve) => {
              const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CONTENDER, file, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
              let out = "";
              proc.stdout.on("data", (c) => (out += c));
              proc.on("close", () => resolve(out));
            }),
        ),
      );
      const winners = results.filter((r) => r.includes("won")).length;
      if (winners !== 1) doubles.push(winners);
    }
    expect(doubles).toEqual([]);
  });
});

/** The MCP tools against a running service, with a run whose aggregate says it was sent. */
async function toolsHarness() {
  const { testService } = await import("./fixtures/service.ts");
  const { writeFileSync } = await import("node:fs");
  const svc = await testService();
  const worktree = tempDir("wt");
  writeFileSync(join(worktree, "payments.ts"), "export const TIMEOUT_MS = 300\n");
  svc.cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
  await svc.service.collect("shop-api/production");
  const incident = await svc.service.read((db) => (db.prepare("SELECT stream FROM journal WHERE type = 'IncidentOpened'").get() as { stream: string }).stream.split("/")[1]!);
  await svc.service.atomically((db) =>
    db.prepare("INSERT INTO run_tokens (token, run_id, session_id, thread_id, subject, role, created_at) VALUES ('tok', 'run_t', 'ses_t', 'thr_t', ?, 'investigator', 0)").run(incident),
  );
  const ports = { ...(svc.service as any).mcpPorts, runStatus: async () => "sent", worktree: async () => worktree, complete: async () => undefined };
  return { ...svc, ports };
}
const findingWith = (evidence: Array<{ source: string; quote: string }>) => ({
  product: { impact: "x", affected: "x", since: "x", status: "x" },
  engineering: { verdict: "real", confidence: "high", cause: "x", causeBasis: "observed", evidence, notChecked: [], nextCheck: "x" },
});

describe("2. what a source returned is its output, and an unknown label is never verified", () => {
  test("an empty query's own selector cannot be quoted as evidence from that source", async () => {
    const { fileFinding, queryTelemetry } = await import("../src/service/mcp.ts");
    const { service, ports } = await toolsHarness();
    try {
      const out = await queryTelemetry(ports, "ses_t", { token: "tok", source: "pods", args: { operation: "get", resource: "events", selector: "app=shop-api,tier=payments" } });
      expect(out).toContain('"items":[]');
      for (const quote of ["app=shop-api,tier=payments", '"selector":"app=shop-api,tier=payments"', "query_telemetry pods"]) {
        const result = await fileFinding(ports, "ses_t", { token: "tok", finding: findingWith([{ source: "pods", quote }]) });
        expect(result).toContain("Not recorded");
      }
    } finally {
      await service.stop();
    }
  });

  test("a quote under a label that is neither a configured source nor a file is recorded as not verified", async () => {
    const { verifyCitations } = await import("../src/collect/citations.ts");
    const shown = [
      { source: "brief:question", text: "The owner asks: why do card payments fail at checkout since the deploy?" },
      { source: "pods", text: "ERROR payment 42 timed out after 300ms" },
    ];
    for (const label of ["datadog-apm", "brief", "the owner", "pods-typo"]) {
      for (const quote of ["why do card payments fail at checkout", "ERROR payment 42 timed out after 300ms"]) {
        const { finding } = await verifyCitations(findingWith([{ source: label, quote }]) as never, { shown, sources: ["pods"] });
        expect(finding.engineering.evidence[0]!.verified).toBe(false);
      }
    }
  });
});
