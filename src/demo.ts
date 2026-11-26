/**
 * `overwatch demo`: a new, isolated data directory with a seeded picture, served like `serve` with collection off.
 * No cluster, Datadog or OpenCode is contacted. Production has a timeout that followed a deploy, staging has harmless
 * noise, QA's cluster is signed out, and an older incident has been resolved.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config } from "./config.ts";
import { clock } from "./clock.ts";
import { json, type Clean, type Store, type Writer } from "./store.ts";
import { act, afterFinding, ask, hourly } from "./inbox.ts";
import { adjudicate } from "./agents.ts";

export function demoConfig(port: number): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "overwatch-demo-"));
  mkdirSync(join(dataDir, "checkout"));
  const pods = (context: string) => ({ type: "kubernetes", context, namespace: "shop", selector: "app=shop" });
  return parseConfig(
    {
      version: 2,
      dataDir,
      port,
      apps: { shop: { checkout: "checkout", environments: { production: { sources: { pods: pods("prod-east") } }, staging: { sources: { pods: pods("staging-east") } }, qa: { sources: { pods: pods("qa-east") } } } } },
      watchers: [
        { app: "shop", environment: "production", every: "2m" },
        { app: "shop", environment: "staging", every: "10m" },
        { app: "shop", environment: "qa", every: "10m" },
      ],
    },
    join(dataDir, "demo.json"),
  );
}

export function seedDemo(store: Store, config: Config) {
  const now = clock.now();
  const s = (v: string) => v as Clean;
  const min = 60_000, hour = 60 * min, day = 24 * hour;
  /** A problem with an hourly history (oldest first, ending in the current hour). */
  const problem = (w: Writer, id: string, environment: string, title: string, severity: string, counts: number[], seq: number, active = true) => {
    const total = counts.reduce((a, b) => a + b, 0);
    w.run(
      `INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, reading, active, streak, first_seq)
       VALUES (?, 'shop', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'logs', ?, 0, ?)`,
      s(id), s(environment), s(`shop/${environment}/pods`), s(title), s(severity), total, now - counts.length * hour, now - 4 * min, seq, active ? 1 : 0, seq,
    );
    counts.forEach((n, i) => n && hourly(w, id, now - (counts.length - 1 - i) * hour, n));
  };
  store.tx((w) => {
    for (const source of config.sources) {
      const signedOut = source.environment === "qa";
      w.run(
        "INSERT INTO sources (id, checkpoint_ms, failure, streak, next_ms, suspended, fix, endpoint, delay_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        s(source.id), signedOut ? now - hour : now, signedOut ? s("signin") : null, signedOut ? 2 : 0, now + source.everyMs, signedOut ? 1 : 0,
        signedOut ? s(`Sign in to ${source.context} again, then check with: kubectl --context ${source.context} -n shop get pods`) : null, s(`kubernetes:${source.context}`), source.everyMs,
      );
      for (const reading of source.readings) {
        w.run("INSERT INTO readings (source, reading, state, at_ms, ok_ms) VALUES (?, ?, 'ok', ?, ?)", s(source.id), s(reading), signedOut ? now - hour : now, signedOut ? now - hour : now);
      }
    }
    const first = w.event("deploy", s("shop/production"), { revision: "9f8e7d6c5b4a", previous: null, demo: true });
    w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'production', '9f8e7d6c5b4a', NULL)", first);
    // Seeded history is labelled as such: it belongs to the environment, not to the problem's own timeline.
    const seeded = (id: string, environment: string) => w.event("incident", s(`shop/${environment}`), { demo: true, seeded: id });
    problem(w, "inc_d0c5ea12", "production", "ERROR search index rebuild stalled at shard 12", "error", [0, 2, 3, 1, 1], seeded("inc_d0c5ea12", "production"), false);
    problem(w, "inc_d0c7a1e5", "staging", "ERROR thumbnail worker exited 137 (OOMKilled) on large uploads", "error", [1, 2, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0], seeded("inc_d0c7a1e5", "staging"), false);
    w.event("quieted", s("inc_d0c7a1e5"), { demo: true, reason: "three measured intervals with nothing new" });
    const deploy = w.event("deploy", s("shop/production"), { revision: "a1b2c3d4e5f6", previous: "9f8e7d6c5b4a", demo: true });
    w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'production', 'a1b2c3d4e5f6', '9f8e7d6c5b4a')", deploy);
    problem(w, "inc_d0c4ab11", "production", "ERROR checkout: payments timeout after 300ms", "error", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 11, 16, 12], seeded("inc_d0c4ab11", "production"));
    problem(w, "inc_d0c3f00d", "staging", "WARN cache warm-up took longer than 2s", "warn", [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], seeded("inc_d0c3f00d", "staging"));
    problem(w, "inc_d0c1ed9e", "production", "WARN ledger reconciliation lag above 120s on shard 4", "warn", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 2, 1, 1, 1], seeded("inc_d0c1ed9e", "production"));
  });
  // The owner's history, through the same rules as real work: an old issue put away with Done; the staging warning
  // put away with Later, then a finding on it brings it back; a question about the ledger lag queued for an agent.
  act(store, config, "inc_d0c5ea12", { action: "done" });
  act(store, config, "inc_d0c3f00d", { action: "later" });
  store.tx((w) => {
    const job = "job_d0c3f00d0000000000000001", run = "run_d0c3f00d0000000000000001", handle = "e_d0c3f00d000000000000000a";
    const asked = w.event("job", s(job), { kind: "investigation", subject: "inc_d0c3f00d", demo: true });
    w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq) VALUES (?, 'investigation', 'inc_d0c3f00d', ?, 'completed', NULL, ?)", s(job), s("Is the cache warm-up warning real?"), asked);
    w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms) VALUES (?, ?, 1, 'ses_d0c3f00d000000000001', 'terminal', 3, ?, ?)", s(run), s(job), json({ expected: "a1b2c3d4e5f6", read: "a1b2c3d4e5f6", deployed: true }), now - 30 * min);
    const text = s("2026-11-24T09:12:04Z WARN cache warm-up took 2.1s at start (logged daily since last month)");
    w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES (?, ?, 'ses_d0c3f00d000000000001', 'pods', ?, 1)", s(handle), s(run), text);
    const claims = [{ statement: "The warning predates the current release and its rate is unchanged.", pieces: [{ handle, source: "pods", text }] }];
    const body = { cause: "Slow cache warm-up at start, as every day since last month", ruled_out: ["the a1b2c3d release"], not_checked: [], next_check: "Watch the warm-up time after the next deploy", impact: "none", affected: [], since: null, status: "investigated" };
    w.run("INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES ('f_d0c3f00d0000000000000001', ?, 'not_real', ?, ?, ?)", s(run), json(claims), json({ expected: "a1b2c3d4e5f6", read: "a1b2c3d4e5f6", deployed: true }), json(body));
    const filed = w.event("finding", s("inc_d0c3f00d"), { id: "f_d0c3f00d0000000000000001", verdict: "not_real", demo: true });
    afterFinding(w, store, "inc_d0c3f00d", filed, "not_real");
  });
  ask(store, config, { subject: "inc_d0c1ed9e", text: "Why is ledger reconciliation lagging since the a1b2c3d deploy?", mode: "auto" }, "rk_d0c1ed9e0000000000000001");
  investigated(store);
  // An answered question on the staging warning, as an agent would have answered it.
  ask(store, config, { subject: "inc_d0c3f00d", text: "Has the warm-up time changed since the a1b2c3d deploy?", mode: "auto" }, "rk_d0c3f00d0000000000000002");
  store.tx((w) => {
    const answer = "No. The warm-up has taken 2.0–2.2 s at every start for a month, before and after a1b2c3d; the warning is logged at 2 s.";
    w.run("UPDATE asks SET state = 'answered', session_id = 'ses_d0c3f00d000000000002', answer = ? WHERE key = 'rk_d0c3f00d0000000000000002'", s(answer));
    w.run("UPDATE work SET state = 'done' WHERE ask_key = 'rk_d0c3f00d0000000000000002'");
    w.run("UPDATE jobs SET state = 'completed' WHERE id = (SELECT job_id FROM asks WHERE key = 'rk_d0c3f00d0000000000000002')");
    w.event("answered", s("inc_d0c3f00d"), { askSeq: 0, sessionId: "ses_d0c3f00d000000000002", answer, demo: true });
  });
}

