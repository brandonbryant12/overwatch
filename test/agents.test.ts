/**
 * Milestone 3 classes: adjudication is a pure function of stored filings; the queue serves the owner first; a
 * playbook is the database's, rebuilt whole; owner tools never serve a session Overwatch runs; a team brief never
 * carries internal text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjudicate, Agents, nextWork, type Challenge, type Reading } from "../src/agents.ts";
import { brief } from "../src/brief.ts";
import { parseConfig } from "../src/config.ts";
import { Store, json, type Clean } from "../src/store.ts";
import { Tools } from "../src/tools.ts";
import { clock } from "../src/clock.ts";

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
  const dataDir = mkdtempSync(join(tmpdir(), "ow-agents-test-"));
  const config = parseConfig(
    { version: 2, dataDir, apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } }, watchers: [{ app: "shop", environment: "prod", every: "1m" }] },
    join(dataDir, "c.json"),
  );
  clock.set(Date.UTC(2026, 10, 1), 1e6);
  const store = Store.own(dataDir);
  return { dataDir, config, store };
}

test("class: a free slot takes the oldest owner question before any investigation, one question per conversation", () => {
  fc.assert(
    fc.property(fc.array(fc.record({ owner: fc.boolean(), conversation: fc.integer({ min: 0, max: 2 }) }), { minLength: 1, maxLength: 10 }), (items) => {
      const { store } = rig();
      store.tx((w) => {
        for (const c of [0, 1, 2]) w.run(`INSERT INTO jobs (id, kind, subject, title, state, created_seq) VALUES ('job_c${c}', 'ask', 's', 't', 'queued', 0), ('job_i${c}', 'investigation', 's', 't', 'queued', 0)`);
        items.forEach((it, n) =>
          w.run("INSERT INTO work (id, job_id, kind, slot, priority, state, seq) VALUES (?, ?, ?, 1, ?, 'queued', ?)",
            `w${n}` as Clean, `job_${it.owner ? "c" : "i"}${it.conversation}` as Clean, (it.owner ? "answer" : "reading") as Clean, it.owner ? 0 : 1, n));
      });
      const taken: number[] = [];
      for (let next = nextWork(store); next; next = nextWork(store)) {
        taken.push(Number(next.id.slice(1)));
        store.tx((w) => w.run("UPDATE work SET state = 'done' WHERE id = ?", next!.id as Clean));
      }
      const owner = items.map((it, n) => (it.owner ? n : -1)).filter((n) => n >= 0);
      assert.deepEqual(taken.slice(0, owner.length), owner, "owner questions first, in the order asked");
      assert.equal(taken.length, items.length);
      store.close();
    }),
    { numRuns: 80 },
  );
});

test("class: a playbook file is the database's corrections, rebuilt whole, whatever was written to it", () => {
  fc.assert(
    fc.property(fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 6 }), fc.string(), (texts, garbage) => {
      const { dataDir, config, store } = rig();
      store.tx((w) => {
        w.run("INSERT INTO jobs (id, kind, subject, title, state, created_seq) VALUES ('job_x', 'investigation', 'inc_1', 't', 'completed', 0)");
        texts.forEach((t, n) => w.run("INSERT INTO corrections (seq, app, subject, job_id, text, date) VALUES (?, 'shop', 'inc_1', 'job_x', ?, '2026-11-01')", n + 1, t as Clean));
      });
      const file = join(dataDir, "playbooks", "shop.jsonl");
      const agents = new Agents(store, new Tools(store), config, dataDir, () => undefined);
      const expected = store.all<{ seq: number; text: string }>("SELECT seq, text FROM corrections ORDER BY seq");
      if (expected.length) writeFileSync(file, garbage);
      agents.playbooks();
      const lines = expected.length ? readFileSync(file, "utf8") : "";
      assert.equal(lines, expected.map((c) => JSON.stringify({ date: "2026-11-01", seq: c.seq, app: "shop", subject: "inc_1", jobId: "job_x", text: c.text }) + "\n").join(""));
      store.close();
    }),
    { numRuns: 40 },
  );
});

test("class: the owner tools never serve a session Overwatch runs, in any role, and need the peer to know the session", async () => {
  await fc.assert(
    fc.asyncProperty(fc.constantFrom("investigator", "challenger", "responder", "trial", "owner", "unknown"), async (who) => {
      const { store } = rig();
      const tools = new Tools(store);
      const peer = new Set(["ses_owner"]);
      tools.owner = { exists: async (s) => peer.has(s) || s.startsWith("ses_run"), inbox: () => ({ ok: true }), get: () => ({}), search: () => ({}), act: () => ({}) };
      store.tx((w) => {
        w.run("INSERT INTO jobs (id, kind, subject, title, state, created_seq) VALUES ('job_x', 'investigation', 's', 't', 'running', 0)");
        w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms, role) VALUES ('run_x', 'job_x', 1, ?, 'terminal', 0, ?, 0, ?)", `ses_run_${who}` as Clean, json({}), who as Clean);
      });
      const session = who === "owner" ? "ses_owner" : who === "unknown" ? "ses_nobody" : `ses_run_${who}`;
      const call = tools.call(session, "ow_inbox", {});
      if (who === "owner") assert.deepEqual(await call, { ok: true });
      else await assert.rejects(call);
      store.close();
    }),
  );
});

test("class: a team brief never carries a title, handle, session or command, whatever the problems are called", () => {
  const nasty = fc.constantFrom("ses_abc123", "e_0123456789abcd", "kubectl --context x", "ow_telemetry", "PURPLE_MUG", "<script>");
  fc.assert(
    fc.property(fc.array(fc.tuple(nasty, fc.string({ maxLength: 20 })), { minLength: 1, maxLength: 4 }), (titles) => {
      const { config, store } = rig();
      titles.forEach(([a, b], n) =>
        store.tx((w) => {
          const seq = w.event("slice", "shop/prod/pods" as Clean, {});
          w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES (?, 'shop', 'prod', 'shop/prod/pods', ?, 'error', 1, 1, 0, 0, ?, ?)",
            `inc_${n}` as Clean, `ERROR ${a} ${b}` as Clean, seq, seq);
        }));
      const team = brief(store, config, "team").text, owner = brief(store, config, "owner").text;
      for (const [a] of titles) assert.ok(!team.includes(a), a);
      assert.deepEqual(brief(store, config, "team"), brief(store, config, "team"), "the same fence gives the same text");
      assert.notEqual(team, owner);
      store.close();
    }),
    { numRuns: 60 },
  );
});
