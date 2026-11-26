import { scratch } from "./scratch.ts";
/**
 * One property per class of defect: the rule lives in one place, and these generate the inputs or call sequences
 * that the next caller might bring, and check the invariant holds for all of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { endpoint, IDENTITY, quietStep } from "../src/collect.ts";
import { AppConfig, LIMITS, parseConfig, type Config, type Source } from "../src/config.ts";
import { Full } from "../src/errors.ts";
import { act, ask, deadlines, keyed } from "../src/inbox.ts";
import { num, sample } from "../src/parse.ts";
import { references, Store, TABLES, json, type Clean, type StoreShape } from "../src/store.ts";
import { clock } from "../src/clock.ts";
import { run, withConfig, withStore } from "./effect.ts";

const dir = () => scratch("ow-class-test-");
const REFS = references();
const config = (dataDir: string) =>
  parseConfig(
    { version: 2, dataDir, apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } }, watchers: [{ app: "shop", environment: "prod", every: "1m" }] },
    join(dataDir, "c.json"),
  );
/** A database with one production error, owned for `body`, with the configuration provided. */
function withIncident<A, E>(body: (r: { d: string; store: StoreShape; config: Config }) => Effect.Effect<A, E, Store | AppConfig>): Promise<A> {
  const d = dir();
  const c = config(d);
  return run(
    withStore(d, (store) =>
      Effect.gen(function* () {
        clock.set(Date.UTC(2026, 10, 1), 1e6);
        yield* store.tx((w) =>
          Effect.gen(function* () {
            const seq = yield* w.event("slice", "shop/prod/pods" as Clean, {});
            yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_1', 'shop', 'prod', 'shop/prod/pods', 'ERROR x', 'error', 1, 1, 0, 0, ?, ?)", seq, seq);
          }),
        );
        return yield* body({ d, store, config: c });
      }).pipe(withConfig(c)),
    ),
  );
}
/** The failure's tag or message, or "succeeded". */
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    if (Exit.isSuccess(exit)) return "succeeded";
    const reason = exit.cause.reasons[0] as { error?: { _tag?: string; message?: string }; defect?: unknown };
    return reason.error ? `${reason.error._tag}: ${reason.error.message}` : String(reason.defect);
  });

test("class: a value from outside is measured only when it is a finite number, whatever its shape", () => {
  const numeric = fc.tuple(fc.integer(), fc.integer({ min: -400, max: 400 })).map(([m, e]) => `${m}e${e}`);
  fc.assert(
    fc.property(fc.oneof(fc.string(), numeric, fc.double(), fc.constantFrom(null, undefined, true, "1e999", "-1e999", "NaN", "Infinity", " 7 "), fc.object()), (v) => {
      const n = num(v), s = sample(v);
      assert.ok(n === null || Number.isFinite(n));
      assert.equal(s.measured, n !== null);
      if (s.measured) assert.equal(s.value, n);
    }),
    { numRuns: 2000 },
  );
});

test("class: Quiet needs three consecutive new, ordinary, fully measured intervals with nothing new", () => {
  const interval = fc.record({ touched: fc.boolean(), measured: fc.boolean(), ordinary: fc.boolean() });
  fc.assert(
    fc.property(fc.array(interval, { maxLength: 30 }), (seq) => {
      let streak = 0;
      seq.forEach((i, n) => {
        const r = quietStep(streak, i);
        const tail = seq.slice(Math.max(0, n - LIMITS.quietIntervals + 1), n + 1);
        // Quiet now iff the trailing run of good intervals (since the last reset or quiet) just reached three.
        let run = 0;
        for (let k = n; k >= 0 && !seq[k]!.touched && seq[k]!.measured && seq[k]!.ordinary; k--) run++;
        assert.equal(r.quiet, run > 0 && run % LIMITS.quietIntervals === 0, JSON.stringify(tail));
        streak = r.streak;
      });
    }),
  );
});

test("class: two sources share a refusal only when every field that identifies the connection is equal", () => {
  const base = config(dir()).sources[0]!;
  const dd = { ...base, kind: "datadog" as const, baseUrl: "https://dd.example", apiKey: "env:A", appKey: "env:B" };
  fc.assert(
    fc.property(fc.constantFrom<Source>(base, dd), fc.option(fc.constantFrom("context", "baseUrl", "apiKey", "appKey", "namespace", "selector", "query"), { nil: null }), (s, field) => {
      const other = field ? { ...s, [field]: `${String((s as unknown as Record<string, unknown>)[field])}-other` } : s;
      const identifying = field !== null && (IDENTITY[s.kind] as ReadonlyArray<string>).includes(field);
      assert.equal(endpoint(s) === endpoint(other), !identifying);
    }),
  );
});

