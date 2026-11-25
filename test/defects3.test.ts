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

describe("2b. what a finding may claim", () => {
  test("real and observed with no quote that matched is recorded as inferred, and the reply says so; a git_history quote counts", async () => {
    const { fileFinding } = await import("../src/service/mcp.ts");
    const { recordShown } = await import("../src/service/tables.ts");
    const { service, ports } = await toolsHarness();
    const recorded: any[] = [];
    const recording = { ...ports, complete: async (_r: string, _s: string, finding: unknown) => void recorded.push(finding) };
    try {
      const reply = await fileFinding(recording, "ses_t", { token: "tok", finding: findingWith([{ source: "a-dashboard-i-saw", quote: "p99 latency 4s on checkout" }]) });
      expect(reply).toContain('recorded as "inferred"');
      expect(recorded[0].engineering.causeBasis).toBe("inferred");
      expect(recorded[0].engineering.evidence[0].verified).toBe(false);
      // A quote from git_history's own output is from a source Overwatch can read: it verifies, and observed stands.
      await service.atomically((db) => recordShown(db, { sessionId: "ses_t", threadId: "thr_t", runId: "run_t", source: "git:log", text: "a1b2c3d raise payment timeout to 3000ms", at: Date.now() }));
      await service.atomically((db) => db.prepare("UPDATE run_tokens SET token = 'tok2', run_id = 'run_t2' WHERE token = 'tok'").run());
      const second = await fileFinding(recording, "ses_t", { token: "tok2", finding: findingWith([{ source: "git_history", quote: "raise payment timeout to 3000ms" }]) });
      expect(second).toBe("Recorded. Stop now.");
      expect(recorded[1].engineering.causeBasis).toBe("observed");
      expect(recorded[1].engineering.evidence[0].verified).toBe(true);
    } finally {
      await service.stop();
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

describe("6. measured state never misleads", () => {
  test("high, missing, high is not two high samples in a row", async () => {
    const { testService } = await import("./fixtures/service.ts");
    const { service, cluster } = await testService();
    try {
      const memoryIncidents = async () =>
        (await service.read((db) => db.prepare("SELECT data FROM journal WHERE type = 'IncidentOpened'").all() as Array<{ data: string }>)).filter((r) => r.data.includes("memory_pct_of_limit")).length;
      cluster.state.memoryMi = 500; // about 98% of the 512Mi limit
      await service.collect("shop-api/production");
      cluster.state.top = false; // not measured this time
      await new Promise((r) => setTimeout(r, 5));
      await service.collect("shop-api/production");
      cluster.state.top = true;
      await new Promise((r) => setTimeout(r, 5));
      await service.collect("shop-api/production");
      expect(await memoryIncidents()).toBe(0);
      await new Promise((r) => setTimeout(r, 5));
      await service.collect("shop-api/production");
      expect(await memoryIncidents()).toBe(1);
    } finally {
      await service.stop();
    }
  });

  test("a rule that needs more samples than are kept is a configuration error at check", async () => {
    const { parseConfig } = await import("../src/service/config.ts");
    const config = parseConfig({
      apps: { a: { checkout: "/x", environments: { prod: { sources: { s: { type: "kubernetes", context: "c", namespace: "n", selector: "a=b" } }, metrics: [{ metric: "memory_pct_of_limit", operator: "gt", threshold: 90, hysteresis: 121 }] } } } },
    });
    expect(config.errors.join("\n")).toContain("hysteresis 121");
  });

  test("an environment with a reading missing is never headlined as quiet", async () => {
    const { environmentChips } = await import("../web/src/app.ts");
    const { testService } = await import("./fixtures/service.ts");
    const { service, cluster } = await testService();
    try {
      await service.collect("shop-api/production");
      expect(environmentChips({ status: (await service.status()) as any, inbox: [] })[0]!.state).toBe("quiet");
      cluster.state.top = false;
      await new Promise((r) => setTimeout(r, 5));
      await service.collect("shop-api/production");
      const chip = environmentChips({ status: (await service.status()) as any, inbox: [] })[0]!;
      expect(chip.state).not.toBe("quiet");
      expect(chip.label).toContain("not measured");
    } finally {
      await service.stop();
    }
  });
});

describe("7. a send whose acknowledgement was lost is not asked twice", () => {
  test("the page: the prompt id is chosen with the draft and every retry of the same text carries it", async () => {
    const app = (await import("../web/src/app.ts")) as Record<string, any>;
    const a = "inc_a";
    const item = { incidentId: a, title: a, app: "x", environment: "production", severity: "error", firstAt: 0, lastAt: 0, occurrences: 1, verdict: null, cause: null, disposition: "inbox", way: null, back: null, changedAt: 0, running: 0, failure: null, recent: [], hidden: [], returns: [] };
    let m = app.update(app.init({ session: "s" }).model, app.Message.ReceivedInbox({ items: [item] })).model;
    m = app.update(m, app.Message.ClickedItem({ incidentId: a })).model;
    m = app.update(m, app.Message.ChangedDraft({ text: "why" })).model;
    m = app.update(m, app.Message.ChangedDraft({ text: "why is A failing?" })).model;
    const chosen = m.draftIds[a].promptId;
    const send = () => {
      m = app.update(m, app.Message.SubmittedPrompt({})).model;
      const [commandId, entry] = Object.entries(m.sending as Record<string, { promptId: string }>).at(-1)!;
      return { commandId, promptId: entry.promptId };
    };
    const first = send();
    expect(first.promptId).toBe(chosen);
    // The service committed it, but the acknowledgement never arrived.
    m = app.update(m, app.Message.ReceivedResult({ result: app.Client.Message.FailedAskThread({ commandId: first.commandId, failure: { _tag: "Unknown" } }) })).model;
    const second = send();
    expect(second.commandId).not.toBe(first.commandId);
    expect(second.promptId).toBe(chosen);
    m = app.update(m, app.Message.ReceivedResult({ result: app.Client.Message.FailedAskThread({ commandId: second.commandId, failure: { _tag: "Unknown" } }) })).model;
    // Changing the text after a try is a different prompt.
    m = app.update(m, app.Message.ChangedDraft({ text: "why is A failing now?" })).model;
    expect(send().promptId).not.toBe(chosen);
  });

  test("the service: the same prompt id asked twice records one prompt and one run", async () => {
    const { testService } = await import("./fixtures/service.ts");
    const { IncidentId, threadIdOf, runIdOf } = await import("../src/domain/ids.ts");
    const { service, cluster, client } = await testService();
    try {
      cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
      await service.collect("shop-api/production");
      const incident = IncidentId.make(await service.read((db) => (db.prepare("SELECT stream FROM journal WHERE type = 'IncidentOpened'").get() as { stream: string }).stream.split("/")[1]!));
      const ask = () => client((api) => api.AskThread(threadIdOf(incident), { subject: incident, title: "t", promptId: "prompt:s:0", text: "why?", mode: "investigate", origin: "page", override: "auto" }));
      await ask();
      await ask();
      const asked = await service.read(
        (db) => db.prepare("SELECT data FROM journal WHERE type = 'PromptAsked' AND json_extract(data, '$.promptId') = 'prompt:s:0'").all() as Array<{ data: string }>,
      );
      expect(asked).toHaveLength(1);
      // The run is made by a policy after the prompt: wait for it, then for anything a second prompt would have added.
      const runs = () => service.read((db) => (db.prepare("SELECT count(*) AS n FROM journal WHERE stream = ? AND version = 1").get(`Run/${runIdOf(threadIdOf(incident), "prompt:s:0")}`) as { n: number }).n);
      for (let i = 0; i < 50 && (await runs()) === 0; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      expect(await runs()).toBe(1);
    } finally {
      await service.stop();
    }
  });
});

/** Each shape a secret takes, with the part that must never be stored. */
const SECRET_SHAPES: ReadonlyArray<{ readonly shape: string; readonly secret: string }> = [
  { shape: "password=Hunter2pass", secret: "Hunter2pass" },
  { shape: "db_password: Hunter3pass", secret: "Hunter3pass" },
  { shape: '{"client_secret": "two words here"}', secret: "two words here" },
  { shape: "PASSWORD='quoted Hunter4'", secret: "quoted Hunter4" },
  { shape: "postgres://app:Hunter5pass@db.internal/shop", secret: "Hunter5pass" },
  { shape: "Server=db;User Id=app;Password=Hunter6pw;", secret: "Hunter6pw" },
  { shape: "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END RSA PRIVATE KEY-----", secret: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7" },
  { shape: "sent q7Zr2Lw9Xk4Tn8Vb3Hc6Pm1J upstream", secret: "q7Zr2Lw9Xk4Tn8Vb3Hc6Pm1J" },
];

describe("8. every shape of secret is redacted on every way text enters", () => {
  test("the shapes, one by one", async () => {
    const { redactText } = await import("../src/domain/redact.ts");
    for (const { shape, secret } of SECRET_SHAPES) expect(redactText(shape)).not.toContain(secret);
    // Prose that names a secret without giving one stays readable.
    expect(redactText("the token expired; password reset required")).toBe("the token expired; password reset required");
  });

  test("a page prompt, a typed OpenCode message, a log line, a query's output, a finding and a handoff store none of them", { timeout: 60_000 }, async () => {
    const { testService } = await import("./fixtures/service.ts");
    const { IncidentId, threadIdOf, RunId } = await import("../src/domain/ids.ts");
    const { Thread, RecordHandoff } = await import("../src/domain/thread.ts");
    const { fileFinding, queryTelemetry } = await import("../src/service/mcp.ts");
    const Effect = await import("effect/Effect");
    const all = SECRET_SHAPES.map((s) => s.shape).join(" | ");
    const prompts: Array<{ session: string; text: string }> = [];
    let typed: Array<{ id: string; text: string }> = [];
    const port = {
      connect: async () => "http://opencode.test",
      createSession: async () => undefined,
      prompt: async (i: { sessionID: string; text: string }) => void prompts.push({ session: i.sessionID, text: i.text }),
      synthetic: async () => undefined,
      newUserMessages: async () => {
        const out = typed;
        typed = [];
        return out;
      },
      promptState: async () => ({ kind: "running" as const }),
      interrupt: async () => undefined,
      answer: async () => undefined,
    };
    const { service, cluster, client } = await testService({ opencode: port });
    try {
      // A log line, through the collector.
      for (const { shape } of SECRET_SHAPES) cluster.log(Date.now() - 60_000, `ERROR payment failed ${shape}`);
      await service.collect("shop-api/production");
      const incident = IncidentId.make(await service.read((db) => (db.prepare("SELECT stream FROM journal WHERE type = 'IncidentOpened'").get() as { stream: string }).stream.split("/")[1]!));
      const thread = threadIdOf(incident);
      // A prompt from the page.
      await client((api) => api.AskThread(thread, { subject: incident, title: all, promptId: "p-secret", text: `why? ${all}`, mode: "investigate", origin: "page", override: "new" }));
      for (let i = 0; i < 60 && !prompts.some((p) => p.text.includes("run token")); i++) {
        await service.work();
        await new Promise((r) => setTimeout(r, 100));
      }
      const sent = prompts.find((p) => p.text.includes("run token"))!;
      const token = /run token is (owt_[\w-]+)/.exec(sent.text)![1]!;
      // A message the owner typed in the OpenCode session.
      typed = [{ id: "msg_typed1", text: `also ${all}` }];
      for (let i = 0; i < 20; i++) {
        await service.work();
        await new Promise((r) => setTimeout(r, 50));
      }
      // A query's output, shown to the session.
      const ports = { ...(service as any).mcpPorts, runStatus: async () => "sent", complete: async () => undefined };
      await queryTelemetry(ports, sent.session, { token, source: "pods", args: { operation: "logs", sinceMinutes: 30 } });
      // A finding filed by the session.
      const finding = {
        product: { impact: all, affected: all, since: "x", status: "x" },
        engineering: { verdict: "unsure", confidence: "low", cause: all, causeBasis: "inferred", evidence: [], notChecked: [all], nextCheck: all },
        ruledOut: [all],
      };
      await fileFinding({ ...ports, complete: (service as any).mcpPorts.complete }, sent.session, { token, finding });
      // A handoff.
      await service.runtime.runPromise(
        Effect.gen(function* () {
          const threads = yield* Thread;
          yield* threads.send(Thread.ref(thread), new RecordHandoff({ handoff: { runId: RunId.make("run_h"), sessionId: sent.session, concluded: all, verified: [], ruledOut: [all], open: [all], at: 0 } }));
        }) as never,
      );
      await new Promise((r) => setTimeout(r, 300));
      const stored = await service.read((db) => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
      });
      expect(stored).toContain("REDACTED:named_secret");
      expect(await service.read((db) => (db.prepare("SELECT count(*) AS n FROM journal WHERE type = 'PromptAsked' AND json_extract(data, '$.origin') = 'opencode'").get() as { n: number }).n)).toBe(1);
      const leaked = SECRET_SHAPES.filter(({ secret }) => stored.includes(secret) || prompts.some((p) => p.text.includes(secret))).map((s) => s.shape);
      expect(leaked).toEqual([]);
    } finally {
      await service.stop();
    }
  });
});

describe("9. the page uses the tier the service reports, not the environment's name", () => {
  test("an environment called live with an explicit production tier stays under the production filter, and one called prod-like but staging does not", async () => {
    const app = (await import("../web/src/app.ts")) as Record<string, any>;
    const item = (id: string, environment: string) => ({ incidentId: id, title: id, app: "shop-api", environment, severity: "error", firstAt: 0, lastAt: 0, occurrences: 1, verdict: null, cause: null, disposition: "inbox", way: null, back: null, changedAt: 0, running: 0, failure: null, recent: [], hidden: [], returns: [] });
    const env = (environment: string, tier: string) => ({ app: "shop-api", environment, tier, everyMs: 60_000, checkedThrough: null, lastError: null, expectsReadings: false, notReadyPods: null, memoryPctOfLimit: null });
    const model = {
      ...app.init({ session: "s" }).model,
      inbox: [item("inc_live", "live"), item("inc_prodlike", "prod-mirror")],
      status: { environments: [env("live", "production"), env("prod-mirror", "staging")] },
    };
    expect(app.visibleInbox({ ...model, envFilter: "prod" }).map((i: { incidentId: string }) => i.incidentId)).toEqual(["inc_live"]);
    expect(app.visibleInbox({ ...model, envFilter: "preprod" }).map((i: { incidentId: string }) => i.incidentId)).toEqual(["inc_prodlike"]);
    // Before any status, nothing that might be production is filtered away.
    expect(app.visibleInbox({ ...model, status: null, envFilter: "prod" })).toHaveLength(2);
  });
});

describe("11. rows read back are decoded with a schema", () => {
  test("a code_deployed that is not 0 or 1, or a metric state nobody writes, is an error naming the table, not a quiet false or a healthy chip", async () => {
    const { testService } = await import("./fixtures/service.ts");
    const { service } = await testService();
    try {
      await service.atomically((db) =>
        db
          .prepare("INSERT INTO run_tokens (token, run_id, session_id, thread_id, subject, role, created_at, code_path, code_commit, code_deployed, code_note) VALUES ('tok', 'run_t', 'ses_t', 'thr_t', 'inc_t', 'investigator', 0, '/w', 'abc', 'yes', 'n')")
          .run(),
      );
      const basis = await service.mcpPorts.codeBasis("run_t").then(
        (value) => ({ value }),
        (error: Error) => ({ error: error.message }),
      );
      expect((basis as { error?: string }).error ?? "decoded").toContain("run_tokens");
      expect((basis as { error?: string }).error ?? "decoded").toContain("code_deployed");
      await service.atomically((db) =>
        db.prepare("INSERT INTO metric_state (watcher, source, metric, state, observed, limit_value, sampled_at, checked_at) VALUES ('shop-api/production', 'pods', 'not_ready_pods', 'fine', 0, 1, 0, 9e15)").run(),
      );
      const status = await service.status().then(
        () => "answered",
        (error: Error) => error.message,
      );
      expect(status).toContain("metric_state");
    } finally {
      await service.stop();
    }
  });
});
