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
