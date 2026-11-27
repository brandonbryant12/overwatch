import { scratch } from "./scratch.ts";
/**
 * Per-app / per-env policy, read-only database tool (`ow_db`), `extends` `~/` + merged `launchd.envSecrets`,
 * `fixGateKey` stability/revocation, and snapshot policy/jobs/fixes fields.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { queueInvestigation } from "../src/agents.ts";
import { clock } from "../src/clock.ts";
import { AppConfig, loadConfig, parseConfig, policyFor, readMergedConfig } from "../src/config.ts";
import { checkSql, queryOwnerDb, renderQuery } from "../src/db.ts";
import { demoConfig, seedDemo } from "../src/demo.ts";
import { admission } from "../src/fixes.ts";
import { announce, inbox } from "../src/inbox.ts";
import { envSecrets } from "../src/launchd.ts";
import { buildHandoff, generateLens } from "../src/lens.ts";
import { OpenCodeClient } from "../src/opencode.ts";
import { snapshot } from "../src/snapshot.ts";
import { type Clean } from "../src/store.ts";
import { Tools } from "../src/tools.ts";
import { fixGateKey } from "../src/trial.ts";
import { Platform, run, withConfig, withStore } from "./effect.ts";

const kube = { type: "kubernetes", context: "c", namespace: "n", selector: "app=shop" };
const fixes = { remote: "origin", base: "main", paths: ["config/a.json"], verify: [["node", "-e", "0"]] };

test("policyFor cascades env -> app -> global/default and parseConfig validates fixMode offline", () => {
  const dir = scratch("ow-policy-");
  const cfg = parseConfig({
    version: 2, dataDir: dir, readings: 3, opencode: { genUi: false },
    apps: {
      shop: {
        checkout: dir, fixes, policy: { readings: 5, notify: false, genUi: true },
        environments: {
          "prod-us-east": { policy: { critical: true, fixMode: "draft_pr", notify: true }, sources: { pods: kube } },
          staging: { policy: { investigate: false, fixMode: "off", genUi: false }, sources: { pods: kube } },
          production: { sources: { pods: kube } },
        },
      },
      plain: { checkout: dir, environments: { staging: { sources: { pods: kube } }, production: { sources: { pods: kube } } } },
    },
    watchers: [
      { app: "shop", environment: "prod-us-east" }, { app: "shop", environment: "staging" },
      { app: "shop", environment: "production" }, { app: "plain", environment: "staging" }, { app: "plain", environment: "production" },
    ],
  }, join(dir, "c.json"));

  assert.deepEqual(policyFor(cfg, "shop", "prod-us-east"), { investigate: true, readings: 5, notify: true, critical: true, fixMode: "draft_pr", genUi: true });
  assert.deepEqual(policyFor(cfg, "shop", "staging"), { investigate: false, readings: 5, notify: false, critical: false, fixMode: "off", genUi: false });
  assert.deepEqual(policyFor(cfg, "shop", "production"), { investigate: true, readings: 5, notify: false, critical: true, fixMode: "propose", genUi: true });
  assert.deepEqual(policyFor(cfg, "plain", "staging"), { investigate: true, readings: 3, notify: true, critical: false, fixMode: "off", genUi: false });
  assert.deepEqual(policyFor(cfg, "plain", "production"), { investigate: true, readings: 3, notify: true, critical: true, fixMode: "off", genUi: false });

  // Offline validation: fixMode propose/draft_pr without apps.<app>.fixes must fail fast.
  assert.throws(() => parseConfig({
    version: 2, dataDir: dir,
    apps: { shop: { checkout: dir, policy: { fixMode: "propose" }, environments: { prod: { sources: { pods: kube } } } } },
    watchers: [{ app: "shop", environment: "prod" }],
  }, join(dir, "bad1.json")), /policy\.fixMode requires apps\.shop\.fixes/);
  assert.throws(() => parseConfig({
    version: 2, dataDir: dir,
    apps: { shop: { checkout: dir, environments: { prod: { policy: { fixMode: "draft_pr" }, sources: { pods: kube } } } } },
    watchers: [{ app: "shop", environment: "prod" }],
  }, join(dir, "bad2.json")), /environments\.prod\.policy\.fixMode requires apps\.shop\.fixes/);
  // fixMode: "off" without fixes is valid.
  assert.doesNotThrow(() => parseConfig({
    version: 2, dataDir: dir,
    apps: { shop: { checkout: dir, environments: { prod: { policy: { fixMode: "off" }, sources: { pods: kube } } } } },
    watchers: [{ app: "shop", environment: "prod" }],
  }, join(dir, "ok.json")));
});

test("fixGateKey stays byte-identical without overrides and revokes on env/app fixMode changes", () => {
  const dir = scratch("ow-gate-");
  const base = parseConfig({
    version: 2, dataDir: dir, opencode: { url: "http://127.0.0.1:4096", model: "m1" },
    apps: { shop: { checkout: dir, fixes, environments: { prod: { sources: { pods: kube } }, staging: { sources: { pods: kube } } } } },
    watchers: [{ app: "shop", environment: "prod" }, { app: "shop", environment: "staging" }],
  }, join(dir, "c.json"));
  // Without env/app fixMode overrides, key matches original schema payload byte-for-byte.
  const sameWithNonFixPolicy = parseConfig({
    version: 2, dataDir: dir, opencode: { url: "http://127.0.0.1:4096", model: "m1" },
    apps: { shop: { checkout: dir, fixes, environments: { prod: { policy: { notify: false }, sources: { pods: kube } }, staging: { sources: { pods: kube } } } } },
    watchers: [{ app: "shop", environment: "prod" }, { app: "shop", environment: "staging" }],
  }, join(dir, "c.json"));
  assert.equal(fixGateKey(base, "shop"), fixGateKey(sameWithNonFixPolicy, "shop"));

  const withDraftPr = parseConfig({
    version: 2, dataDir: dir, opencode: { url: "http://127.0.0.1:4096", model: "m1" },
    apps: { shop: { checkout: dir, fixes, environments: { prod: { policy: { fixMode: "draft_pr" }, sources: { pods: kube } }, staging: { sources: { pods: kube } } } } },
    watchers: [{ app: "shop", environment: "prod" }, { app: "shop", environment: "staging" }],
  }, join(dir, "c.json"));
  assert.notEqual(fixGateKey(base, "shop"), fixGateKey(withDraftPr, "shop"));

  const withAppDraftPr = parseConfig({
    version: 2, dataDir: dir, opencode: { url: "http://127.0.0.1:4096", model: "m1" },
    apps: { shop: { checkout: dir, fixes, policy: { fixMode: "draft_pr" }, environments: { prod: { sources: { pods: kube } }, staging: { sources: { pods: kube } } } } },
    watchers: [{ app: "shop", environment: "prod" }, { app: "shop", environment: "staging" }],
  }, join(dir, "c.json"));
  assert.notEqual(fixGateKey(base, "shop"), fixGateKey(withAppDraftPr, "shop"));
});

test("policy runtime wiring: inbox critical/notify, readings planned, fixMode off, and generateLens 403", async () => {
  const dir = scratch("ow-policy-rt-");
  const cfg = parseConfig({
    version: 2, dataDir: dir, readings: 3, opencode: { genUi: false },
    apps: {
      shop: {
        checkout: dir, fixes,
        environments: {
          "prod-east": { policy: { critical: true, notify: false, readings: 2, fixMode: "off", genUi: false }, sources: { pods: kube } },
          production: { policy: { critical: false, genUi: true }, sources: { pods: kube } },
        },
      },
    },
    watchers: [{ app: "shop", environment: "prod-east" }, { app: "shop", environment: "production" }],
  }, join(dir, "c.json"));

  await run(withStore(dir, (store) => Effect.gen(function* () {
    clock.set(Date.UTC(2026, 10, 1), 1e6);
    const jobId = yield* store.tx((w) => Effect.gen(function* () {
      const s1 = yield* w.event("incident", "inc_pe" as Clean, {});
      yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_pe', 'shop', 'prod-east', 'shop/prod-east/pods', 'ERROR boom', 'error', 3, 1, 0, 1, ?, ?)", s1, s1);
      const s2 = yield* w.event("incident", "inc_pr" as Clean, {});
      yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_pr', 'shop', 'production', 'shop/production/pods', 'ERROR mild', 'error', 1, 1, 0, 1, ?, ?)", s2, s2);
      yield* announce(w, "inc_pe", null, s1);
      return yield* queueInvestigation(w, "inc_pe", "manual");
    }));
    // critical: true on prod-east puts it in working (once queued), and before queueing announce() saw needsYou but notify: false suppressed notification.
    assert.equal((yield* store.all("SELECT * FROM notifications")).length, 0);
    // production with critical: false goes to "new", not "needsYou".
    const box = yield* inbox;
    assert.ok(box.groups.new.includes("inc_pr"));
    assert.ok(!box.groups.needsYou.includes("inc_pr"));
    // readings override = 2 created 2 reading work items.
    const work = yield* store.all("SELECT * FROM work WHERE job_id = ? AND kind = 'reading'", jobId);
    assert.equal(work.length, 2);
    // fixMode: "off" halts admission as blocked.
    const adm = yield* admission("inc_pe", jobId);
    assert.equal(adm.state, "blocked");
    assert.match(adm.reason ?? "", /turned off/i);
    // generateLens returns 403 when genUi is false, and 503 (OpenCode unavailable) when genUi is true.
    const denied = yield* Effect.result(generateLens("inc_pe"));
    assert.equal(denied._tag, "Failure");
    assert.equal(denied.failure._tag === "ApiError" ? denied.failure.status : null, 403);
    const allowed = yield* Effect.result(generateLens("inc_pr"));
    assert.equal(allowed._tag, "Failure");
    assert.equal(allowed.failure._tag === "ApiError" ? allowed.failure.status : null, 503);
  }).pipe(Effect.provide(Layer.succeed(OpenCodeClient, OpenCodeClient.of({ connect: Effect.succeed(null) }))), withConfig(cfg), Effect.provide(Platform))));
});

test("checkSql attack corpus and renderQuery parameter binding", () => {
  for (const ok of [
    "SELECT id, status FROM orders WHERE id = 42 LIMIT 10",
    "SELECT id::text FROM orders WHERE name = 'shop';",
    "WITH recent AS (SELECT id FROM orders LIMIT 5) SELECT * FROM recent",
    "EXPLAIN SELECT * FROM orders",
    "SHOW TABLES",
  ]) assert.equal(checkSql(ok), null, `expected valid: ${ok}`);

  for (const bad of [
    "", "   ", "SELECT " + "a".repeat(2005),
    "SELECT 1 -- comment", "SELECT /* hidden */ 1", "SELECT 1 */",
    "SELECT 1; SELECT 2", "SELECT 1; DROP TABLE orders",
    "INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t",
    "DROP TABLE t", "ALTER TABLE t ADD COLUMN x INT", "CREATE TABLE t (a INT)", "TRUNCATE TABLE t",
    "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x",
    "GRANT ALL ON t TO u", "REVOKE ALL ON t FROM u", "COPY t TO '/tmp/a'",
    "CALL proc()", "DO $$ BEGIN END $$", "EXECUTE stmt", "PREPARE p AS SELECT 1", "DEALLOCATE p",
    "ATTACH DATABASE '/tmp/x' AS x", "DETACH DATABASE x", "PRAGMA table_info(orders)",
    "VACUUM", "REINDEX", "LOCK TABLE orders", "SET statement_timeout = 0", "RESET ALL",
    "\\! id", "SELECT 1 \\g /tmp/out", ".shell id", "SELECT 1\n.shell id",
    "EXPLAIN ANALYZE SELECT 1", "EXPLAIN (ANALYZE, BUFFERS) SELECT 1",
    "EXPLAIN ANALYSE SELECT 1", "EXPLAIN (ANALYSE true) SELECT 1",
    "SELECT set_config('statement_timeout', '0', false)",
    "SELECT pg_read_file('/etc/passwd')", "SELECT pg_ls_dir('.')",
    "SELECT pg_terminate_backend(123)", "SELECT pg_cancel_backend(123)",
    "SELECT lo_import('/etc/passwd')", "SELECT lo_export(1, '/tmp/x')",
    "SELECT * INTO OUTFILE '/tmp/x' FROM orders", "SELECT load_file('/etc/passwd')",
    "SELECT load_extension('/tmp/evil.so')", "SELECT 1\0",
  ]) assert.ok(checkSql(bad) !== null, `expected rejected: ${bad}`);

  // renderQuery safe binding + Postgres ::type preservation + ISO timestamp literals
  const r = renderQuery("SELECT id::text FROM orders WHERE created_at >= '2026-01-01T00:00:00Z' AND service = :svc AND limit_n <= :n AND active = :ok", ["svc", "n", "ok"], { svc: "checkout-api", n: 25, ok: true });
  assert.ok("sql" in r);
  assert.equal(r.sql, "SELECT id::text FROM orders WHERE created_at >= '2026-01-01T00:00:00Z' AND service = 'checkout-api' AND limit_n <= 25 AND active = TRUE");
  // Rejections
  assert.ok("error" in renderQuery("SELECT * FROM t WHERE id = :id", ["id"], {}));
  assert.ok("error" in renderQuery("SELECT * FROM t WHERE id = :id", ["id"], { id: 1, extra: 2 }));
  assert.ok("error" in renderQuery("SELECT * FROM t WHERE id = :undeclared", [], {}));
  assert.ok("error" in renderQuery("SELECT * FROM t WHERE s = :s", ["s"], { s: "x' OR '1'='1" }));
  assert.ok("error" in renderQuery("SELECT * FROM t WHERE s = :s", ["s"], { s: "a; DROP TABLE t" }));
  assert.ok("error" in renderQuery("SELECT * FROM t WHERE s = :s", ["s"], { s: "has spaces" }));
  assert.ok("error" in renderQuery("SELECT * FROM t WHERE n = :n", ["n"], { n: Number.POSITIVE_INFINITY }));
});

