/**
 * Regression tests for defects found by review. Each failed before its fix.
 */
import * as Effect from "effect/Effect";
import { IncidentId, threadIdOf, WatcherId, RunId, ThreadId } from "../src/domain/ids.ts";
import { Incident, RecordFinding, ReportSignal } from "../src/domain/incident.ts";
import { Thread, RecordHandoff } from "../src/domain/thread.ts";
import { testService } from "./fixtures/service.ts";
import { describe, expect, test } from "./harness.ts";

const SECRET = "Authorization: Bearer abcDEF123ghiJKL456mnoPQR789";
const TOKEN = "abcDEF123ghiJKL456mnoPQR789";
const journalText = (service: { read: <A>(f: (db: import("node:sqlite").DatabaseSync) => A) => Promise<A> }) =>
  service.read((db) => (db.prepare("SELECT group_concat(data, '\n') AS t FROM journal").get() as { t: string | null }).t ?? "");
const storedText = (service: { read: <A>(f: (db: import("node:sqlite").DatabaseSync) => A) => Promise<A> }) =>
  service.read((db) => (db.prepare("SELECT group_concat(value, '\n') AS t FROM objects").get() as { t: string | null }).t ?? "");

describe("A1. text is redacted where it enters, before it is stored, indexed or sent", () => {
  test("a secret in a prompt, a signal, a finding or a handoff never reaches the journal, the model's storage or the search index", async () => {
    const { service, client } = await testService();
    try {
      const incident = IncidentId.make("inc_secret");
      await service.runtime.runPromise(
        Effect.gen(function* () {
          const incidents = yield* Incident;
          yield* incidents.send(
            Incident.ref(incident),
            new ReportSignal({ app: "shop-api", environment: "production", watcher: WatcherId.make("shop-api/production"), source: "pods", fingerprint: "f", title: `failed with ${SECRET}`, severity: "error", at: Date.now(), count: 1, sample: SECRET, query: `curl -H '${SECRET}'` }),
          );
          const finding = {
            product: { impact: SECRET, affected: "x", since: "x", status: "x" },
            engineering: { verdict: "real" as const, confidence: "high" as const, cause: SECRET, causeBasis: "observed" as const, evidence: [{ source: "pods", quote: SECRET, verified: true }], notChecked: [SECRET], nextCheck: "x" },
            ruledOut: [SECRET],
          };
          yield* incidents.send(Incident.ref(incident), new RecordFinding({ runId: RunId.make("run_s"), threadId: threadIdOf(incident), sessionId: "ses_s", finding }));
          const threads = yield* Thread;
          yield* threads.send(Thread.ref(ThreadId.make("thr_s")), new RecordHandoff({ handoff: { runId: RunId.make("run_s"), sessionId: "ses_s", concluded: SECRET, verified: [{ source: "pods", quote: SECRET }], ruledOut: [SECRET], open: [SECRET], at: 0 } }));
        }) as never,
      );
      await client((api) => api.AskThread(threadIdOf(incident), { subject: incident, title: SECRET, promptId: "p", text: `why? my key is ${SECRET}`, mode: "investigate", origin: "page", override: "auto" }));
      await new Promise((r) => setTimeout(r, 500));
      const journal = await journalText(service);
      expect(journal).toContain("REDACTED");
      expect(journal).not.toContain(TOKEN);
      expect(await storedText(service)).not.toContain(TOKEN);
      const hits = (await client((api) => api.Search({ text: "failed" }))) as unknown[];
      expect(JSON.stringify(hits)).not.toContain(TOKEN);
    } finally {
      await service.stop();
    }
  });
});

