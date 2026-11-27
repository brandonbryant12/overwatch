/**
 * `overwatch demo`: a new, isolated data directory with a seeded picture, served like `serve` with collection off.
 * No cluster, Datadog or OpenCode is contacted. Production has a timeout that followed a deploy, staging has harmless
 * noise, QA's cluster is signed out, and an older incident has been resolved.
 */
import { Effect, FileSystem, Path } from "effect";
import { createHash } from "node:crypto";
import { AppConfig, parseConfig, type Config } from "./config.ts";
import { scratch } from "./exec.ts";
import { clock } from "./clock.ts";
import { json, Store, type Clean, type Writer } from "./store.ts";
import { act, afterFinding, ask, hourly, keyed } from "./inbox.ts";
import { adjudicate } from "./agents.ts";

export const demoConfig = Effect.fn("demoConfig")(function* (port: number) {
  const fs = yield* FileSystem.FileSystem, path = yield* Path.Path, join = path.join;
  const dataDir = yield* scratch("overwatch-demo-");
  yield* fs.makeDirectory(join(dataDir, "checkout")).pipe(Effect.orDie);
  const pods = (context: string) => ({ type: "kubernetes", context, namespace: "shop", selector: "app=shop" });
  return parseConfig({
    version: 2, dataDir, port,
    apps: {
      shop: {
        checkout: "checkout",
        fixes: { remote: "origin", base: "main", paths: ["config/database.json", "config/payments.json"], verify: [["npm", "test", "--", "config"]] },
        promotion: { staging: "staging", production: "production" },
        environments: {
          production: { databases: { primary: { driver: "sqlite", file: "demo.sqlite", allowSelect: true } }, sources: { pods: pods("prod-east"), disk: { type: "datadog", apiKey: "env:OW_DEMO_UNUSED", appKey: "env:OW_DEMO_UNUSED", query: "service:orders", metric: "avg:orders.disk.used{*}", readings: ["metrics"], capacity: { resource: "disk", unit: "bytes", limit: 500e9 } } } },
          staging: { policy: { investigate: false, notify: false, fixMode: "off" }, sources: { pods: pods("staging-east") } },
          qa: { sources: { pods: pods("qa-east") } }, }, }, },
    watchers: [{ app: "shop", environment: "production", every: "2m" }, { app: "shop", environment: "staging", every: "2m" }, { app: "shop", environment: "qa", every: "10m" }],
  }, join(dataDir, "demo.json")) as Config; });