test("parseConfig validates database target configs offline", () => {
  const dir = scratch("ow-dbcfg-");
  const mk = (databases: unknown) => parseConfig({
    version: 2, dataDir: dir,
    apps: { shop: { checkout: dir, environments: { prod: { sources: { pods: kube }, databases } } } },
    watchers: [{ app: "shop", environment: "prod" }],
  }, join(dir, "c.json"));

  assert.throws(() => mk({ a: { driver: "sqlite", dsn: "env:DB_URL", allowSelect: true } }), /sqlite requires file/);
  assert.throws(() => mk({ a: { driver: "postgres", file: "x.db", allowSelect: true } }), /postgres requires dsn/);
  assert.throws(() => mk({ a: { driver: "mysql", dsn: "env:DB_URL" } }), /at least one query or set allowSelect/);
  assert.throws(() => mk({ a: { driver: "sqlite", file: "x.db", queries: { bad: { sql: "DELETE FROM orders" } } } }), /only SELECT, WITH, EXPLAIN, or SHOW/);
  assert.throws(() => mk({ a: { driver: "sqlite", file: "x.db", queries: { bad: { sql: "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x" } } } }), /disallowed SQL keyword/);
  const ok = mk({ primary: { driver: "sqlite", file: "app.db", queries: { locks: { sql: "SELECT id FROM locks WHERE svc = :svc", params: ["svc"] } } } });
  assert.equal(ok.databases.length, 1);
  assert.equal(ok.databases[0]!.id, "shop/prod/primary");
  assert.equal(ok.databases[0]!.file, join(dir, "app.db"));
});