describe("A2. occurrence counts survive a crash between reporting and the checkpoint", () => {
  test("three source lines are three occurrences, whatever the crash and whatever arrived meanwhile", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { createServiceTables } = await import("../src/service/tables.ts");
    const { runWatcher } = await import("../src/service/collector.ts");
    const { fakeCluster } = await import("./fixtures/cluster.ts");
    const { testConfig } = await import("./fixtures/service.ts");
    const { tempDir } = await import("./fixtures/support.ts");
    const db = new DatabaseSync(":memory:");
    createServiceTables(db);
    const config = testConfig(tempDir("a2"));
    const cluster = fakeCluster();
    // The incident as the model keeps it: each command id counts once (a receipt), its count adds up.
    const receipts = new Map<string, number>();
    let crashAfterNextReport = true;
    const ports = {
      runtime: { options: config.options, exec: cluster.exec, fetch, now: Date.now, log: () => undefined, sleep: async () => undefined },
      atomically: async <A,>(work: (d: typeof db) => A) => {
        db.exec("BEGIN");
        try {
          const r = work(db);
          db.exec("COMMIT");
          return r;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      read: async <A,>(work: (d: typeof db) => A) => work(db),
      report: async (r: { commandId: string; count: number }) => {
        if (!receipts.has(r.commandId)) receipts.set(r.commandId, r.count);
        if (crashAfterNextReport) {
          crashAfterNextReport = false;
          throw new Error("killed");
        }
      },
      recordGap: async () => undefined,
    };
    const watcher = config.options.watchers[0]!;
    const now = Date.now();
    cluster.log(now - 10 * 60_000, "ERROR payment 42 timed out after 300ms");
    cluster.log(now - 9 * 60_000, "ERROR payment 43 timed out after 300ms");
    await runWatcher(ports as never, watcher).catch(() => undefined);
    cluster.log(now - 1_000, "ERROR payment 44 timed out after 300ms");
    await runWatcher(ports as never, watcher);
    await runWatcher(ports as never, watcher);
    expect([...receipts.values()].reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("A3. a quote attributed to a source verifies only against what that source returned", () => {
  test("the owner's question, shown in the brief, cannot be cited as if the pods source had said it", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { createServiceTables, shownFor } = await import("../src/service/tables.ts");
    const { makeWorker } = await import("../src/service/worker.ts");
    const { verifyCitations } = await import("../src/collect/citations.ts");
    const { messageIdOf } = await import("../src/domain/ids.ts");
    const db = new DatabaseSync(":memory:");
    createServiceTables(db);
    const thread = ThreadId.make("thr_c");
    const question = "Customers say checkout hangs for ninety seconds after the deploy";
    const page = {
      incidentId: IncidentId.make("inc_c"), threadId: thread, title: "ERROR payment timed out", app: "shop-api", environment: "production", source: "pods", fingerprint: "f",
      severity: "error" as const, firstAt: 0, lastAt: 0, occurrences: 1, disposition: "inbox" as const, sample: "ERROR payment 42 timed out after 300ms", query: null, timeline: [], findings: [],
    };
    let status = "requested";
    const worker = makeWorker({
      opencode: { connect: async () => "x", createSession: async () => undefined, prompt: async () => undefined, synthetic: async () => undefined, newUserMessages: async () => [], promptState: async () => ({ kind: "running" as const }), interrupt: async () => undefined, answer: async () => undefined } as never,
      atomically: async (work: (d: typeof db) => unknown) => work(db),
      pendingRuns: async () => [{ runId: RunId.make("run_c"), threadId: thread, subject: page.incidentId, promptId: "p", mode: "investigate", sessionId: "ses_c", messageId: messageIdOf(thread, "p"), newSession: true, delivery: null, text: question, origin: "page", handoff: null, status: "requested" as const, nudges: [], at: 0 }] as never,
      incidentPage: async () => page as never,
      prepareCode: async () => ({ directory: "/nonexistent", lines: [], basis: { path: "/nonexistent", commit: null, deployed: false, note: "no code" } }),
      runStatus: async () => status,
      markSent: async () => void (status = "sent"),
      adopt: async () => undefined,
      nudge: async () => undefined,
      fail: async () => undefined,
      now: () => 0,
      runTimeoutMs: 60_000,
      log: () => undefined,
    } as never);
    await worker.tick();
    const shown = shownFor(db, "ses_c");
    const finding = (quote: string) => ({
      product: { impact: "x", affected: "x", since: "x", status: "x" },
      engineering: { verdict: "real" as const, confidence: "high" as const, cause: "x", causeBasis: "observed" as const, evidence: [{ source: "pods", quote }], notChecked: [], nextCheck: "x" },
    });
    const fromQuestion = await verifyCitations(finding(question), { shown, sources: ["pods"] });
    expect(fromQuestion.errors).toHaveLength(1);
    expect(fromQuestion.finding.engineering.evidence[0]!.verified).toBe(false);
    const fromSample = await verifyCitations(finding("ERROR payment 42 timed out after 300ms"), { shown, sources: ["pods"] });
    expect(fromSample.errors).toEqual([]);
  });
});

describe("A4. one service per database", () => {
  test("a second service on the same data directory refuses to start and says why; the first keeps working", async () => {
    const { tempDir } = await import("./fixtures/support.ts");
    const dataDir = tempDir("a4");
    const first = await testService({ dataDir });
    try {
      let refused: unknown;
      await testService({ dataDir }).then(
        async (second) => {
          await second.service.stop();
        },
        (error) => (refused = error),
      );
      expect(String((refused as Error)?.message)).toContain("Another Overwatch service");
      expect((await fetch(`${first.service.url}/health`)).status).toBe(200);
    } finally {
      await first.service.stop();
    }
    // Once it stopped, the directory is free again.
    const again = await testService({ dataDir });
    await again.service.stop();
  });
});

describe("A4. the writer lock", () => {
  test("a lock held by a process that died is free again; one held by a live process is refused with its pid", async () => {
    const { join } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { acquireWriterLock } = await import("../src/host/lock.ts");
    const { tempDir } = await import("./fixtures/support.ts");
    const file = join(tempDir("lock"), "overwatch.sqlite");
    const holder = (extra: string) =>
      spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", `import(${JSON.stringify(new URL("../src/host/lock.ts", import.meta.url).pathname)}).then((m) => { m.acquireWriterLock(${JSON.stringify(file)}); console.log("held"); ${extra} })`], { stdio: ["ignore", "pipe", "ignore"] });
    const held = (proc: ReturnType<typeof holder>) => new Promise<void>((r) => proc.stdout!.on("data", (c) => String(c).includes("held") && r()));
    // Killed while holding it: the operating system releases it.
    const killed = holder("setTimeout(() => {}, 60000)");
    await held(killed);
    killed.kill("SIGKILL");
    await new Promise((r) => killed.on("exit", r));
    acquireWriterLock(file).release();
    // Alive and holding it: refused, naming the holder.
    const alive = holder("setTimeout(() => {}, 60000)");
    try {
      await held(alive);
      expect(() => acquireWriterLock(file)).toThrow(`(pid ${alive.pid}`);
    } finally {
      alive.kill();
    }
  });

});

describe("A5. restore never replaces a good database with a bad one", () => {
  test("a file that is not an Overwatch backup is refused and the database is left as it was; a running service blocks restore", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { backup, restore } = await import("../src/service/backup.ts");
    const { tempDir } = await import("./fixtures/support.ts");
    const dataDir = tempDir("a5");
    const db = join(dataDir, "overwatch.sqlite");
    const { service, cluster } = await testService({ dataDir });
    cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
    await service.collect("shop-api/production");
    const good = join(tempDir("a5b"), "good.sqlite");
    backup(db, good);
    expect(() => restore(good, db)).toThrow("Another Overwatch service");
    await service.stop();
    const junk = join(tempDir("a5c"), "notes.txt");
    writeFileSync(junk, "these are my notes, not a database\n");
    expect(() => restore(junk, db)).toThrow("not an Overwatch backup");
    const { DatabaseSync } = await import("node:sqlite");
    const stillThere = new DatabaseSync(db, { readOnly: true });
    expect(Number((stillThere.prepare("SELECT count(*) AS n FROM journal").get() as { n: number }).n)).toBeGreaterThan(0);
    stillThere.close();
    const empty = join(tempDir("a5d"), "other.sqlite");
    new DatabaseSync(empty).exec("CREATE TABLE t (x)");
    expect(() => restore(empty, db)).toThrow("not an Overwatch backup");
    restore(good, db);
  });
});

describe("A6. time spent waiting for OpenCode does not count against a run", () => {
  test("a run requested while OpenCode was closed gets its whole time limit once it is sent", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { createServiceTables } = await import("../src/service/tables.ts");
    const { makeWorker } = await import("../src/service/worker.ts");
    const { messageIdOf } = await import("../src/domain/ids.ts");
    const db = new DatabaseSync(":memory:");
    createServiceTables(db);
    const thread = ThreadId.make("thr_t");
    let now = 0;
    let up = false;
    let status = "requested";
    const calls: string[] = [];
    let pending: Record<string, unknown> = { runId: RunId.make("run_t"), threadId: thread, subject: IncidentId.make("inc_t"), promptId: "p", mode: "investigate", sessionId: "ses_t", messageId: messageIdOf(thread, "p"), newSession: true, delivery: null, text: "why?", origin: "page", handoff: null, status: "requested", nudges: [], at: 0, sentAt: null };
    const worker = makeWorker({
      opencode: { connect: async () => (up ? "x" : undefined), createSession: async () => undefined, prompt: async () => undefined, synthetic: async () => undefined, newUserMessages: async () => [], promptState: async () => ({ kind: "running" as const }), interrupt: async () => void calls.push("interrupt"), answer: async () => undefined } as never,
      atomically: async (work: (d: typeof db) => unknown) => work(db),
      pendingRuns: async () => [pending] as never,
      incidentPage: async () => null,
      prepareCode: async () => ({ directory: "/nonexistent", lines: [], basis: { path: "/nonexistent", commit: null, deployed: false, note: "no code" } }),
      runStatus: async () => status,
      markSent: async () => {
        status = "sent";
        pending = { ...pending, status: "sent", sentAt: now };
      },
      adopt: async () => undefined,
      nudge: async () => undefined,
      fail: async (_: string, reason: string) => void calls.push(`fail: ${reason}`),
      now: () => now,
      runTimeoutMs: 60_000,
      log: () => undefined,
    } as never);
    await worker.tick();
    now = 120_000; // two minutes with OpenCode closed
    up = true;
    await worker.tick(); // sent now
    now = 150_000;
    await worker.tick(); // thirty seconds into its turn
    expect(calls).toEqual([]);
    now = 190_000;
    await worker.tick(); // seventy seconds after it was sent
    expect(calls).toEqual(["interrupt", "fail: no finding within 1 minutes"]);
  });
});

describe("A7. every command loads, extends and validates the configuration the same way", () => {
  test("a config using an extension's source type is valid for check and for serve", { timeout: 60_000 }, async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { spawn, spawnSync } = await import("node:child_process");
    const { tempDir } = await import("./fixtures/support.ts");
    const dir = tempDir("a7");
    writeFileSync(
      join(dir, "fork-source.ts"),
      `export default ({ registerSourceType }) => registerSourceType({ type: "fork-source", queryHelp: "", validate: () => [], collect: async () => ({ signals: [], samples: [], notes: [] }), query: async () => "" });\n`,
    );
    const port = 7400 + Math.floor(Math.random() * 400);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        extensions: ["fork-source.ts"],
        service: { port },
        dataDir: join(dir, "data"),
        opencode: { url: "http://127.0.0.1:1" },
        apps: { a: { checkout: dir, environments: { e: { sources: { s: { type: "fork-source" } } } } } },
        watchers: [{ app: "a", environment: "e" }],
      }),
    );
    const bin = new URL("../bin/overwatch", import.meta.url).pathname;
    const check = spawnSync(bin, ["check", "--config", join(dir, "config.json")], { encoding: "utf8" });
    expect(check.stdout).toContain("is valid");
    const serve = spawn(bin, ["serve", "--config", join(dir, "config.json")], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      let status: { configErrors?: string[] } | undefined;
      for (let i = 0; i < 100 && !status; i++) {
        await new Promise((r) => setTimeout(r, 200));
        status = await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json() as never, () => undefined);
      }
      expect(status?.configErrors).toEqual([]);
    } finally {
      serve.kill("SIGTERM");
    }
  });
});