export const seedDemo = Effect.gen(function* () {
  const store = yield* Store;
  const config = yield* AppConfig;
  const now = clock.now();
  const s = (v: string) => v as Clean;
  const min = 60_000, hour = 60 * min;
  /** A problem with an hourly history (oldest first, ending in the current hour). */
  const problem = Effect.fnUntraced(function* (w: Writer, id: string, environment: string, title: string, severity: string, counts: number[], seq: number, active = true) {
    const total = counts.reduce((a, b) => a + b, 0);
    yield* w.run(
      `INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, reading, active, streak, first_seq)
       VALUES (?, 'shop', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'logs', ?, 0, ?)`,
      s(id), s(environment), s(`shop/${environment}/pods`), s(title), s(severity), total, now - counts.length * hour, now - 4 * min, seq, active ? 1 : 0, seq);
    for (const [i, n] of counts.entries()) if (n) yield* hourly(w, id, now - (counts.length - 1 - i) * hour, n); });
  yield* store.tx((w) => Effect.gen(function* () {
    for (const source of config.sources) {
      const signedOut = source.environment === "qa";
      yield* w.run(
        "INSERT INTO sources (id, checkpoint_ms, failure, streak, next_ms, suspended, fix, endpoint, delay_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        s(source.id), signedOut ? now - hour : now, signedOut ? s("signin") : null, signedOut ? 2 : 0, now + source.everyMs, signedOut ? 1 : 0,
        signedOut ? s(`Sign in to ${source.context} again, then check with: kubectl --context ${source.context} -n shop get pods`) : null, s(`${source.kind}:${source.context ?? source.baseUrl}`), source.everyMs);
      for (const reading of source.readings) {
        yield* w.run("INSERT INTO readings (source, reading, state, at_ms, ok_ms) VALUES (?, ?, 'ok', ?, ?)", s(source.id), s(reading), signedOut ? now - hour : now, signedOut ? now - hour : now);
      }}
    const first = yield* w.event("deploy", s("shop/production"), { revision: "9f8e7d6c5b4a", previous: null, demo: true });
    yield* w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'production', '9f8e7d6c5b4a', NULL)", first);
    // Seeded history is labelled as such: it belongs to the environment, not to the problem's own timeline.
    const seeded = (id: string, environment: string) => w.event("incident", s(`shop/${environment}`), { demo: true, seeded: id });
    const seed = Effect.fnUntraced(function* (id: string, environment: string, title: string, severity: string, counts: number[], active = true) {
      yield* problem(w, id, environment, title, severity, counts, yield* seeded(id, environment), active); });
    yield* seed("inc_d0c5ea12", "production", "ERROR search index rebuild stalled at shard 12", "error", [0, 2, 3, 1, 1], false);
    yield* seed("inc_d0c7a1e5", "staging", "ERROR thumbnail worker exited 137 (OOMKilled) on large uploads", "error", [1, 2, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0], false);
    yield* w.event("quieted", s("inc_d0c7a1e5"), { demo: true, reason: "three measured intervals with nothing new" });
    const deploy = yield* w.event("deploy", s("shop/production"), { revision: "a1b2c3d4e5f6", previous: "9f8e7d6c5b4a", demo: true });
    yield* w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'production', 'a1b2c3d4e5f6', '9f8e7d6c5b4a')", deploy);
    yield* seed("inc_d0c4ab11", "production", "ERROR checkout: payments timeout after 300ms", "error", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 11, 16, 12]);
    yield* seed("inc_d0c3f00d", "staging", "WARN cache warm-up took longer than 2s", "warn", [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    yield* seed("inc_d0c1ed9e", "production", "WARN ledger reconciliation lag above 120s on shard 4", "warn", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 2, 1, 1, 1]);
    yield* seed("inc_d0c0db05", "production", "ERROR orders: no free database connection (pool of 5 exhausted)", "error", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 7, 9, 6]);
    // Disk use on the orders database host, rising evenly: time left, from six provider samples.
    const series = createHash("sha256").update(JSON.stringify(["avg:orders.disk.used{*}", "disk", "bytes", 500e9])).digest("hex");
    for (let n = 5; n >= 0; n--) w.run("INSERT INTO samples (source, series, at_ms, value) VALUES ('shop/production/disk', ?, ?, ?)", s(series), now - n * 2 * min, 410e9 + (5 - n) * 2.6e9);
    // Staging took a new release; production did not. Two compared intervals found a staging-only problem.
    const staged = yield* w.event("deploy", s("shop/staging"), { revision: "b7c6d5e4f3a2", previous: "a1b2c3d4e5f6", demo: true });
    yield* w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'staging', 'b7c6d5e4f3a2', 'a1b2c3d4e5f6')", staged);
    yield* seed("inc_d0c5a6e0", "staging", "New in staging since b7c6d5e4f3a2: ERROR shipping quote failed for EU addresses (production a1b2c3d4e5f6 unchanged)", "warn", [0, 0, 3, 2]);
    yield* w.run("UPDATE incidents SET reading = 'comparison', source = 'shop/staging/comparison' WHERE id = 'inc_d0c5a6e0'");
    yield* w.run(`INSERT INTO comparisons (id, app, staging_revision, production_revision, start_seq, state, reason, staging_count, production_count, data, incident)
      VALUES ('cmp_d0c5a6e0', 'shop', 'b7c6d5e4f3a2', 'a1b2c3d4e5f6', ?, 'regression', 'ERROR shipping quote failed for EU addresses: 5 in staging over two intervals, none in production', 5, 0, '{}', 'inc_d0c5a6e0')`, staged); }));
  // The owner's history, through the same rules as real work: an old issue put away with Done; the staging warning
  // put away with Later, then a finding on it brings it back; a question about the ledger lag queued for an agent.
  yield* act("inc_d0c5ea12", { action: "done" }, null);
  yield* act("inc_d0c3f00d", { action: "later" }, null);
  yield* store.tx((w) => Effect.gen(function* () {
    const job = "job_d0c3f00d0000000000000001", run = "run_d0c3f00d0000000000000001", handle = "e_d0c3f00d000000000000000a";
    const asked = yield* w.event("job", s(job), { kind: "investigation", subject: "inc_d0c3f00d", demo: true });
    yield* w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq) VALUES (?, 'investigation', 'inc_d0c3f00d', ?, 'completed', NULL, ?)", s(job), s("Is the cache warm-up warning real?"), asked);
    yield* w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms) VALUES (?, ?, 1, 'ses_d0c3f00d000000000001', 'terminal', 3, ?, ?)", s(run), s(job), json({ expected: "a1b2c3d4e5f6", read: "a1b2c3d4e5f6", deployed: true }), now - 30 * min);
    const text = s("2026-11-24T09:12:04Z WARN cache warm-up took 2.1s at start (logged daily since last month)");
    yield* w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES (?, ?, 'ses_d0c3f00d000000000001', 'pods', ?, 1)", s(handle), s(run), text);
    const claims = [{ statement: "The warning predates the current release and its rate is unchanged.", pieces: [{ handle, source: "pods", text }] }];
    const body = { cause: "Slow cache warm-up at start, as every day since last month", ruled_out: ["the a1b2c3d release"], not_checked: [], next_check: "Watch the warm-up time after the next deploy", impact: "none", affected: [], since: null, status: "investigated" };
    yield* w.run("INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES ('f_d0c3f00d0000000000000001', ?, 'not_real', ?, ?, ?)", s(run), json(claims), json({ expected: "a1b2c3d4e5f6", read: "a1b2c3d4e5f6", deployed: true }), json(body));
    const filed = yield* w.event("finding", s("inc_d0c3f00d"), { id: "f_d0c3f00d0000000000000001", verdict: "not_real", demo: true });
    yield* afterFinding(w, "inc_d0c3f00d", filed, "not_real"); }));
  yield* keyed("rk_d0c1ed9e0000000000000001", yield* ask({ subject: "inc_d0c1ed9e", text: "Why is ledger reconciliation lagging since the a1b2c3d deploy?", mode: "auto" }));
  yield* investigated(TIMEOUT);
  yield* investigated(POOL);
  // Seed span lines, watched commits, and one verified AI lens on the flagship incident (still 7 incidents, 3 envs).
  yield* store.tx((w) => Effect.gen(function* () {
    const seq = yield* w.event("commit", s("shop/a1b2c3d4e5f6"), { demo: true, seeded: "commits" });
    for (const [sha, parent, ageMin, subject, files, ins, del, flags, paths] of [
      ["b7c6d5e4f3a2", "a1b2c3d4e5f6", 18, "feat(shipping): EU carrier quote fallback", 4, 92, 14, ["timeout"], ["src/shipping/eu.ts", "config/carriers.json"]],
      ["a1b2c3d4e5f6", "9f8e7d6c5b4a", 75, "chore(config): tighten payments timeout & orders pool", 2, 4, 4, ["config", "timeout", "database"], ["config/payments.yaml", "config/database.json"]],
      ["9f8e7d6c5b4a", null, 360, "chore(release): baseline shop v2.14", 6, 48, 19, [], ["src/checkout/pay.ts", "config/payments.yaml"]],
    ] as const) {
      yield* w.run("INSERT OR IGNORE INTO commits (app, sha, parent, committed_at, subject, files, insertions, deletions, flags, paths, seq) VALUES ('shop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        s(sha), parent ? s(parent) : null, now - ageMin * min, s(subject), files, ins, del, json(flags), json(paths), seq);
    }
    for (const [ago, ms, res, tr] of [[12, 318, "POST /v2/authorize", "tr_91a4"], [9, 642, "POST /v2/authorize", "tr_91b8"], [6, 1280, "POST /v2/authorize", "tr_91c2"], [4, 304, "POST /v2/authorize", "tr_91d9"]] as const)
      yield* w.run("INSERT INTO lines (incident, source, at_ms, text) VALUES ('inc_d0c4ab11', 'pods', ?, ?)", now - ago * min, s(`SLOW ${ms}ms checkout ${res} trace=${tr}`));
    const hTel = "e_d0c4ab11000000000000000000", hCode = "e_d0c4ab11100000000000000000";
    const lens = {
      source: "ai", title: "Payments timeout regression after a1b2c3d4e5f6", model: "private/glm-5.3", generatedAt: now - 3 * min,
      summary: "Deploy a1b2c3d4e5f6 cut timeout_ms from 3000ms to 300ms; 42 checkout authorize spans timed out at the 300ms boundary.", verifiedHandles: [hTel, hCode],
      blocks: [
        { kind: "causal_flow", title: "Causal chain", steps: [
          { label: "Config change", detail: "config/payments.yaml lowered timeout_ms 3000 → 300", tone: "warn", handle: hCode },
          { label: "Authorize timeouts", detail: "POST /v2/authorize aborted at 300ms across 42 requests", tone: "error", handle: hTel },
          { label: "Challenger upheld", detail: "Provider answered within 900ms; client cut-off caused failures", tone: "error", handle: hTel }] },
        { kind: "metric_compare", title: "Before vs after a1b2c3d4e5f6", rows: [
          { label: "Payments timeout_ms", before: "3000 ms", after: "300 ms", beforeNum: 3000, afterNum: 300, unit: "ms", delta: "-90%", tone: "error", handle: hCode },
          { label: "Checkout timeouts / hr", before: "0", after: "16", beforeNum: 0, afterNum: 16, unit: "/hr", delta: "+16/hr", tone: "error", handle: hTel }] },
        { kind: "span_waterfall", title: "Slow authorize spans", p50Ms: 480, slowMs: 300, spans: [
          { label: "POST /v2/authorize", service: "checkout", durationMs: 318, offsetMs: 0, status: "slow", handle: hTel },
          { label: "POST /v2/authorize", service: "checkout", durationMs: 642, offsetMs: 180, status: "slow", handle: hTel },
          { label: "POST /v2/authorize", service: "checkout", durationMs: 1280, offsetMs: 360, status: "error", handle: hTel }] },
        { kind: "key_facts", title: "Verified facts", facts: [{ label: "Root setting", value: "timeout_ms: 300 (was 3000)", origin: "code", handle: hCode }, { label: "Error signature", value: "payments timeout after 300ms", origin: "telemetry", handle: hTel }] }], };
    const lSeq = yield* w.event("lens", s("inc_d0c4ab11"), { source: "ai", demo: true });
    yield* w.run("INSERT OR REPLACE INTO lenses (incident, spec, seq) VALUES ('inc_d0c4ab11', ?, ?)", json(lens), lSeq); }));
  // Its fix, as Overwatch would have proposed it: restore pool_size, verified in isolation, waiting for the owner's P.
  yield* store.tx((w) => Effect.gen(function* () {
    const job = "job_d0c0db050000000000000001", seq = yield* w.event("fix", "inc_d0c0db05" as Clean, { id: "fx_d0c0db05", state: "verified", demo: true });
    const diff = 'diff --git a/config/database.json b/config/database.json\n--- a/config/database.json\n+++ b/config/database.json\n@@ -1,5 +1,5 @@\n {\n   "host": "orders-db",\n-  "pool_size": 5,\n+  "pool_size": 20,\n   "timeout_ms": 2000\n }\n';
    const data = { title: POOL.title, summary: "Restore pool_size in config/database.json to 20, its value at 9f8e7d6c5b4a", paths: ["config/database.json"], proposal: { kind: "setting", path: "config/database.json", key: "pool_size" },
      verification: [{ argv: ["npm", "test", "--", "config"], exitCode: 0, elapsedMs: 8412, summary: "12 passing" }], repo: "git.example/acme/shop" };
    yield* w.run("INSERT INTO fixes (id, incident, job_id, app, environment, origin, state, previous, deployed, base, candidate, head, diff, data, seq) VALUES ('fx_d0c0db05', 'inc_d0c0db05', ?, 'shop', 'production', 'automatic', 'verified', '9f8e7d6c5b4a', 'a1b2c3d4e5f6', 'c4d5e6f7a8b9', 'e8f9a0b1c2d3', 'e8f9a0b1c2d3', ?, ?, ?)", job as Clean, diff as Clean, json(data), seq); }));
  // An answered question on the staging warning, as an agent would have answered it.
  yield* keyed("rk_d0c3f00d0000000000000002", yield* ask({ subject: "inc_d0c3f00d", text: "Has the warm-up time changed since the a1b2c3d deploy?", mode: "auto" }));
  yield* store.tx((w) => Effect.gen(function* () {
    const answer = "No. The warm-up has taken 2.0–2.2 s at every start for a month, before and after a1b2c3d; the warning is logged at 2 s.";
    yield* w.run("UPDATE asks SET state = 'answered', session_id = 'ses_d0c3f00d000000000002', answer = ? WHERE key = 'rk_d0c3f00d0000000000000002'", s(answer));
    yield* w.run("UPDATE work SET state = 'done' WHERE ask_key = 'rk_d0c3f00d0000000000000002'");
    yield* w.run("UPDATE jobs SET state = 'completed' WHERE id = (SELECT job_id FROM asks WHERE key = 'rk_d0c3f00d0000000000000002')");
    yield* w.event("answered", s("inc_d0c3f00d"), { askSeq: 0, sessionId: "ses_d0c3f00d000000000002", answer, demo: true }); })); });