test("end-to-end sqlite3 -readonly ow_db: run handles, redaction, roles, env isolation, owner MCP, and handoff", async () => {
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const dir = scratch("ow-db-e2e-");
  const prodDb = join(dir, "prod.sqlite"), stgDb = join(dir, "stg.sqlite");
  const db1 = new DatabaseSync(prodDb);
  db1.exec("CREATE TABLE locks (id INTEGER PRIMARY KEY, svc TEXT, state TEXT, note TEXT);");
  db1.exec("INSERT INTO locks VALUES (1, 'checkout', 'waiting', 'bearer sk-secret12345678901234567890'), (2, 'orders', 'active', 'ok');");
  db1.close();
  const db2 = new DatabaseSync(stgDb);
  db2.exec("CREATE TABLE locks (id INTEGER PRIMARY KEY, svc TEXT); INSERT INTO locks VALUES (9, 'staging-only');");
  db2.close();

  const cfg = parseConfig({
    version: 2, dataDir: dir,
    apps: {
      shop: {
        checkout: dir,
        environments: {
          prod: {
            sources: { pods: kube },
            databases: {
              primary: { driver: "sqlite", file: prodDb, queries: { by_svc: { sql: "SELECT id, svc, state, note FROM locks WHERE svc = :svc", params: ["svc"] } } },
              ro_select: { driver: "sqlite", file: prodDb, allowSelect: true },
            },
          },
          staging: {
            sources: { pods: kube },
            databases: {
              primary: { driver: "sqlite", file: stgDb, allowSelect: true },
            },
          },
        },
      },
    },
    watchers: [{ app: "shop", environment: "prod" }, { app: "shop", environment: "staging" }],
  }, join(dir, "c.json"));

  await run(withStore(dir, (store) => Effect.gen(function* () {
    clock.set(Date.UTC(2026, 10, 1), 1e6);
    const tools = yield* Tools;
    const prodDbs = cfg.databases.filter((d) => d.environment === "prod");
    const stgDbs = cfg.databases.filter((d) => d.environment === "staging");
    yield* store.tx((w) => Effect.gen(function* () {
      const seq = yield* w.event("job", "job_1" as Clean, {});
      yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_p', 'shop', 'prod', 'shop/prod/pods', 'ERROR db', 'error', 1, 1, 0, 1, ?, ?)", seq, seq);
      yield* w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq) VALUES ('job_1', 'investigation', 'inc_p', 't', 'running', NULL, ?)", seq);
      for (const [n, role] of (["investigator", "challenger", "responder", "fixer"] as const).entries()) {
        yield* w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms, role) VALUES (?, 'job_1', ?, ?, 'active', 0, '{}', 0, ?)",
          `run_${role}` as Clean, n + 1, `ses_${role}` as Clean, role as Clean);
      }
    }));
    const deadline = clock.mono() + 60_000;
    tools.contexts.set("run_investigator", { telemetry: {}, repo: null, deadline, role: "investigator", databases: prodDbs });
    tools.contexts.set("run_challenger", { telemetry: {}, repo: null, deadline, role: "challenger", databases: prodDbs });
    tools.contexts.set("run_responder", { telemetry: {}, repo: null, deadline, role: "responder", databases: stgDbs });
    tools.contexts.set("run_fixer", { telemetry: {}, repo: null, deadline, role: "fixer", databases: prodDbs });

    // Investigator named query -> real sqlite3 -readonly -> evidence handle + telemetry origin + redaction.
    const invRes = (yield* tools.call("ses_investigator", "ow_db", { target: "primary", query: "by_svc", params: { svc: "checkout" } })) as { pieces: Array<{ handle: string; source: string; text: string }> };
    assert.equal(invRes.pieces.length, 1);
    assert.equal(invRes.pieces[0]!.source, "db:primary");
    assert.match(invRes.pieces[0]!.handle, /^e_/);
    assert.ok(invRes.pieces[0]!.text.includes("checkout"));
    assert.ok(!invRes.pieces[0]!.text.includes("sk-secret12345678901234567890"));
    const originRow = yield* store.get<{ origin: string }>("SELECT origin FROM origins WHERE handle = ?", invRes.pieces[0]!.handle);
    assert.equal(originRow?.origin, "telemetry");

    // allowSelect: false refuses ad-hoc SQL; allowSelect: true allows SELECT.
    const noAdhoc = yield* Effect.result(tools.call("ses_investigator", "ow_db", { target: "primary", sql: "SELECT * FROM locks" }));
    assert.equal(noAdhoc._tag, "Failure");
    const chalRes = (yield* tools.call("ses_challenger", "ow_db", { target: "ro_select", sql: "SELECT count(*) AS n FROM locks" })) as { pieces: Array<{ text: string }> };
    assert.ok(chalRes.pieces[0]!.text.includes('"n":2'));

    // Env isolation: staging responder sees staging DB, NOT prod's ro_select.
    const stgRes = (yield* tools.call("ses_responder", "ow_db", { target: "primary", sql: "SELECT svc FROM locks" })) as { pieces: Array<{ text: string }> };
    assert.ok(stgRes.pieces[0]!.text.includes("staging-only"));
    const crossEnv = yield* Effect.result(tools.call("ses_responder", "ow_db", { target: "ro_select", sql: "SELECT 1" }));
    assert.equal(crossEnv._tag, "Failure");

    // Fixer is refused ow_db.
    const fixerRefused = yield* Effect.result(tools.call("ses_fixer", "ow_db", { target: "primary", query: "by_svc", params: { svc: "checkout" } }));
    assert.equal(fixerRefused._tag, "Failure");

    // Owner MCP session: unique name works, full id works, ambiguous name ("primary") refused, service run refused.
    const owner = {
      exists: (s: string) => Effect.succeed(s === "ses_owner"), inbox: Effect.succeed({}), get: () => Effect.succeed({}),
      search: () => Effect.succeed({}), act: () => Effect.succeed({}),
      db: (req: Parameters<typeof queryOwnerDb>[1]) => queryOwnerDb(cfg.databases, req).pipe(Effect.provide(Platform)),
    };
    const ownUnique = (yield* tools.call("ses_owner", "ow_db", { target: "ro_select", sql: "SELECT id FROM locks ORDER BY id" }, owner)) as { target: string; output: string; truncated: boolean };
    assert.equal(ownUnique.target, "shop/prod/ro_select");
    assert.ok(ownUnique.output.includes('"id":1'));
    const ownFull = (yield* tools.call("ses_owner", "ow_db", { target: "shop/staging/primary", sql: "SELECT svc FROM locks" }, owner)) as { target: string; output: string };
    assert.equal(ownFull.target, "shop/staging/primary");
    assert.ok(ownFull.output.includes("staging-only"));
    const ownAmbig = yield* Effect.result(tools.call("ses_owner", "ow_db", { target: "primary", sql: "SELECT 1" }, owner));
    assert.equal(ownAmbig._tag, "Failure");

    // buildHandoff includes ow_db when DBs exist for (app, env).
    const h = yield* buildHandoff("inc_p");
    assert.ok(h.mcpTools.includes("ow_db"));
  }).pipe(Effect.provide(Tools.layer), withConfig(cfg), Effect.provide(Platform))));
});