describe("A8. a prompt draft belongs to the incident it was typed on, and stays until the send is acknowledged", () => {
  test("typing on A then focusing B sends nothing for B; A's draft survives until its send is confirmed or fails", async () => {
    const app = (await import("../web/src/app.ts")) as Record<string, any>;
    const draftOf = (m: any) => (typeof app.draftOf === "function" ? app.draftOf(m) : m.draft);
    const a = IncidentId.make("inc_a");
    const b = IncidentId.make("inc_b");
    const item = (id: string) => ({ incidentId: id, title: id, app: "x", environment: "production", severity: "error", firstAt: 0, lastAt: 0, occurrences: 1, verdict: null, cause: null });
    let m = app.update(app.init({ session: "s" }).model, app.Message.ReceivedInbox({ items: [item(a), item(b)] })).model;
    m = app.update(m, app.Message.ClickedItem({ incidentId: a })).model;
    m = app.update(m, app.Message.ChangedDraft({ text: "why is A failing?" })).model;
    m = app.update(m, app.Message.ClickedItem({ incidentId: b })).model;
    expect(draftOf(m)).toBe("");
    expect(app.update(m, app.Message.SubmittedPrompt()).commands ?? []).toHaveLength(0);
    m = app.update(m, app.Message.ClickedItem({ incidentId: a })).model;
    expect(draftOf(m)).toBe("why is A failing?");
    const sent = app.update(m, app.Message.SubmittedPrompt());
    expect(sent.commands).toHaveLength(1);
    m = sent.model;
    expect(draftOf(m)).toBe("why is A failing?");
    // The send fails: the draft is still there to try again.
    const commandId = `${m.commandIds.session}:${m.commandIds.sent - 1}`;
    m = app.update(m, app.Message.ReceivedResult({ result: app.Client.Message.FailedAskThread({ commandId, failure: { _tag: "Unknown" } }) })).model;
    expect(draftOf(m)).toBe("why is A failing?");
    const again = app.update(m, app.Message.SubmittedPrompt());
    m = again.model;
    const second = `${m.commandIds.session}:${m.commandIds.sent - 1}`;
    m = app.update(m, app.Message.ReceivedResult({ result: app.Client.Message.SucceededAskThread({ commandId: second, reply: undefined, receipt: { stream: "Thread/x", version: 1 } }) })).model;
    expect(draftOf(m)).toBe("");
  });
});

