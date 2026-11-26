import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { testService, offline } from "./service.ts";
import { IncidentId, RunId, threadIdOf } from "../../src/domain/ids.ts";
import { Incident, RecordFinding } from "../../src/domain/incident.ts";
import * as Effect from "effect/Effect";

export { testService, offline, IncidentId, threadIdOf, join, delay };
export const watcher = "shop-api/production";
export type Fixture = Awaited<ReturnType<typeof testService>>;
export async function until<A>(read: () => Promise<A>, ready: (v: A) => boolean, ms = 15_000): Promise<A> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= end) throw Error("Timed out waiting for fixture state: " + JSON.stringify(value));
    await delay(40);
  }
}
export async function seed(f: Fixture, text = "ERROR payment timed out") {
  f.cluster.log(Date.now() - 1_000, text);
  await f.service.collect(watcher);
  return f.service.read((db) => {
    const row = db.prepare("SELECT stream FROM journal WHERE type='IncidentOpened' ORDER BY position DESC LIMIT 1").get();
    if (!row) throw Error("Seed incident did not open");
    return IncidentId.make(String(row.stream).slice("Incident/".length));
  });
}
export function plainFinding(cause: string, quote = cause) {
  return {
    product: { impact: cause, affected: "customers", since: "today", status: "ongoing" },
    engineering: {
      verdict: "real" as const,
      confidence: "high" as const,
      cause,
      causeBasis: "observed" as const,
      evidence: [{ source: "pods", quote, verified: true }],
      notChecked: [],
      nextCheck: "Check the next poll",
    },
    ruledOut: [],
  };
}
export async function recordFinding(f: Fixture, id: IncidentId, cause: string, run = "run_feedback") {
  await f.service.runtime.runPromise(
    Effect.gen(function* () {
      const incidents = yield* Incident;
      yield* incidents.send(
        Incident.ref(id),
        new RecordFinding({ runId: RunId.make(run), threadId: threadIdOf(id), sessionId: "ses_fixture", finding: plainFinding(cause) }),
      );
    }) as Effect.Effect<void, never, never>,
  );
}
export function databaseText(db: DatabaseSync) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => {
      const name = String(row.name).replaceAll('"', '""');
      return JSON.stringify(db.prepare('SELECT * FROM "' + name + '"').all());
    })
    .join("\n");
}
