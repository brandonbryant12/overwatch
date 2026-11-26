import { scratch } from "./scratch.ts";
/**
 * Milestone 3 classes: adjudication is a pure function of stored filings; the queue serves the owner first; a
 * playbook is the database's, rebuilt whole; owner tools never serve a session Overwatch runs; a team brief never
 * carries internal text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { adjudicate, Agents, nextWork, type Challenge, type Reading } from "../src/agents.ts";
import { brief } from "../src/brief.ts";
import { parseConfig } from "../src/config.ts";
import { json, type Clean } from "../src/store.ts";
import { Tools, type Owner } from "../src/tools.ts";
import { clock } from "../src/clock.ts";
import { run, withConfig, withStore } from "./effect.ts";

const verdict = fc.constantFrom<"real" | "not_real" | "unsure" | null>("real", "not_real", "unsure", null);

test("class: adjudication follows the decision table for every vote and challenge", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 3 }).chain((n) => fc.tuple(fc.constant(n), fc.array(fc.tuple(verdict, fc.boolean()), { minLength: n, maxLength: n }))),
      fc.option(fc.constantFrom<Challenge["outcome"]>("upheld", "disproved", "unsure", null), { nil: undefined }),
      ([planned, votes], outcome) => {
        const readings: Reading[] = votes.map(([v, telemetry], i) => ({ slot: i + 1, sessionId: null, verdict: v, findingId: v ? `f${i}` : null, reason: v ? null : "missing", telemetry }));
        const challenge = outcome === undefined ? null : { outcome, reason: "r", pieces: [] };
        const r = adjudicate(planned, readings, challenge);
        const real = votes.filter(([v]) => v === "real").length, notReal = votes.filter(([v]) => v === "not_real").length;
        // The denominator is every planned slot; a missing reading is a vote for nothing.
        assert.equal(r.counts.real + r.counts.not_real + r.counts.unsure + r.counts.missing, planned);
        const expected = real > planned / 2 ? (outcome === "upheld" ? "real" : outcome === "disproved" ? "not_real" : "unsure") : notReal > planned / 2 ? "not_real" : "unsure";
        assert.equal(r.verdict, expected);
        assert.equal(r.observed, r.verdict === "real" && votes.some(([v, t]) => v === "real" && t));
        if (r.observed) assert.equal(r.verdict, "real");
      }),
    { numRuns: 2000 },
  );
});

function rig() {
  const dataDir = scratch("ow-agents-test-");
  const config = parseConfig(
    { version: 2, dataDir, apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } }, watchers: [{ app: "shop", environment: "prod", every: "1m" }] },
    join(dataDir, "c.json"),
  );
  clock.set(Date.UTC(2026, 10, 1), 1e6);
  return { dataDir, config };
}

test("class: a free slot takes the oldest owner question before any investigation, one question per conversation", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.record({ owner: fc.boolean(), conversation: fc.integer({ min: 0, max: 2 }) }), { minLength: 1, maxLength: 10 }), (items) => {
      const { dataDir } = rig();
      return run(
        withStore(dataDir, (store) =>
          Effect.gen(function* () {
            yield* store.tx((w) =>
              Effect.gen(function* () {
                for (const c of [0, 1, 2]) yield* w.run(`INSERT INTO jobs (id, kind, subject, title, state, created_seq) VALUES ('job_c${c}', 'ask', 's', 't', 'queued', 0), ('job_i${c}', 'investigation', 's', 't', 'queued', 0)`);
                for (const [n, it] of items.entries())
                  yield* w.run("INSERT INTO work (id, job_id, kind, slot, priority, state, seq) VALUES (?, ?, ?, 1, ?, 'queued', ?)",
                    `w${n}` as Clean, `job_${it.owner ? "c" : "i"}${it.conversation}` as Clean, (it.owner ? "answer" : "reading") as Clean, it.owner ? 0 : 1, n);
              }),
            );
            const taken: number[] = [];
            for (let next = yield* nextWork; next; next = yield* nextWork) {
              taken.push(Number(next.id.slice(1)));
              const done = next.id;
              yield* store.tx((w) => w.run("UPDATE work SET state = 'done' WHERE id = ?", done as Clean));
            }
            const owner = items.map((it, n) => (it.owner ? n : -1)).filter((n) => n >= 0);
            assert.deepEqual(taken.slice(0, owner.length), owner, "owner questions first, in the order asked");
            assert.equal(taken.length, items.length);
          }),
        ),
      );
    }),
    { numRuns: 80 },
  );
});

test("class: a playbook file is the database's corrections, rebuilt whole, whatever was written to it", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 6 }), fc.string(), (texts, garbage) => {
      const { dataDir, config } = rig();
      return run(
        withStore(dataDir, (store) =>
          Effect.gen(function* () {
            yield* store.tx((w) =>
              Effect.gen(function* () {
                yield* w.run("INSERT INTO jobs (id, kind, subject, title, state, created_seq) VALUES ('job_x', 'investigation', 'inc_1', 't', 'completed', 0)");
                for (const [n, t] of texts.entries()) yield* w.run("INSERT INTO corrections (seq, app, subject, job_id, text, date) VALUES (?, 'shop', 'inc_1', 'job_x', ?, '2026-11-01')", n + 1, t as Clean);
              }),
            );
            const file = join(dataDir, "playbooks", "shop.jsonl");
            const agents = yield* Agents;
            const expected = yield* store.all<{ seq: number; text: string }>("SELECT seq, text FROM corrections ORDER BY seq");
            if (expected.length) writeFileSync(file, garbage);
            yield* agents.playbooks;
            const lines = expected.length ? readFileSync(file, "utf8") : "";
            assert.equal(lines, expected.map((c) => JSON.stringify({ date: "2026-11-01", seq: c.seq, app: "shop", subject: "inc_1", jobId: "job_x", text: c.text }) + "\n").join(""));
          }).pipe(Effect.provide(Agents.layer), withConfig(config)),
        ),
      );
    }),
    { numRuns: 40 },
  );
});

test("class: the owner tools never serve a session Overwatch runs, in any role, and need the peer to know the session", async () => {
  await fc.assert(
    fc.asyncProperty(fc.constantFrom("investigator", "challenger", "responder", "trial", "owner", "unknown"), (who) => {
      const { dataDir } = rig();
      return run(
        withStore(dataDir, (store) =>
          Effect.gen(function* () {
            const tools = yield* Tools;
            const peer = new Set(["ses_owner"]);
            const owner: Owner = {
              exists: (s) => Effect.succeed(peer.has(s) || s.startsWith("ses_run")),
              inbox: Effect.succeed({ ok: true }),
              get: () => Effect.succeed({}),
              search: () => Effect.succeed({}),
              act: () => Effect.succeed({}),
            };
            yield* store.tx((w) =>
              Effect.gen(function* () {
                yield* w.run("INSERT INTO jobs (id, kind, subject, title, state, created_seq) VALUES ('job_x', 'investigation', 's', 't', 'running', 0)");
                yield* w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms, role) VALUES ('run_x', 'job_x', 1, ?, 'terminal', 0, ?, 0, ?)", `ses_run_${who}` as Clean, json({}), who as Clean);
              }),
            );
            const session = who === "owner" ? "ses_owner" : who === "unknown" ? "ses_nobody" : `ses_run_${who}`;
            const outcome = yield* Effect.result(tools.call(session, "ow_inbox", {}, owner));
            if (who === "owner") assert.deepEqual(outcome._tag === "Success" && outcome.success, { ok: true });
            else assert.equal(outcome._tag, "Failure");
            // Without the owner's operations, no session is an owner.
            assert.equal((yield* Effect.result(tools.call(session, "ow_inbox", {})))._tag, "Failure");
          }).pipe(Effect.provide(Tools.layer)),
        ),
      );
    }),
  );
});

test("class: a team brief never carries a title, handle, session or command, whatever the problems are called", async () => {
  const nasty = fc.constantFrom("ses_abc123", "e_0123456789abcd", "kubectl --context x", "ow_telemetry", "PURPLE_MUG", "<script>");
  await fc.assert(
    fc.asyncProperty(fc.array(fc.tuple(nasty, fc.string({ maxLength: 20 })), { minLength: 1, maxLength: 4 }), (titles) => {
      const { dataDir, config } = rig();
      return run(
        withStore(dataDir, (store) =>
          Effect.gen(function* () {
            for (const [n, [a, b]] of titles.entries())
              yield* store.tx((w) =>
                Effect.gen(function* () {
                  const seq = yield* w.event("slice", "shop/prod/pods" as Clean, {});
                  yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES (?, 'shop', 'prod', 'shop/prod/pods', ?, 'error', 1, 1, 0, 0, ?, ?)",
                    `inc_${n}` as Clean, `ERROR ${a} ${b}` as Clean, seq, seq);
                }),
              );
            const team = (yield* brief("team")).text, owner = (yield* brief("owner")).text;
            for (const [a] of titles) assert.ok(!team.includes(a), a);
            assert.deepEqual(yield* brief("team"), yield* brief("team"), "the same fence gives the same text");
            assert.notEqual(team, owner);
          }).pipe(withConfig(config)),
        ),
      );
    }),
    { numRuns: 60 },
  );
});