describe("A9. read-only is enforced by what is allowed, not by what is forbidden", () => {
  test("kubectl: anything outside each verb's allowed resources, flags and value shapes is refused", async () => {
    const { checkKubectlArgs } = await import("../src/collect/sources/kubernetes.ts");
    const refused: Array<[string, string[]]> = [
      ["get", ["pods", "--kubeconfig=/tmp/other"]],
      ["get", ["pods", "--kubeconfig", "/tmp/other"]],
      ["get", ["pods", "-o", "yaml"]],
      ["get", ["pods", "-o=go-template-file=/etc/passwd"]],
      ["get", ["pods", "--output=jsonpath-file=/tmp/x"]],
      ["get", ["pods", "--context=prod"]],
      ["get", ["pods", "--server=https://evil"]],
      ["get", ["configmaps"]],
      ["get", ["pods,secrets"]],
      ["get", ["pods", "-l", "--all-namespaces"]],
      ["get", ["pods", "--watch"]],
      ["get", ["pods", "--raw=/api"]],
      ["logs", ["-f", "shop-api-1"]],
      ["logs", ["shop-api-1", "--since-time=yesterday"]],
      ["logs", ["shop-api-1", "--kubeconfig=/x"]],
      ["describe", ["secret", "db"]],
      ["top", ["pods", "--kubeconfig=/x"]],
      ["exec", ["shop-api-1", "--", "sh"]],
      ["delete", ["pod", "shop-api-1"]],
    ];
    for (const [verb, args] of refused) expect(() => checkKubectlArgs(verb, args)).toThrow("not allowed");
    // What the collector itself runs is still allowed.
    for (const [verb, args] of [
      ["get", ["pods", "-l", "app=shop-api", "-o", "json"]],
      ["get", ["events", "--field-selector", "type=Warning", "-o", "json"]],
      ["logs", ["shop-api-1", "--all-containers", "--prefix", "--timestamps", "--since-time=2026-11-25T10:00:00Z", "--limit-bytes=4194304"]],
      ["top", ["pods", "-l", "app=shop-api", "--containers", "--no-headers"]],
      ["top", ["nodes", "--no-headers"]],
    ] as Array<[string, string[]]>) {
      expect(() => checkKubectlArgs(verb, args)).not.toThrow();
    }
  });

  test("agents ask for structured read operations; free-form argument lists and injected names are refused", async () => {
    const { agentKubectl } = (await import("../src/collect/sources/kubernetes.ts")) as Record<string, any>;
    expect(typeof agentKubectl).toBe("function");
    expect(agentKubectl({ operation: "logs", pod: "shop-api-1" })).toEqual({ verb: "logs", args: ["shop-api-1", "--all-containers", "--prefix", "--timestamps"] });
    for (const bad of [
      { verb: "get", args: ["pods", "--kubeconfig=/x"] },
      { operation: "logs", pod: "--kubeconfig=/x" },
      { operation: "logs", pod: "shop-api-1", container: "-o" },
      { operation: "get", resource: "secrets" },
      { operation: "get", resource: "pods", name: "a b" },
      { operation: "get", resource: "pods", selector: "-A" },
      { operation: "describe", resource: "pods" },
      { operation: "top", resource: "deployments" },
      { operation: "exec", pod: "x" },
    ]) {
      expect(() => agentKubectl(bad)).toThrow();
    }
  });

  test("the investigator has no shell; history is a structured tool that refuses options and paths outside its worktree", async () => {
    const { investigatorPermissions } = await import("../src/plugin/index.ts");
    const shell = investigatorPermissions().filter((r) => r.action === "shell" && r.effect === "allow");
    expect(shell).toEqual([]);
    const { gitHistoryArgs } = (await import("../src/service/history.ts").catch(() => ({}))) as Record<string, any>;
    expect(typeof gitHistoryArgs).toBe("function");
    expect(gitHistoryArgs({ operation: "log", path: "src/payments.ts" })[0]).toBe("--no-pager");
    for (const bad of [
      { operation: "log", path: "--output=/tmp/x" },
      { operation: "show", commit: "--ext-diff" },
      { operation: "show", commit: "HEAD; rm -rf /" },
      { operation: "diff", from: "abc1234", to: "-c", path: "x" },
      { operation: "blame", path: "../../etc/passwd" },
      { operation: "blame", path: "/etc/passwd" },
      { operation: "grep", pattern: "x" },
    ]) {
      expect(() => gitHistoryArgs(bad)).toThrow();
    }
  });
});

