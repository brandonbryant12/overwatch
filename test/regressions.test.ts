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
      opencode: { connect: async () => "x", createSession: async () => undefined, prompt: async () => undefined, synthetic: async () => undefined, userMessages: async () => [], promptState: async () => ({ kind: "running" as const }), interrupt: async () => undefined, answer: async () => undefined } as never,
      atomically: async (work: (d: typeof db) => unknown) => work(db),
      pendingRuns: async () => [{ runId: RunId.make("run_c"), threadId: thread, subject: page.incidentId, promptId: "p", mode: "investigate", sessionId: "ses_c", messageId: messageIdOf(thread, "p"), newSession: true, delivery: null, text: question, origin: "page", handoff: null, status: "requested" as const, nudges: [], at: 0 }] as never,
      incidentPage: async () => page as never,
      checkoutOf: () => undefined,
      worktree: async () => "/nonexistent",
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
  test("a lock left by a process that died is taken over; one held by a live process is refused", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { acquireWriterLock } = await import("../src/host/lock.ts");
    const { tempDir } = await import("./fixtures/support.ts");
    const file = join(tempDir("lock"), "overwatch.sqlite");
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2_147_483_000, purpose: "service" }));
    acquireWriterLock(file).release();
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    try {
      writeFileSync(`${file}.lock`, JSON.stringify({ pid: other.pid, purpose: "service", since: "earlier" }));
      expect(() => acquireWriterLock(file)).toThrow(`(pid ${other.pid}`);
    } finally {
      other.kill();
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