test("extends expands ~/ and launchd.envSecrets scans merged extended configs including DB dsn", async () => {
  const dir = scratch("ow-ext-secrets-");
  const baseFile = join(dir, "base.json"), childFile = join(dir, "child.json");
  writeFileSync(baseFile, JSON.stringify({
    version: 2,
    apps: {
      shop: {
        checkout: dir,
        environments: {
          prod: {
            sources: { dd: { type: "datadog", apiKey: "env:BASE_DD_API", appKey: "env:BASE_DD_APP", query: "service:shop", readings: ["logs"] } },
            databases: { pg: { driver: "postgres", dsn: "env:BASE_PG_DSN", allowSelect: true } },
          },
        },
      },
    },
    watchers: [{ app: "shop", environment: "prod" }],
  }));
  writeFileSync(childFile, JSON.stringify({ extends: "./base.json", dataDir: dir }));
  const secrets = await run(envSecrets(childFile).pipe(Effect.provide(Platform)));
  assert.ok(secrets.some((s) => s.includes("env:BASE_DD_API")));
  assert.ok(secrets.some((s) => s.includes("env:BASE_PG_DSN")));

  // ~/ in extends expands against homedir().
  const tildeChild = join(dir, "tilde.json");
  writeFileSync(tildeChild, JSON.stringify({ extends: "~/ow-nonexistent-base-test.json", version: 2, apps: {}, watchers: [] }));
  await assert.rejects(
    () => run(readMergedConfig(tildeChild).pipe(Effect.provide(Platform))),
    (err: Error) => err.message.includes(join(homedir(), "ow-nonexistent-base-test.json")),
  );
  await assert.rejects(
    () => run(loadConfig(tildeChild).pipe(Effect.provide(Platform))),
    (err: Error) => err.message.includes(join(homedir(), "ow-nonexistent-base-test.json")),
  );
});