/** The production timeout, investigated: three readings (two real, one dissent) and a challenger that upheld. */
function investigated(store: Store) {
  const s = (v: string) => v as Clean;
  const subject = "inc_d0c4ab11", job = "job_d0c4ab110000000000000001", code = { expected: "a1b2c3d4e5f6", read: "a1b2c3d4e5f6", deployed: true };
  const lines = ["ERROR checkout: payments timeout after 300ms (POST /v2/authorize, attempt 1)", "ERROR checkout: payments timeout after 300ms (POST /v2/authorize, attempt 2)"];
  const diff = "config/payments.yaml @ a1b2c3d\n- timeout_ms: 3000\n+ timeout_ms: 300";
  const votes: Array<[string, string, string, string]> = [
    ["real", "The a1b2c3d deploy cut the payments timeout from 3000 ms to 300 ms", "Every timeout follows the deploy and stops at exactly 300 ms", "telemetry"],
    ["real", "The timeout value changed in a1b2c3d", "The deployed config sets timeout_ms to 300, down from 3000", "code"],
    ["not_real", "The provider was slow for a few minutes", "Timeouts could be the provider's own slowness", "telemetry"],
  ];
  store.tx((w) => {
    const seq = w.event("investigation_queued", s(subject), { job, origin: "automatic", demo: true });
    w.run("INSERT INTO jobs (id, kind, subject, title, state, created_seq, inputs) VALUES (?, 'investigation', ?, 'ERROR checkout: payments timeout after 300ms', 'completed', ?, ?)", s(job), s(subject), seq, json({ planned: 3, demo: true }));
    const readings = votes.map(([verdict, cause, statement, kind], n) => {
      const run = `run_d0c4ab11000000000000000${n + 1}`, session = `ses_d0c4ab11000000000000000${n + 1}`, finding = `f_d0c4ab11000000000000000${n + 1}`;
      w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms, role, slot) VALUES (?, ?, ?, ?, 'terminal', 3, ?, ?, 'investigator', ?)", s(run), s(job), n + 1, s(session), json(code), clock.now(), n + 1);
      const pieces = (kind === "code" ? [diff] : lines).map((text, k) => {
        const handle = `e_d0c4ab11${n}${k}0000000000000000`;
        w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES (?, ?, ?, ?, ?, ?)", s(handle), s(run), s(session), s(kind === "code" ? "code" : "pods"), s(text), k + 1);
        w.run("INSERT INTO origins (handle, origin) VALUES (?, ?)", s(handle), s(kind === "code" ? "code" : "telemetry"));
        return { handle, source: kind === "code" ? "code" : "pods", text };
      });
      const body = { cause, ruled_out: verdict === "real" ? ["provider outage (status page green)", "database latency"] : [], not_checked: ["the provider's own logs"], next_check: "Restore timeout_ms to 3000 and watch the rate", impact: "checkout payments fail", affected: ["shop/production"], since: null, status: "investigated" };
      w.run("INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES (?, ?, ?, ?, ?, ?)", s(finding), s(run), s(verdict), json([{ statement, pieces }]), json(code), json(body));
      w.run("INSERT INTO work (id, job_id, kind, slot, priority, state, run_id, seq) VALUES (?, ?, 'reading', ?, 1, 'done', ?, ?)", s(`wk_d0c4ab11${n}`), s(job), n + 1, s(run), seq);
      return { slot: n + 1, sessionId: session, verdict: verdict as "real" | "not_real", findingId: finding, reason: null, telemetry: kind !== "code", observed: kind === "code" ? [] : lines };
    });
    const challenge = { outcome: "upheld" as const, reason: "The 300 ms limit matches the cut-off of every failed call; the provider answered within 900 ms throughout.", pieces: [{ handle: "e_d0c4ab11c00000000000000000", source: "pods", text: lines[0]! }] };
    const decided = adjudicate(3, readings, challenge);
    const at = w.next();
    const observations = new Set(readings.filter((r) => r.verdict === decided.verdict).flatMap((r) => r.observed)).size;
    const result = { verdict: decided.verdict, observed: decided.observed, planned: 3, counts: decided.counts, observations, readings: readings.map(({ telemetry: _, observed: __, ...r }) => r), challenge, seq: at };
    w.event("adjudicated", s(subject), { job, result });
    w.run("UPDATE jobs SET result = ? WHERE id = ?", json(result), s(job));
  });
}

/** The demo's picture stays as seeded for as long as it runs: its readings are renewed each minute (QA stays signed out). */
export function freshen(store: Store) {
  const now = clock.now();
  const oldest = store.get<{ ok: number | null }>("SELECT min(ok_ms) AS ok FROM readings WHERE source NOT LIKE 'shop/qa/%'")?.ok;
  if (oldest == null || Math.abs(now - oldest) < 60_000) return; // either way: a wall clock set back still renews
  store.tx((w) => {
    w.run("UPDATE readings SET at_ms = ?, ok_ms = ? WHERE source NOT LIKE 'shop/qa/%'", now, now);
    w.event("slice", null, { demo: true, renewed: "readings", atMs: now });
  });
}
