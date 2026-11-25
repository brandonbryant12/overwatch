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

describe("3. a thread follows the deployed commit across deploys", () => {
  test("after a second deploy the next session reads the new commit, the brief says the code changed, and each finding records exactly what it read", { timeout: 60_000 }, async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { testService } = await import("./fixtures/service.ts");
    const { fileFinding } = await import("../src/service/mcp.ts");
    const { IncidentId, threadIdOf } = await import("../src/domain/ids.ts");
    const repo = tempDir("app");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "payments.ts"), "export const TIMEOUT_MS = 300\n");
    git("add", ".");
    git("commit", "-q", "-m", "first deploy");
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "payments.ts"), "export const TIMEOUT_MS = 3000\n");
    git("commit", "-q", "-am", "second deploy");
    const second = git("rev-parse", "HEAD");
    const prompts: Array<{ session: string; text: string }> = [];
    const directories = new Map<string, string>();
    const port = {
      connect: async () => "http://opencode.test",
      createSession: async (i: { id: string; directory: string }) => void directories.set(i.id, i.directory),
      prompt: async (i: { sessionID: string; text: string }) => void prompts.push({ session: i.sessionID, text: i.text }),
      synthetic: async () => undefined,
      newUserMessages: async () => [],
      promptState: async () => ({ kind: "running" as const }),
      interrupt: async () => undefined,
      answer: async () => undefined,
    };
    const { service, cluster, client } = await testService({ opencode: port, config: { checkout: repo }, cluster: { image: `registry.example/shop-api:${first.slice(0, 12)}` } });
    try {
      cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
      await service.collect("shop-api/production");
      const incident = IncidentId.make(await service.read((db) => (db.prepare("SELECT stream FROM journal WHERE type = 'IncidentOpened'").get() as { stream: string }).stream.split("/")[1]!));
      const thread = threadIdOf(incident);
      const ask = (promptId: string, override: "auto" | "new") =>
        client((api) => api.AskThread(thread, { subject: incident, title: "t", promptId, text: "why?", mode: "investigate", origin: "page", override }));
      const sendAndFile = async (promptId: string, override: "auto" | "new") => {
        const before = prompts.length;
        await ask(promptId, override);
        for (let i = 0; i < 60 && prompts.length === before; i++) {
          await service.work();
          await new Promise((r) => setTimeout(r, 100));
        }
        const sent = prompts.at(-1)!;
        const token = /run token is (owt_[\w-]+)/.exec(sent.text)![1]!;
        const ports = { ...(service as any).mcpPorts, runStatus: async () => "sent", complete: async (_: string, __: string, finding: any) => void recorded.push(finding) };
        const unsure = { ...findingWith([]), engineering: { ...findingWith([]).engineering, verdict: "unsure", causeBasis: "inferred", confidence: "low" } };
        expect(await fileFinding(ports, sent.session, { token, finding: unsure })).toBe("Recorded. Stop now.");
        return sent;
      };
      const recorded: any[] = [];
      const one = await sendAndFile("p-1", "auto");
      expect(readFileSync(join(directories.get(one.session)!, "payments.ts"), "utf8")).toBe("export const TIMEOUT_MS = 300\n");
      // The second deploy rolls out.
      cluster.state.image = `registry.example/shop-api:${second.slice(0, 12)}`;
      const two = await sendAndFile("p-2", "new");
      expect(two.session).not.toBe(one.session);
      expect(readFileSync(join(directories.get(two.session)!, "payments.ts"), "utf8")).toBe("export const TIMEOUT_MS = 3000\n");
      expect(two.text).toContain(`The code changed since the last session on this thread: it read ${first.slice(0, 12)}, this session reads ${second.slice(0, 12)}`);
      expect(recorded.map((f) => [f.code.commit, f.code.deployed])).toEqual([
        [first, true],
        [second, true],
      ]);
    } finally {
      await service.stop();
    }
  });
});