test("class: every write passes one admission; when the disk is short nothing is written, by any path", async () => {
  const short = Effect.fail(new Full({ message: "short" }));
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom("done", "later", "never", "seen", "ask", "deadline", "raw"), { minLength: 1, maxLength: 6 }), (ops) =>
      withIncident(({ store }) =>
        Effect.gen(function* () {
          yield* store.setGuard(short);
          const before = yield* store.seq;
          for (const op of ops) {
            const attempt = Effect.gen(function* () {
              if (op === "ask") return yield* keyed("rk_" + "a".repeat(24), yield* ask({ subject: "inc_1", text: "why?", mode: "auto" }));
              if (op === "deadline") {
                yield* store.setGuard(null);
                yield* act("inc_1", { action: "later", untilMs: clock.now() + 1 }, null);
                yield* store.setGuard(short);
                clock.set(clock.now() + 2, clock.mono() + 2);
                return yield* deadlines;
              }
              if (op === "raw") return yield* store.tx((w) => w.event("slice", null, {}));
              return yield* act("inc_1", op === "seen" ? { action: "seen", throughSeq: yield* store.seq } : { action: op }, null);
            });
            const at = yield* store.seq;
            if (op === "deadline") {
              assert.match(yield* failure(attempt), /^Full/);
              assert.equal((yield* store.get<{ n: number }>("SELECT count(*) AS n FROM events WHERE kind = 'returned'"))!.n, 0);
            } else if (op === "seen" && (yield* store.get<{ s: number }>("SELECT seen_seq AS s FROM incidents"))!.s >= (yield* store.seq)) continue;
            else {
              assert.match(yield* failure(attempt), /^Full/);
              assert.equal(yield* store.seq, at);
            }
          }
          assert.ok((yield* store.seq) >= before);
        }),
      ),
    ),
    { numRuns: 40 },
  );
});

test("class: retention never removes a finding or evidence a finding cites, at any age or pressure", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.record({ trial: fc.boolean(), ageDays: fc.integer({ min: 0, max: 60 }), cite: fc.boolean() }), { minLength: 1, maxLength: 8 }),
      fc.array(fc.tuple(fc.integer({ min: 0, max: 90 }), fc.boolean()), { minLength: 1, maxLength: 4 }),
      (runs, passes) =>
        run(
          withStore(dir(), (store) =>
            Effect.gen(function* () {
              const now = Date.UTC(2026, 10, 1);
              const cited: string[] = [];
              for (const [n, r] of runs.entries()) {
                const job = `job_${String(n).padStart(24, "0")}`, run = `run_${String(n).padStart(24, "0")}`, handle = `e_${String(n).padStart(24, "0")}`;
                yield* store.tx((w) =>
                  Effect.gen(function* () {
                    const seq = yield* w.event("job", job as Clean, {});
                    yield* w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq) VALUES (?, ?, 'inc_1', 't', 'completed', NULL, ?)", job as Clean, (r.trial ? "trial" : "investigation") as Clean, seq);
                    yield* w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms) VALUES (?, ?, 1, ?, 'terminal', 1, ?, ?)", run as Clean, job as Clean, `ses_${n}` as Clean, json({}), now - r.ageDays * 86_400_000);
                    yield* w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES (?, ?, ?, 'pods', 'piece', 1)", handle as Clean, run as Clean, `ses_${n}` as Clean);
                    if (r.cite) {
                      yield* w.run("INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES (?, ?, 'unsure', ?, ?, ?)", `f_${n}` as Clean, run as Clean, json([{ statement: "s", pieces: [{ handle, source: "pods", text: "piece" }] }]), json({}), json({}));
                      cited.push(handle);
                    }
                  }),
                );
              }
              for (const [days, pressure] of passes) {
                if (pressure) yield* store.retain(now + days * 86_400_000, Effect.succeed(true), 1);
                else yield* store.expire(now + days * 86_400_000);
              }
              const kept = new Set((yield* store.all<{ handle: string }>("SELECT handle FROM evidence")).map((r) => r.handle));
              assert.ok(cited.every((h) => kept.has(h)), "every cited handle survives");
              assert.equal((yield* store.get<{ n: number }>("SELECT count(*) AS n FROM findings"))!.n, cited.length);
              // And the database itself refuses it, whoever asks.
              if (cited.length) assert.match(yield* failure(store.tx((w) => w.run("DELETE FROM evidence WHERE handle = ?", cited[0] as Clean))), /FOREIGN KEY/);
            }),
          ),
        ),
    ),
    { numRuns: 30 },
  );
});