describe("A10/B2. code evidence comes from the deployed revision, or the brief and the finding say it does not", () => {
  const setupRepo = async () => {
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tempDir } = await import("./fixtures/support.ts");
    const repo = tempDir("app");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "payments.ts"), "export const TIMEOUT_MS = 300\n");
    git("add", ".");
    git("commit", "-q", "-m", "deployed: timeout 300");
    const deployed = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "payments.ts"), "export const TIMEOUT_MS = 3000\n");
    git("commit", "-q", "-am", "not deployed yet: timeout 3000");
    return { repo, deployed, head: git("rev-parse", "HEAD") };
  };
  const recording = () => {
    const prompts: string[] = [];
    return {
      prompts,
      port: {
        connect: async () => "http://opencode.test",
        createSession: async () => undefined,
        prompt: async (i: { text: string }) => void prompts.push(i.text),
        synthetic: async () => undefined,
        newUserMessages: async () => [],
        promptState: async () => ({ kind: "running" as const }),
        interrupt: async () => undefined,
        answer: async () => undefined,
      },
    };
  };

  for (const known of [true, false]) {
    test(known ? "the worktree is at the deployed commit, and the brief says what is deployed" : "an unresolvable deployed revision is said in the brief and recorded on the finding", async () => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { fileFinding } = await import("../src/service/mcp.ts");
      const { repo, deployed, head } = await setupRepo();
      const oc = recording();
      const { service, cluster, client } = await testService({
        opencode: oc.port,
        config: { checkout: repo, opencode: { autoInvestigate: true } },
        cluster: { image: `registry.example/shop-api:${known ? deployed.slice(0, 12) : "v9.9.9-unknown"}` },
      });
      try {
        cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
        await service.collect("shop-api/production");
        for (let i = 0; i < 40 && oc.prompts.length === 0; i++) {
          await service.work();
          await new Promise((r) => setTimeout(r, 100));
        }
        const prompt = oc.prompts[0] ?? "";
        const row = await service.read((db) => db.prepare("SELECT code_path AS path, code_commit AS commit_sha, code_deployed AS deployed FROM run_tokens").get() as { path: string; commit_sha: string | null; deployed: number });
        if (known) {
          expect(prompt).toContain(`Running in pods: ${deployed.slice(0, 12)}`);
          expect(row.commit_sha).toBe(deployed);
          expect(row.deployed).toBe(1);
          expect(readFileSync(join(row.path, "payments.ts"), "utf8")).toContain("TIMEOUT_MS = 300\n");
          expect(prompt).toContain(`the deployed commit ${deployed.slice(0, 12)}`);
        } else {
          expect(row.deployed).toBe(0);
          expect(row.commit_sha).toBe(head);
          expect(prompt).toContain("NOT the deployed code");
        }
        const token = /run token is (owt_[\w-]+)/.exec(prompt)?.[1] ?? "";
        const sessionId = (await service.read((db) => db.prepare("SELECT session_id FROM run_tokens").get() as { session_id: string })).session_id;
        const ports = (service as any).mcpPorts;
        const result = await fileFinding(ports, sessionId, {
          token,
          finding: {
            product: { impact: "x", affected: "x", since: "x", status: "x" },
            engineering: { verdict: "unsure", confidence: "low", cause: "x", causeBasis: "inferred", evidence: [], notChecked: [], nextCheck: "x" },
          },
        });
        expect(result).toBe("Recorded. Stop now.");
        const incidentId = await service.read((db) => (db.prepare("SELECT stream FROM journal WHERE type='IncidentOpened'").get() as { stream: string }).stream.split("/")[1]!);
        const page = await (async () => {
          for (let i = 0; i < 40; i++) {
            const p = (await client((api) => api.IncidentPage.get(incidentId as never))) as any;
            if (p?.findings.length) return p;
            await new Promise((r) => setTimeout(r, 100));
          }
          return undefined;
        })();
        expect(page.findings[0].finding.code.deployed).toBe(known);
        expect(page.findings[0].finding.code.commit).toBe(known ? deployed : head);
      } finally {
        await service.stop();
      }
    });
  }
});