test("snapshot exposes environments[].policy, jobs[].{verdict,seq}, fixes[], and demo stays intact", async () => {
  const d = await run(demoConfig(0).pipe(Effect.provide(Platform)));
  await run(withStore(d.dataDir, (store) => Effect.gen(function* () {
    clock.set(Date.UTC(2026, 10, 1), 1e6);
    yield* seedDemo;
    const snap = yield* snapshot(null, true);
    assert.equal(snap.incidents.length, 7);
    assert.equal(snap.environments.length, 3);
    const prod = snap.environments.find((e) => e.environment === "production")!;
    const stg = snap.environments.find((e) => e.environment === "staging")!;
    assert.deepEqual(prod.policy, { investigate: true, readings: 3, notify: true, critical: true, fixMode: "propose", genUi: false, databases: [] });
    assert.deepEqual(stg.policy, { investigate: false, readings: 3, notify: false, critical: false, fixMode: "propose", genUi: false, databases: [] });
    // jobs[] carry verdict and seq
    const inv = snap.jobs.find((j) => j.kind === "investigation" && j.subject === "inc_d0c4ab11")!;
    assert.equal(inv.verdict, "real");
    assert.equal(typeof inv.seq, "number");
    assert.ok(inv.seq > 0);
    // fixes[] carries latest fix per incident
    assert.equal(snap.fixes.length, 1);
    assert.deepEqual(snap.fixes[0], { id: "fx_d0c0db05", incident: "inc_d0c0db05", state: "verified", seq: snap.fixes[0]!.seq, prUrl: null });
    // Demo inc_d0c4ab11 has db:primary evidence piece with telemetry origin
    const dbEv = yield* store.get<{ source: string; text: string; origin: string }>(
      "SELECT e.source, e.text, o.origin FROM evidence e JOIN origins o ON o.handle = e.handle WHERE e.source = 'db:primary'");
    assert.ok(dbEv);
    assert.equal(dbEv.origin, "telemetry");
    assert.ok(Array.isArray(JSON.parse(dbEv.text)));
  }).pipe(withConfig(d), Effect.provide(Platform))));
});