test("class: a restored copy that breaks any declared reference is refused whole", async () => {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  await fc.assert(
    // Every reference the schema implies, read from the schema itself: a new table's references are covered without a list.
    fc.asyncProperty(fc.constantFrom(...REFS.filter(([t, c]) => t !== "citations" && t !== "notifications" && !(t === "work" && c === "run_id"))), (ref) =>
      withIncident(({ d, store }) =>
        Effect.gen(function* () {
          yield* keyed("rk_" + "b".repeat(24), yield* ask({ subject: "inc_1", text: "why?", mode: "auto" }));
          yield* store.tx((w) =>
            Effect.gen(function* () {
              const seq = yield* w.event("job", null, {});
              yield* w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq) VALUES ('job_x', 'investigation', 'inc_1', 't', 'completed', NULL, ?)", seq);
              for (const statement of [
                "INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms) VALUES ('run_x', 'job_x', 1, 'ses_x', 'terminal', 1, '{}', 0)",
                "INSERT INTO messages (id, run_id, purpose) VALUES ('msg_x', 'run_x', 'prompt')",
                "INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES ('e_x', 'run_x', 'ses_x', 'pods', 'p', 1)",
                "INSERT INTO origins (handle, origin) VALUES ('e_x', 'telemetry')",
                "INSERT INTO onsets (incident, at_ms) VALUES ('inc_1', 0)",
                "INSERT INTO comparisons (id, app, staging_revision, start_seq, state, data, incident) VALUES ('cmp_x', 'shop', 'a', 1, 'regression', '{}', 'inc_1')",
                "INSERT INTO proposals (run_id, body) VALUES ('run_x', '{}')",
                "INSERT INTO fixes (id, incident, job_id, app, environment, origin, state, run_id, seq) VALUES ('fx_x', 'inc_1', 'job_x', 'shop', 'prod', 'manual', 'blocked', 'run_x', 1)",
                "INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES ('f_x', 'run_x', 'unsure', '[]', '{}', '{}')",
                "INSERT INTO occurrences (key, source, stream, at_ms, incident) VALUES ('k', 's', 's', 0, 'inc_1')",
                "INSERT INTO hourly (incident, hour, count) VALUES ('inc_1', 1, 1)",
                "INSERT INTO lines (incident, source, at_ms, text) VALUES ('inc_1', 'pods', 0, 'ERROR x')",
                "INSERT INTO work (id, job_id, kind, slot, priority, state, seq) VALUES ('w_x', 'job_x', 'reading', 1, 1, 'done', 1)",
                "INSERT INTO corrections (seq, app, subject, job_id, text, date) VALUES (1, 'shop', 'inc_1', 'job_x', 'note', '2026-11-01')",
              ])
                yield* w.run(statement);
            }),
          );
          const file = join(d, "copy.db");
          yield* store.backup(file);
          const before = yield* store.all("SELECT * FROM incidents");
          const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
          const [table, column] = ref;
          db.prepare(`UPDATE ${table} SET ${column} = 'orphan'`).run();
          db.close();
          assert.match(yield* failure(store.restore(file)), /cannot be restored/);
          assert.deepEqual(yield* store.all("SELECT * FROM incidents"), before);
        }),
      ),
    ),
    { numRuns: REFS.length * 2 },
  );
});

test("class: a decision is bound to what was reviewed; interleaved tabs never replace a newer decision", async () => {
  const ways = fc.constantFrom("done", "later", "never");
  await fc.assert(
    fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom("a", "b"), fc.constantFrom("open", "confirm"), ways), { maxLength: 14 }), (steps) =>
      withIncident(({ store }) =>
        Effect.gen(function* () {
          const decided = Effect.map(store.get<{ d: number }>("SELECT decided_seq AS d FROM incidents"), (r) => r!.d);
          const sheets: Record<string, number | null> = { a: null, b: null };
          let last: string | null = null;
          for (const [tab, step, way] of steps) {
            if (step === "open") sheets[tab] = yield* decided;
            else if (sheets[tab] !== null) {
              const basis = sheets[tab]!;
              sheets[tab] = null;
              if (basis === (yield* decided)) {
                yield* act("inc_1", { action: way }, basis);
                last = way;
              } else assert.match(yield* failure(act("inc_1", { action: way }, basis)), /decided again/);
            }
          }
          const kind = (yield* store.get<{ k: string | null }>("SELECT json_extract(way, '$.kind') AS k FROM incidents"))!.k;
          assert.equal(kind, last);
        }),
      ),
    ),
    { numRuns: 60 },
  );
});