describe("the worker reads only new messages in Overwatch's sessions", () => {
  test("each session is read from where the last read stopped, a page at a time; a typed prompt is adopted once", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { createServiceTables } = await import("../src/service/tables.ts");
    const { makeWorker } = await import("../src/service/worker.ts");
    const db = new DatabaseSync(":memory:");
    createServiceTables(db);
    db.prepare("INSERT INTO run_tokens (token, run_id, session_id, thread_id, subject, role, created_at) VALUES ('t', 'run_x', 'ses_x', 'thr_x', 'inc_x', 'investigator', 0)").run();
    // A long session: 300 messages, newest first as OpenCode lists them in descending order.
    const messages = Array.from({ length: 300 }, (_, i) => ({ id: `msg_${String(i).padStart(4, "0")}`, text: `message ${i}` })).reverse();
    let read = 0;
    const adopted: string[] = [];
    const port = {
      connect: async () => "x",
      createSession: async () => undefined,
      prompt: async () => undefined,
      synthetic: async () => undefined,
      newUserMessages: async (_session: string, after: string | undefined) => {
        const out: Array<{ id: string; text: string }> = [];
        for (const m of messages) {
          read++;
          if (m.id === after) break;
          out.push(m);
          if (out.length >= 20 && after === undefined) break;
        }
        return out.reverse();
      },
      promptState: async () => ({ kind: "running" as const }),
      interrupt: async () => undefined,
      answer: async () => undefined,
    };
    const worker = makeWorker({
      opencode: port as never,
      atomically: async (work: (d: typeof db) => unknown) => work(db),
      pendingRuns: async () => [],
      incidentPage: async () => null,
      prepareCode: async () => ({ directory: "/x", lines: [], basis: { path: "/x", commit: null, deployed: false, note: "no code" } }),
      runStatus: async () => undefined,
      markSent: async () => undefined,
      adopt: async (input: { messageId: string }) => void adopted.push(input.messageId),
      nudge: async () => undefined,
      fail: async () => undefined,
      now: () => 0,
      runTimeoutMs: 60_000,
      log: () => undefined,
    } as never);
    await worker.tick();
    const firstRead = read;
    read = 0;
    await worker.tick();
    expect(read).toBeLessThan(5);
    messages.unshift({ id: "msg_9999", text: "a new question typed in OpenCode" });
    const before = adopted.length;
    await worker.tick();
    await worker.tick();
    expect(adopted.slice(before)).toEqual(["msg_9999"]);
    expect(firstRead).toBeLessThan(300);
  });
});