type Spec = { subject: string; tag: string; title: string; lines: string[]; diff: string; votes: Array<[string, string, string, string]>; upheld: string; db?: string };
/** The production timeout: three readings (two real, one dissent) and a challenger that upheld. */
const TIMEOUT: Spec = {
  subject: "inc_d0c4ab11", tag: "d0c4ab11", title: "ERROR checkout: payments timeout after 300ms",
  lines: ["ERROR checkout: payments timeout after 300ms (POST /v2/authorize, attempt 1)", "ERROR checkout: payments timeout after 300ms (POST /v2/authorize, attempt 2)"],
  diff: "config/payments.yaml @ a1b2c3d\n- timeout_ms: 3000\n+ timeout_ms: 300",
  db: JSON.stringify([{ state: "active", wait_event: "ClientRead", count: 14, max_ms: 312 }, { state: "idle in transaction", wait_event: "Lock", count: 3, max_ms: 890 }]),
  votes: [
    ["real", "The a1b2c3d deploy cut the payments timeout from 3000 ms to 300 ms", "Every timeout follows the deploy and stops at exactly 300 ms", "telemetry"],
    ["real", "The timeout value changed in a1b2c3d", "The deployed config sets timeout_ms to 300, down from 3000", "code"],
    ["not_real", "The provider was slow for a few minutes", "Timeouts could be the provider's own slowness", "telemetry"]],
  upheld: "The 300 ms limit matches the cut-off of every failed call; the provider answered within 900 ms throughout.", };
