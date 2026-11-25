/**
 * Runs the ledger model on the SQLite host in its own process, for crash.test.ts.
 *
 *   node crash-child.ts <db file>
 *
 * Sends three deposits with fixed command ids (a client retrying after a crash sends the same ids), waits until
 * every reaction has happened, and prints a summary as JSON. With OVERWATCH_CRASH=<point>@<n> it kills itself at the
 * nth hit of that point instead. With OVERWATCH_COUNT=1 it prints how many times each point was hit.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { faultsFromEnv, type FaultPoint } from "../../src/host/connection.ts";
import { layerSqlite, SqliteHost } from "../../src/host/sqlite.ts";
import { bigDepositsLive, Ledger, LedgerApi } from "./ledger.model.ts";
import { waitFor } from "./support.ts";

const file = process.argv[2]!;
const counts: Record<string, number> = {};
const crash = faultsFromEnv();
const faults = {
  hit: (point: FaultPoint) => {
    counts[point] = (counts[point] ?? 0) + 1;
    crash.hit(point);
  },
};
const settled = (v: unknown, want: object) => v !== null && Object.entries(want).every(([k, x]) => (v as Record<string, unknown>)[k] === x);

const program = Effect.gen(function* () {
  const api = yield* LedgerApi.clientInProcess;
  yield* api.Deposit("a-1", { amount: 700 }, { commandId: "c-1" });
  yield* api.Deposit("a-2", { amount: 600 }, { commandId: "c-2" });
  yield* api.Deposit("a-1", { amount: 10 }, { commandId: "c-3" });
  const t = 25_000;
  const summary1 = (yield* waitFor(api.Summary.get("a-1"), (v) => settled(v, { deposits: 2, reminders: 1 }), t)).value;
  const summary2 = (yield* waitFor(api.Summary.get("a-2"), (v) => settled(v, { deposits: 1, reminders: 1 }), t)).value;
  const audit1 = (yield* waitFor(api.AuditView.get("a-1"), (v) => settled(v, { flags: 1 }), t)).value;
  const audit2 = (yield* waitFor(api.AuditView.get("a-2"), (v) => settled(v, { flags: 1 }), t)).value;
  const host = yield* SqliteHost;
  const journal = yield* host.connection.use((db) =>
    db.prepare("SELECT stream, version, type FROM journal ORDER BY position").all().map((r) => `${r.stream}#${r.version}:${r.type}`),
  );
  return { summary1, summary2, audit1, audit2, journal };
}).pipe(
  Effect.scoped,
  Effect.provide(Ledger.layer(bigDepositsLive("200 millis")).pipe(Layer.provideMerge(layerSqlite({ file, tickMs: 100, faults })))),
);

const result = await Effect.runPromise(program);
process.stdout.write(JSON.stringify({ result, counts }) + "\n");