describe("A1. redaction also covers what the collector keeps outside the model", () => {
  test("a secret in a log line reaches neither the de-duplication state, the report outbox, nor the events", async () => {
    const { service, cluster } = await testService();
    try {
      cluster.log(Date.now() - 60_000, `ERROR upstream refused ${SECRET}`);
      await service.collect("shop-api/production");
      const everything = await service.read((db) =>
        ["checkpoints", "coverage", "pending_reports", "journal", "objects", "search_docs", "search_terms", "watcher_runs"]
          .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))
          .join("\n"),
      );
      expect(everything).toContain("upstream refused");
      expect(everything).not.toContain(TOKEN);
    } finally {
      await service.stop();
    }
  });
});

describe("an unbuilt page is said, not served broken", () => {
  test("without web/dist the service answers / with how to build it, and the rest still works", async () => {
    const { tempDir } = await import("./fixtures/support.ts");
    const { service } = await testService({ deps: { webDir: tempDir("noweb") } });
    try {
      const page = await (await fetch(`${service.url}/`)).text();
      expect(page).toContain("pnpm run build:web");
      expect((await fetch(`${service.url}/status`)).status).toBe(200);
    } finally {
      await service.stop();
    }
  });
});

describe("B1. what is measured becomes an incident, with hysteresis; a metric not measured is unknown", () => {
  test("pods not ready for two polls open an incident; memory over its limit too; a metric with no new sample is unknown", async () => {
    const { service, cluster } = await testService();
    try {
      cluster.state.ready = false;
      cluster.state.memoryMi = 500; // limit 512Mi in the fake pod spec: about 98%
      await service.collect("shop-api/production");
      let opened = (await journalText(service)).match(/"_tag":"IncidentOpened"[^\n]*/g) ?? [];
      expect(opened.filter((e) => e.includes("metric:"))).toHaveLength(0); // one breaching sample is not enough
      await new Promise((r) => setTimeout(r, 5));
      await service.collect("shop-api/production");
      opened = (await journalText(service)).match(/"_tag":"IncidentOpened"[^\n]*/g) ?? [];
      expect(opened.some((e) => e.includes("metric:not_ready_pods"))).toBe(true);
      expect(opened.some((e) => e.includes("metric:memory_pct_of_limit"))).toBe(true);
      const state = await service.read((db) => db.prepare("SELECT metric, state FROM metric_state WHERE metric IN ('not_ready_pods','memory_pct_of_limit') ORDER BY metric").all().map((r) => `${r.metric}=${r.state}`));
      expect(state).toEqual(["memory_pct_of_limit=breach", "not_ready_pods=breach"]);
      // kubectl top stops answering: memory is no longer measured, so it is unknown, not fine.
      cluster.state.top = false;
      await new Promise((r) => setTimeout(r, 5));
      await service.collect("shop-api/production");
      const memory = await service.read((db) => db.prepare("SELECT state FROM metric_state WHERE metric = 'memory_pct_of_limit'").get() as { state: string });
      expect(memory.state).toBe("unknown");
    } finally {
      await service.stop();
    }
  });
});