/** The connection pool: three of three real, upheld, observed. Eligible, so it has a draft fix. */
const POOL: Spec = {
  subject: "inc_d0c0db05", tag: "d0c0db05", title: "ERROR orders: no free database connection (pool of 5 exhausted)",
  lines: ["ERROR orders: no free database connection (pool of 5 exhausted, 41 waiting)", "ERROR orders: no free database connection (pool of 5 exhausted, 38 waiting)"],
  diff: 'config/database.json @ a1b2c3d\n- "pool_size": 20,\n+ "pool_size": 5,',
  votes: [
    ["real", "a1b2c3d lowered pool_size from 20 to 5", "Exhaustion starts with the deploy and every error names a pool of 5", "telemetry"],
    ["real", "The pool is too small for the order rate since a1b2c3d", "41 requests wait for 5 connections at the peak", "telemetry"],
    ["real", "pool_size changed in the deploy", "Waiting requests track checkout traffic, not database latency", "telemetry"]],
  upheld: "Database latency stayed under 4 ms; only the pool size changed, and every failure names it.", };

const investigated = Effect.fnUntraced(function* (spec: Spec) {
  const store = yield* Store, s = (v: string) => v as Clean;
  const { subject, lines, diff, votes } = spec, job = `job_${spec.tag}0000000000000001`, code = { expected: "a1b2c3d4e5f6", read: "a1b2c3d4e5f6", deployed: true };
  yield* store.tx((w) => Effect.gen(function* () {
    const seq = yield* w.event("investigation_queued", s(subject), { job, origin: "automatic", demo: true });
    yield* w.run("INSERT INTO jobs (id, kind, subject, title, state, created_seq, inputs) VALUES (?, 'investigation', ?, ?, 'completed', ?, ?)", s(job), s(subject), s(spec.title), seq, json({ planned: 3, demo: true }));
    const readings = [];
    for (const [n, [verdict, cause, statement, kind]] of votes.entries()) {
      const run = `run_${spec.tag}000000000000000${n + 1}`, session = `ses_${spec.tag}000000000000000${n + 1}`, finding = `f_${spec.tag}000000000000000${n + 1}`;
      yield* w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms, role, slot) VALUES (?, ?, ?, ?, 'terminal', 3, ?, ?, 'investigator', ?)", s(run), s(job), n + 1, s(session), json(code), clock.now(), n + 1);
      const pieces = [];
      for (const [k, text] of (kind === "code" ? [diff] : lines).entries()) {
        const handle = `e_${spec.tag}${n}${k}0000000000000000`;
        yield* w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES (?, ?, ?, ?, ?, ?)", s(handle), s(run), s(session), s(kind === "code" ? "code" : "pods"), s(text), k + 1);
        yield* w.run("INSERT INTO origins (handle, origin) VALUES (?, ?)", s(handle), s(kind === "code" ? "code" : "telemetry"));
        pieces.push({ handle, source: kind === "code" ? "code" : "pods", text });
      }
      if (n === 0 && spec.db) {
        const handle = `e_${spec.tag}db00000000000000`;
        yield* w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES (?, ?, ?, 'db:primary', ?, 9)", s(handle), s(run), s(session), s(spec.db));
        yield* w.run("INSERT INTO origins (handle, origin) VALUES (?, 'telemetry')", s(handle));
        pieces.push({ handle, source: "db:primary", text: spec.db });
      }
      const body = { cause, ruled_out: verdict === "real" ? ["provider outage (status page green)", "database latency"] : [], not_checked: ["the provider's own logs"], next_check: "Restore timeout_ms to 3000 and watch the rate", impact: "checkout payments fail", affected: ["shop/production"], since: null, status: "investigated" };
      yield* w.run("INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES (?, ?, ?, ?, ?, ?)", s(finding), s(run), s(verdict), json([{ statement, pieces }]), json(code), json(body));
      yield* w.run("INSERT INTO work (id, job_id, kind, slot, priority, state, run_id, seq) VALUES (?, ?, 'reading', ?, 1, 'done', ?, ?)", s(`wk_${spec.tag}${n}`), s(job), n + 1, s(run), seq);
      readings.push({ slot: n + 1, sessionId: session, verdict: verdict as "real" | "not_real", findingId: finding, reason: null, telemetry: kind !== "code", observed: kind === "code" ? [] : lines });
    }
    const challenge = { outcome: "upheld" as const, reason: spec.upheld, pieces: [{ handle: `e_${spec.tag}00000000000000000000`, source: "pods", text: lines[0]! }] };
    const decided = adjudicate(3, readings, challenge), at = yield* w.next();
    const observations = new Set(readings.filter((r) => r.verdict === decided.verdict).flatMap((r) => r.observed)).size;
    const result = { verdict: decided.verdict, observed: decided.observed, planned: 3, counts: decided.counts, observations, readings: readings.map(({ telemetry: _, observed: __, ...r }) => r), challenge, seq: at };
    yield* w.event("adjudicated", s(subject), { job, result });
    yield* w.run("UPDATE jobs SET result = ? WHERE id = ?", json(result), s(job)); })); });

/** The demo's picture stays as seeded for as long as it runs: its readings are renewed each minute (QA stays signed out). */
export const freshen = Effect.gen(function* () {
  const store = yield* Store;
  const now = clock.now();
  const oldest = (yield* store.get<{ ok: number | null }>("SELECT min(ok_ms) AS ok FROM readings WHERE source NOT LIKE 'shop/qa/%'"))?.ok;
  if (oldest == null || Math.abs(now - oldest) < 60_000) return; // either way: a wall clock set back still renews
  yield* store.tx((w) => Effect.gen(function* () {
    yield* w.run("UPDATE readings SET at_ms = ?, ok_ms = ? WHERE source NOT LIKE 'shop/qa/%'", now, now);
    yield* w.run("UPDATE samples SET at_ms = at_ms + ? ", now - ((yield* store.get<{ t: number }>("SELECT max(at_ms) AS t FROM samples"))?.t ?? now));
    yield* w.event("slice", null, { demo: true, renewed: "readings", atMs: now }); })); });
