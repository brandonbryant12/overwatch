/**
 * One property per class of defect: the rule lives in one place, and these generate the inputs or call sequences
 * that the next caller might bring, and check the invariant holds for all of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpoint, IDENTITY, quietStep } from "../src/collect.ts";
import { LIMITS, parseConfig, type Source } from "../src/config.ts";
import { act, ask, deadlines } from "../src/inbox.ts";
import { num, sample } from "../src/parse.ts";
import { Full, references, Store, json, type Clean } from "../src/store.ts";
import { clock } from "../src/clock.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ow-class-test-"));
const REFS = (() => {
  const store = Store.own(dir());
  try {
    return references((sql) => store.all(sql));
  } finally {
    store.close();
  }
})();
const config = (dataDir: string) =>
  parseConfig(
    { version: 2, dataDir, apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } }, watchers: [{ app: "shop", environment: "prod", every: "1m" }] },
    join(dataDir, "c.json"),
  );
function withIncident() {
  const d = dir();
  const store = Store.own(d);
  clock.set(Date.UTC(2026, 10, 1), 1e6);
  store.tx((w) => {
    const seq = w.event("slice", "shop/prod/pods" as Clean, {});
    w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_1', 'shop', 'prod', 'shop/prod/pods', 'ERROR x', 'error', 1, 1, 0, 0, ?, ?)", seq, seq);
  });
  return { d, store, config: config(d) };
}

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

test("class: every write passes one admission; when the disk is short nothing is written, by any path", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom("done", "later", "never", "seen", "ask", "deadline", "raw"), { minLength: 1, maxLength: 6 }), (ops) => {
      const { store, config } = withIncident();
      store.guard = () => {
        throw new Full("short");
      };
      const before = store.seq();
      for (const op of ops) {
        const run = () => {
          if (op === "ask") ask(store, config, { subject: "inc_1", text: "why?", mode: "auto" }, "rk_" + "a".repeat(24));
          else if (op === "deadline") {
            store.guard = null;
            act(store, config, "inc_1", { action: "later", untilMs: clock.now() + 1 });
            store.guard = () => {
              throw new Full("short");
            };
            clock.set(clock.now() + 2, clock.mono() + 2);
            return void deadlines(store);
          } else if (op === "raw") store.tx((w) => w.event("slice", null, {}));
          else act(store, config, "inc_1", op === "seen" ? { action: "seen", throughSeq: store.seq() } : { action: op });
        };
        const at = store.seq();
        if (op === "deadline") {
          assert.throws(run, Full);
          assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM events WHERE kind = 'returned'")!.n, 0);
        } else if (op === "seen" && store.get<{ s: number }>("SELECT seen_seq AS s FROM incidents")!.s >= store.seq()) continue;
        else {
          assert.throws(run, Full);
          assert.equal(store.seq(), at);
        }
      }
      assert.ok(store.seq() >= before);
      store.close();
    }),
    { numRuns: 40 },
  );
});

test("class: retention never removes a finding or evidence a finding cites, at any age or pressure", () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({ trial: fc.boolean(), ageDays: fc.integer({ min: 0, max: 60 }), cite: fc.boolean() }), { minLength: 1, maxLength: 8 }),
      fc.array(fc.tuple(fc.integer({ min: 0, max: 90 }), fc.boolean()), { minLength: 1, maxLength: 4 }),
      (runs, passes) => {
        const store = Store.own(dir());
        const now = Date.UTC(2026, 10, 1);
        const cited: string[] = [];
        runs.forEach((r, n) => {
          const job = `job_${String(n).padStart(24, "0")}`, run = `run_${String(n).padStart(24, "0")}`, handle = `e_${String(n).padStart(24, "0")}`;
          store.tx((w) => {
            const seq = w.event("job", job as Clean, {});
            w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq) VALUES (?, ?, 'inc_1', 't', 'completed', NULL, ?)", job as Clean, (r.trial ? "trial" : "investigation") as Clean, seq);
            w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms) VALUES (?, ?, 1, ?, 'terminal', 1, ?, ?)", run as Clean, job as Clean, `ses_${n}` as Clean, json({}), now - r.ageDays * 86_400_000);
            w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES (?, ?, ?, 'pods', 'piece', 1)", handle as Clean, run as Clean, `ses_${n}` as Clean);
            if (r.cite) {
              w.run("INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES (?, ?, 'unsure', ?, ?, ?)", `f_${n}` as Clean, run as Clean, json([{ statement: "s", pieces: [{ handle, source: "pods", text: "piece" }] }]), json({}), json({}));
              cited.push(handle);
            }
          });
        });
        for (const [days, pressure] of passes) {
          if (pressure) store.retain(now + days * 86_400_000, () => true, 1);
          else store.expire(now + days * 86_400_000);
        }
        const kept = new Set(store.all<{ handle: string }>("SELECT handle FROM evidence").map((r) => r.handle));
        assert.ok(cited.every((h) => kept.has(h)), "every cited handle survives");
        assert.equal(store.get<{ n: number }>("SELECT count(*) AS n FROM findings")!.n, cited.length);
        // And the database itself refuses it, whoever asks.
        if (cited.length) assert.throws(() => store.tx((w) => w.run("DELETE FROM evidence WHERE handle = ?", cited[0] as Clean)), /FOREIGN KEY/);
        store.close();
      },
    ),
    { numRuns: 30 },
  );
});

test("class: a restored copy that breaks any declared reference is refused whole", () => {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  fc.assert(
    // Every reference the schema implies, read from the schema itself: a new table's references are covered without a list.
    fc.property(fc.constantFrom(...REFS.filter(([t, c]) => t !== "citations" && t !== "notifications" && !(t === "work" && c === "run_id"))), (ref) => {
      const { d, store, config } = withIncident();
      ask(store, config, { subject: "inc_1", text: "why?", mode: "auto" }, "rk_" + "b".repeat(24));
      store.tx((w) => {
        const seq = w.event("job", null, {});
        w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq) VALUES ('job_x', 'investigation', 'inc_1', 't', 'completed', NULL, ?)", seq);
        w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms) VALUES ('run_x', 'job_x', 1, 'ses_x', 'terminal', 1, '{}', 0)");
        w.run("INSERT INTO messages (id, run_id, purpose) VALUES ('msg_x', 'run_x', 'prompt')");
        w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES ('e_x', 'run_x', 'ses_x', 'pods', 'p', 1)");
        w.run("INSERT INTO origins (handle, origin) VALUES ('e_x', 'telemetry')");
        w.run("INSERT INTO onsets (incident, at_ms) VALUES ('inc_1', 0)");
        w.run("INSERT INTO comparisons (id, app, staging_revision, start_seq, state, data, incident) VALUES ('cmp_x', 'shop', 'a', 1, 'regression', '{}', 'inc_1')");
        w.run("INSERT INTO proposals (run_id, body) VALUES ('run_x', '{}')");
        w.run("INSERT INTO fixes (id, incident, job_id, app, environment, origin, state, run_id, seq) VALUES ('fx_x', 'inc_1', 'job_x', 'shop', 'prod', 'manual', 'blocked', 'run_x', 1)");
        w.run("INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES ('f_x', 'run_x', 'unsure', '[]', '{}', '{}')");
        w.run("INSERT INTO occurrences (key, source, stream, at_ms, incident) VALUES ('k', 's', 's', 0, 'inc_1')");
        w.run("INSERT INTO hourly (incident, hour, count) VALUES ('inc_1', 1, 1)");
        w.run("INSERT INTO lines (incident, source, at_ms, text) VALUES ('inc_1', 'pods', 0, 'ERROR x')");
        w.run("INSERT INTO work (id, job_id, kind, slot, priority, state, seq) VALUES ('w_x', 'job_x', 'reading', 1, 1, 'done', 1)");
        w.run("INSERT INTO corrections (seq, app, subject, job_id, text, date) VALUES (1, 'shop', 'inc_1', 'job_x', 'note', '2026-11-01')");
      });
      const file = join(d, "copy.db");
      store.backup(file);
      const before = store.all("SELECT * FROM incidents");
      const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
      const [table, column] = ref;
      db.prepare(`UPDATE ${table} SET ${column} = 'orphan'`).run();
      db.close();
      assert.throws(() => store.restore(file), /cannot be restored/);
      assert.deepEqual(store.all("SELECT * FROM incidents"), before);
      store.close();
    }),
    { numRuns: REFS.length * 2 },
  );
});

test("class: a decision is bound to what was reviewed; interleaved tabs never replace a newer decision", () => {
  const ways = fc.constantFrom("done", "later", "never");
  fc.assert(
    fc.property(fc.array(fc.tuple(fc.constantFrom("a", "b"), fc.constantFrom("open", "confirm"), ways), { maxLength: 14 }), (steps) => {
      const { store, config } = withIncident();
      const decided = () => store.get<{ d: number }>("SELECT decided_seq AS d FROM incidents")!.d;
      const sheets: Record<string, number | null> = { a: null, b: null };
      let last: string | null = null;
      for (const [tab, step, way] of steps) {
        if (step === "open") sheets[tab] = decided();
        else if (sheets[tab] !== null) {
          const basis = sheets[tab]!;
          sheets[tab] = null;
          if (basis === decided()) {
            act(store, config, "inc_1", { action: way, basisSeq: basis });
            last = way;
          } else assert.throws(() => act(store, config, "inc_1", { action: way, basisSeq: basis }), /decided again/);
        }
      }
      const kind = store.get<{ k: string | null }>("SELECT json_extract(way, '$.kind') AS k FROM incidents")!.k;
      assert.equal(kind, last);
      store.close();
    }),
    { numRuns: 60 },
  );
});