describe("B3. the owner is told when a production incident opens and when its finding arrives, once each", () => {
  test("one notification per incident per kind, with the plain product summary; lower tiers are quiet by default", async () => {
    const notes: Array<{ title: string; body: string }> = [];
    const { service, cluster } = await testService({ deps: { notify: async (title: string, body: string) => void notes.push({ title, body }) } as never });
    try {
      cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
      await service.collect("shop-api/production");
      cluster.log(Date.now() - 1_000, "ERROR payment 43 timed out after 300ms");
      await service.collect("shop-api/production");
      const incident = await service.read((db) => (db.prepare("SELECT stream FROM journal WHERE type = 'IncidentOpened'").get() as { stream: string }).stream.split("/")[1]!);
      const finding = {
        product: { impact: "Some card payments fail at checkout", affected: "customers paying by card", since: "10:05 UTC", status: "ongoing" },
        engineering: { verdict: "real" as const, confidence: "high" as const, cause: "timeouts", causeBasis: "observed" as const, evidence: [], notChecked: [], nextCheck: "x" },
        ruledOut: [],
      };
      for (const runId of ["run_1", "run_2"]) {
        await service.runtime.runPromise(
          Effect.gen(function* () {
            const incidents = yield* Incident;
            yield* incidents.send(Incident.ref(IncidentId.make(incident)), new RecordFinding({ runId: RunId.make(runId), threadId: threadIdOf(IncidentId.make(incident)), sessionId: "ses", finding }));
          }) as never,
        );
      }
      for (let i = 0; i < 40 && notes.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
      expect(notes.map((n) => n.title)).toEqual(["New incident in shop-api/production", "Finding for shop-api/production"]);
      expect(notes[0]!.body).toContain("ERROR payment 42 timed out after 300ms");
      expect(notes[1]!.body).toBe("Some card payments fail at checkout. Affected: customers paying by card. Since: 10:05 UTC. Status: ongoing.");
    } finally {
      await service.stop();
    }
    const { parseConfig } = await import("../src/service/config.ts");
    const config = parseConfig({ apps: { a: { checkout: "/x", environments: { staging: { sources: { s: { type: "kubernetes", context: "c", namespace: "n", selector: "a=b" } } }, prod: { sources: { s: { type: "kubernetes", context: "c", namespace: "n", selector: "a=b" } } } } } } });
    expect(config.options.apps.a!.environments.staging!.notify).toBe(false);
    expect(config.options.apps.a!.environments.prod!.notify).toBe(true);
  });
});

describe("B4. environments at a glance", () => {
  test("status reports each environment's freshness and latest readings; the strip never shows unknown or stale as quiet", async () => {
    const { environmentChips } = await import("../web/src/app.ts");
    const { service, cluster } = await testService();
    try {
      const before = (await service.status()) as any;
      expect(environmentChips({ status: before, inbox: [] })[0]).toMatchObject({ key: "shop-api/production", state: "unchecked", label: "Not checked yet" });
      cluster.state.memoryMi = 256;
      await service.collect("shop-api/production");
      const after = (await service.status()) as any;
      const chip = environmentChips({ status: after, inbox: [] })[0]!;
      expect(chip.state).toBe("quiet");
      expect(chip.details).toContain("all pods ready");
      expect(chip.details).toContain("memory 50% of limit");
      // Hours later with no check: stale, not quiet.
      expect(environmentChips({ status: { ...after, at: after.at + 3 * 3_600_000 }, inbox: [] })[0]).toMatchObject({ state: "stale", label: "Not checked for 3h" });
      // A metric the last check did not sample reads as not measured.
      cluster.state.top = false;
      await service.collect("shop-api/production");
      const unmeasured = environmentChips({ status: (await service.status()) as any, inbox: [] })[0]!;
      expect(unmeasured.details).toContain("memory not measured");
      // An open incident, and a failing check.
      const item = { incidentId: "inc_1", title: "x", app: "shop-api", environment: "production", severity: "error", firstAt: 0, lastAt: 0, occurrences: 1, verdict: null, cause: null };
      expect(environmentChips({ status: after, inbox: [item as never] })[0]).toMatchObject({ state: "attention", label: "1 open" });
      const failing = { ...after, environments: [{ ...after.environments[0], lastError: "failed: pods" }] };
      expect(environmentChips({ status: failing, inbox: [] })[0]!.state).toBe("failing");
    } finally {
      await service.stop();
    }
  });
});

describe("B6. a finding's product summary can be copied as one paragraph", () => {
  test("the copy button copies the same paragraph the notification sends, and says it was copied", async () => {
    const app = (await import("../web/src/app.ts")) as Record<string, any>;
    const { productSummary } = await import("../src/domain/finding.ts");
    const product = { impact: "Some card payments fail at checkout", affected: "customers paying by card", since: "10:05 UTC", status: "ongoing" };
    const text = productSummary(product);
    expect(text).toBe("Some card payments fail at checkout. Affected: customers paying by card. Since: 10:05 UTC. Status: ongoing.");
    const result = app.update(app.init({ session: "s" }).model, app.Message.ClickedCopySummary({ runId: "run_1", text }));
    expect(result.model.copiedSummary).toBe("run_1");
    expect(result.commands).toHaveLength(1);
  });
});