describe("3. a continued session after a deploy", () => {
  test("keeps its directory, is no longer labelled deployed, and is told the deployed commit moved", async () => {
    const { codeForContinuedSession } = await import("../src/service/worktree.ts");
    const old = { path: "/w/aaaa", commit: "a".repeat(40), deployed: true, note: "x" };
    const moved = codeForContinuedSession(old, "b".repeat(40));
    expect(moved).toMatchObject({ path: "/w/aaaa", commit: "a".repeat(40), deployed: false });
    expect(moved.note).toContain(`the deployed commit is now ${"b".repeat(12)}`);
    expect(codeForContinuedSession(old, "a".repeat(40)).deployed).toBe(true);
    expect(codeForContinuedSession(old, undefined).deployed).toBe(false);
  });
});

describe("4. restore validates the schema it will be read with", () => {
  test("right table names with the wrong columns, or no schema version, are refused; the database is left alone", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { backup, restore } = await import("../src/service/backup.ts");
    const { testService } = await import("./fixtures/service.ts");
    const dataDir = tempDir("restore");
    const db = join(dataDir, "overwatch.sqlite");
    const { service } = await testService({ dataDir });
    await service.stop();
    // Every table the service has, each with one unrelated column (the reviewer's file).
    const names = (new DatabaseSync(db, { readOnly: true }).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    const wrong = join(tempDir("wrong"), "wrong.sqlite");
    const w = new DatabaseSync(wrong);
    for (const name of names.filter((n) => !n.startsWith("sqlite_"))) w.exec(`CREATE TABLE "${name}" (unrelated TEXT)`);
    w.close();
    expect(() => restore(wrong, db)).toThrow("not an Overwatch backup");
    // A real backup whose schema version was changed.
    const good = join(tempDir("good"), "good.sqlite");
    backup(db, good);
    const versionless = join(tempDir("v"), "v.sqlite");
    backup(db, versionless);
    const v = new DatabaseSync(versionless);
    v.exec("PRAGMA user_version = 0");
    v.close();
    expect(() => restore(versionless, db)).toThrow("schema version");
    restore(good, db);
  });
});

describe("5. a notification that fails is retried, a bounded number of times", () => {
  test("fail once, restart, poll again: it is delivered once; one that always fails stops after its limit", async () => {
    const { testService } = await import("./fixtures/service.ts");
    const dataDir = tempDir("notify");
    let attempts = 0;
    const failing = async () => {
      attempts++;
      throw new Error("notification centre unavailable");
    };
    const first = await testService({ dataDir, deps: { notify: failing } as never });
    first.cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
    await first.service.collect("shop-api/production");
    for (let i = 0; i < 40 && attempts === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await first.service.stop();
    expect(attempts).toBe(1);
    const delivered: string[] = [];
    const second = await testService({ dataDir, deps: { notify: async (title: string) => void delivered.push(title) } as never });
    try {
      second.cluster.lines.push(...first.cluster.lines);
      await second.service.collect("shop-api/production");
      for (let i = 0; i < 60 && delivered.length === 0; i++) {
        await (second.service as any).deliverNotifications({ now: Date.now() + 3_600_000 });
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(delivered).toEqual(["New incident in shop-api/production"]);
      await (second.service as any).deliverNotifications({ now: Date.now() + 7_200_000 });
      expect(delivered).toHaveLength(1);
    } finally {
      await second.service.stop();
    }
    // Always failing: tried a bounded number of times, then left as failed with its reason.
    attempts = 0;
    const third = await testService({ deps: { notify: failing } as never });
    try {
      third.cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
      await third.service.collect("shop-api/production");
      for (let i = 0; i < 20; i++) await (third.service as any).deliverNotifications({ now: Date.now() + i * 3_600_000 });
      expect(attempts).toBe(5);
      const row = await third.service.read((db) => db.prepare("SELECT status, attempts, last_error FROM notified").get() as { status: string; attempts: number; last_error: string });
      expect({ ...row }).toEqual({ status: "failed", attempts: 5, last_error: "notification centre unavailable" });
    } finally {
      await third.service.stop();
    }
  });
});