test("build: every column of every created table is declared, as data or as a reference to a named parent", () =>
  run(
    withStore(dir(), (store) =>
      Effect.gen(function* () {
        for (const t of TABLES) {
          const created = (yield* store.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t.name}')`)).map((c) => c.name).sort();
          assert.deepEqual(created, [...t.columns].sort(), `${t.name} has an undeclared or missing column`);
          // A foreign key the database knows is a reference, never data: its declaration must say so.
          for (const fk of yield* store.all<{ from: string; table: string; to: string | null }>(`SELECT "from", "table", "to" FROM pragma_foreign_key_list('${t.name}')`))
            assert.equal(t.refs?.[fk.from], `${fk.table}.${fk.to ?? "id"}`, `${t.name}.${fk.from} REFERENCES ${fk.table} but is declared as data`);
          for (const [column, to] of Object.entries(t.refs ?? {})) {
            assert.ok(t.columns.includes(column), `${t.name}.${column} is a reference to an undeclared column`);
            assert.ok(TABLES.some((p) => p.name === to.split(".")[0] && p.columns.includes(to.split(".")[1]!)), `${t.name}.${column} refers to ${to}, which is not declared`);
          }
        }
      }),
    ),
  ));

test("build: only src/exec.ts starts a program, and only adapters open a connection", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  for (const f of readdirSync(src).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(join(src, f), "utf8");
    // Other modules may name the ChildProcessSpawner requirement in a type; only exec.ts makes or spawns a command.
    if (f !== "exec.ts") assert.doesNotMatch(text, /node:child_process|ChildProcess\.make\(|\.spawn\(|\bexecFile\(/, `${f} starts a program outside exec.ts`);
    if (!["opencode.ts", "datadog.ts", "doctor.ts", "main.ts"].includes(f)) assert.doesNotMatch(text, /\bfetch\(|yield\* HttpClient\.HttpClient|HttpClientRequest\./, `${f} opens a connection outside the adapters`);
  }
});

test("build: a provider time is made only in parse.ts; the one cast for a live read is named and used only by the collector", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  for (const f of readdirSync(src).filter((n) => n.endsWith(".ts") && n !== "parse.ts")) {
    const text = readFileSync(join(src, f), "utf8");
    assert.doesNotMatch(text, /as (?:unknown as )?ProviderTime\b|providerTime: true/, `${f} makes a provider time outside parse.ts`);
    if (f !== "collect.ts") assert.doesNotMatch(text, /\banswered\(/, `${f} casts the wall clock to a provider time`);
  }
});

test("build: the request key is read only by the keyed router, and only keyed() can take a receipt", () => {
  const src = new URL("../src/", import.meta.url).pathname;
  const reads = readdirSync(src).filter((n) => n.endsWith(".ts")).flatMap((f) => (readFileSync(join(src, f), "utf8").match(/headers\["idempotency-key"\]/gi) ?? []).map(() => f));
  assert.deepEqual(reads, ["server.ts"], "a route reads the request key outside the keyed router");
  assert.doesNotMatch(readFileSync(join(src, "inbox.ts"), "utf8"), /export function receipt/);
  // Every POST goes through the one route table, whose guard is keyed, fenced or a command; basisSeq is read in one place.
  const server = readFileSync(join(src, "server.ts"), "utf8");
  assert.equal(server.match(/router\.add\("POST"/g)?.length, 1, "a POST route is added outside the WRITES table");
  for (const f of readdirSync(src).filter((n) => n.endsWith(".ts") && n !== "server.ts" && n !== "mcp.ts"))
    assert.doesNotMatch(readFileSync(join(src, f), "utf8"), /router\.add\(\s*["'`]POST/, `${f} adds a POST route outside the WRITES table`);
  const basis = readdirSync(src).filter((n) => n.endsWith(".ts")).flatMap((f) => (readFileSync(join(src, f), "utf8").match(/body\.basisSeq/g) ?? []).map(() => f));
  assert.deepEqual([...new Set(basis)], ["inbox.ts"], "basisSeq is read outside basisOf");
});
