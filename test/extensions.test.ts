import { scratch } from "./scratch.ts";
/**
 * Extensions: corporate config layering (`extends`), custom `redactPatterns`, local GPU (GLM 5.3) tuning,
 * opt-in Datadog slow-span collection, read-only commit watcher, declarative GenUI `LensSpec` handle verification,
 * structured OpenCode handoff, `ow_brief`/`ow_outlook` owner MCP tools, and demo seeding invariants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { clock } from "../src/clock.ts";
import { Collector } from "../src/collect.ts";
import { AppConfig, loadConfig, parseConfig } from "../src/config.ts";
import { demoConfig, seedDemo } from "../src/demo.ts";
import { buildHandoff, lensesFor, verifyLens, type LensSpec } from "../src/lens.ts";
import { commits, watchCommits } from "../src/outlook.ts";
import { clean, outbound, setRedactPatterns } from "../src/redact.ts";
import { snapshot } from "../src/snapshot.ts";
import { Store, type Clean } from "../src/store.ts";
import { Tools } from "../src/tools.ts";
import { Platform, run, withConfig, withStore } from "./effect.ts";

test("config extends layers base corporate templates and rejects circular extends", async () => {
  const dir = scratch("ow-extends-");
  const baseFile = join(dir, "corp-base.json");
  const childFile = join(dir, "personal.json");
  writeFileSync(baseFile, JSON.stringify({
    version: 2,
    redactPatterns: ["corp_tok_[A-Za-z0-9]{8,}"],
    readings: 5,
    opencode: { concurrency: 4, toolCalls: 16, genUi: true, model: "private/glm-5.3" },
    apps: {
      shop: {
        checkout: "/corp/default/shop",
        commitWatch: { branch: "main", paths: ["config/"], limit: 10 },
        fixes: { remote: "origin", base: "main", paths: ["config/settings.json"], verify: [["node", "-e", "0"]], mode: "draft_pr" },
        environments: {
          prod: { sources: { dd: { type: "datadog", apiKey: "env:DD_A", appKey: "env:DD_B", query: "service:shop", metric: "avg:shop.err{*}", spans: { slowMs: 500, warnMs: 250 } } } },
        },
      },
    },
    watchers: [{ app: "shop", environment: "prod", every: "2m" }],
  }));
  writeFileSync(childFile, JSON.stringify({
    extends: "./corp-base.json",
    dataDir: join(dir, "data"),
    apps: { shop: { checkout: join(dir, "my-shop") } },
  }));
  const cfg = await run(loadConfig(childFile).pipe(Effect.provide(Platform)));
  assert.equal(cfg.readings, 5);
  assert.equal(cfg.opencode.concurrency, 4);
  assert.equal(cfg.opencode.toolCalls, 16);
  assert.equal(cfg.opencode.genUi, true);
  assert.equal(cfg.apps.shop!.checkout, join(dir, "my-shop"));
  assert.equal(cfg.apps.shop!.fixes?.mode, "draft_pr");
  assert.equal(cfg.apps.shop!.commitWatch?.branch, "main");
  assert.deepEqual(cfg.sources[0]!.readings, ["logs", "monitors", "metrics", "spans"]);
  assert.deepEqual(cfg.sources[0]!.excluded, []);
  // Custom redaction pattern applied to both clean() and outbound().
  assert.equal(clean("leaked corp_tok_AbCd123456 here"), "leaked [REDACTED:custom] here");
  assert.equal(outbound("sent corp_tok_ZzYy998877"), "sent [REDACTED:custom]");
  setRedactPatterns([]);
  assert.equal(clean("corp_tok_AbCd123456"), "corp_tok_AbCd123456");

  // Circular extends must fail offline with ConfigError.
  const a = join(dir, "a.json"), b = join(dir, "b.json");
  writeFileSync(a, JSON.stringify({ extends: "./b.json", version: 2, apps: {}, watchers: [] }));
  writeFileSync(b, JSON.stringify({ extends: "./a.json", version: 2, apps: {}, watchers: [] }));
  await assert.rejects(() => run(loadConfig(a).pipe(Effect.provide(Platform))), /circular extends/i);
});

test("Datadog opt-in slow spans deduplicate by span ID and populate span_waterfall lenses", async () => {
  const spansReply = {
    data: [
      { id: "sp-1", attributes: { timestamp: "2026-11-01T00:00:10Z", service: "checkout", resource_name: "POST /v2/authorize", duration: 1_250_000_000, trace_id: "tr-1", status: "ok" } },
      { id: "sp-2", attributes: { timestamp: "2026-11-01T00:00:20Z", service: "checkout", resource_name: "POST /v2/authorize", duration: 420_000_000, trace_id: "tr-2", status: "ok" } },
      { id: "sp-fast", attributes: { timestamp: "2026-11-01T00:00:30Z", service: "checkout", resource_name: "POST /v2/authorize", duration: 50_000_000, trace_id: "tr-3", status: "ok" } },
    ],
  };
  let spanCalls = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url?.startsWith("/api/v2/spans")) spanCalls++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(spansReply));
  });
  const base = await new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  process.env.OW_EXT_DD = "k";
  try {
    const dataDir = scratch("ow-spans-");
    const cfg = parseConfig({
      version: 2, dataDir,
      apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { dd: { type: "datadog", baseUrl: base, apiKey: "env:OW_EXT_DD", appKey: "env:OW_EXT_DD", query: "service:checkout", readings: ["spans"], spans: { slowMs: 500, warnMs: 300 } } } } } } },
      watchers: [{ app: "shop", environment: "prod", every: "1m" }],
    }, join(dataDir, "c.json"));
    const runtime = ManagedRuntime.make(Collector.layer.pipe(Layer.provideMerge(Store.layer(dataDir)), Layer.provideMerge(AppConfig.layer(cfg)), Layer.provideMerge(Platform)));
    try {
      const t0 = Date.UTC(2026, 10, 1);
      clock.set(t0 + 60_000, 1e6);
      await runtime.runPromise(Collector.use((c) => c.setSpace({ freeBytes: 1024 ** 4, dbBytes: 0 })));
      await runtime.runPromise(Collector.use((c) => c.pass));
      // Replay the same window: span IDs must deduplicate (count stays 2, never 4).
      clock.set(t0 + 120_000, 1e6 + 60_000);
      await runtime.runPromise(Collector.use((c) => c.pass));
      assert.ok(spanCalls >= 2);
      const inc = await runtime.runPromise(Store.use((s) => s.get<{ id: string; count: number; severity: string }>("SELECT id, count, severity FROM incidents")));
      assert.ok(inc);
      assert.equal(inc.count, 2);
      assert.equal(inc.severity, "error");
      const { lens } = await runtime.runPromise(lensesFor(inc.id));
      assert.ok(lens);
      const waterfall = lens.blocks.find((b) => b.kind === "span_waterfall");
      assert.ok(waterfall && waterfall.kind === "span_waterfall");
      assert.equal(waterfall.spans.length, 2);
    } finally {
      await runtime.dispose();
    }
  } finally {
    server.close();
  }
});

test("watchCommits tracks new git commits with deterministic risk flags and deployment status", async () => {
  const dir = scratch("ow-commits-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "config"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=Dev", "-c", "user.email=dev@example", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(repo, "config", "database.json"), '{"pool_size":20,"timeout_ms":3000}\n');
  git("add", ".");
  git("commit", "-qm", "chore(config): tune database timeout and pool");
  const sha1 = git("rev-parse", "HEAD");

  const dataDir = join(dir, "data");
  const cfg = parseConfig({
    version: 2, dataDir,
    apps: { shop: { checkout: repo, commitWatch: { paths: ["config/"], limit: 5 }, environments: { prod: { sources: { pods: { type: "kubernetes", context: "c", namespace: "n", selector: "app=shop" } } } } } },
    watchers: [{ app: "shop", environment: "prod", every: "1m" }],
  }, join(dir, "c.json"));

  await run(withStore(dataDir, (store) => Effect.gen(function* () {
    clock.set(Date.UTC(2026, 10, 1), 1e6);
    yield* watchCommits;
    const before = yield* commits;
    assert.equal(before.length, 1);
    assert.equal(before[0]!.sha, sha1);
    assert.ok(before[0]!.flags.includes("config"));
    assert.ok(before[0]!.flags.includes("database"));
    assert.ok(before[0]!.flags.includes("timeout"));
    assert.ok(before[0]!.flags.includes("watched_path"));
    assert.ok(before[0]!.flags.includes("unreleased"));
    assert.deepEqual(before[0]!.deployedEnvs, []);
    // After a deploy of sha1 to prod, deployedEnvs updates and flag flips to deployed.
    yield* store.tx((w) => Effect.gen(function* () {
      const seq = yield* w.event("deploy", "shop/prod" as Clean, { revision: sha1 });
      yield* w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'prod', ?, NULL)", seq, sha1 as Clean);
    }));
    const after = yield* commits;
    assert.deepEqual(after[0]!.deployedEnvs, ["prod"]);
    assert.ok(after[0]!.flags.includes("deployed"));
  }).pipe(withConfig(cfg), Effect.provide(Platform))));
});

test("verifyLens strips ungrounded handles, buildHandoff formats context, and ow_brief/ow_outlook serve owner sessions only", async () => {
  const spec: LensSpec = {
    source: "ai", title: "T", summary: "S", generatedAt: 1000, verifiedHandles: ["e_real", "e_fake"],
    blocks: [{ kind: "key_facts", title: "Facts", facts: [{ label: "A", value: "1", origin: "telemetry", handle: "e_real" }, { label: "B", value: "2", origin: "telemetry", handle: "e_fake" }] }],
  };
  const checked = verifyLens(spec, new Set(["e_real"]));
  assert.deepEqual(checked.verifiedHandles, ["e_real"]);
  assert.equal(checked.blocks[0]!.kind === "key_facts" && checked.blocks[0]!.facts[0]!.handle, "e_real");
  assert.equal(checked.blocks[0]!.kind === "key_facts" && checked.blocks[0]!.facts[1]!.handle, undefined);

  // Demo seed check: 7 incidents, 3 envs, commits populated, AI lens grounded, handoff works, ow_brief/ow_outlook work.
  const d = await run(demoConfig(0).pipe(Effect.provide(Platform)));
  await run(withStore(d.dataDir, (store) => Effect.gen(function* () {
    clock.set(Date.UTC(2026, 10, 1), 1e6);
    yield* seedDemo;
    const snap = yield* snapshot(null, true);
    assert.equal(snap.incidents.length, 7);
    assert.equal(snap.environments.length, 3);
    assert.equal(snap.outlook.commits.length, 3);
    const { lens, lenses } = yield* lensesFor("inc_d0c4ab11");
    assert.equal(lens?.source, "ai");
    assert.equal(lenses.length, 2);
    assert.ok(lens!.verifiedHandles.length >= 2);
    const handoff = yield* buildHandoff("inc_d0c4ab11");
    assert.equal(handoff.id, "inc_d0c4ab11");
    assert.equal(handoff.app, "shop");
    assert.equal(handoff.env, "production");
    assert.ok(handoff.handles.length >= 2);
    assert.ok(handoff.prompt.includes("ow_get"));
    assert.ok(handoff.markdown.includes("Evidence Handles"));
    // Owner MCP tools ow_brief and ow_outlook work for owner sessions and refuse service-run sessions.
    const tools = yield* Tools;
    const owner = {
      exists: () => Effect.succeed(true), inbox: Effect.succeed({}), get: () => Effect.succeed({}),
      search: () => Effect.succeed({}), act: () => Effect.succeed({}),
      brief: () => Effect.succeed({ audience: "owner", text: "ok" }),
      outlook: Effect.succeed({ forecasts: [], comparisons: [], commits: snap.outlook.commits }),
    };
    const bRes = (yield* tools.call("ses_owner_1", "ow_brief", { audience: "owner" }, owner)) as { audience: string };
    assert.equal(bRes.audience, "owner");
    const oRes = (yield* tools.call("ses_owner_1", "ow_outlook", {}, owner)) as { commits: unknown[] };
    assert.equal(oRes.commits.length, 3);
    // A service-run session from demo must be refused.
    const runSession = (yield* store.get<{ session_id: string }>("SELECT session_id FROM runs LIMIT 1"))!.session_id;
    const refused = yield* Effect.result(tools.call(runSession, "ow_outlook", {}, owner));
    assert.equal(refused._tag, "Failure");
  }).pipe(Effect.provide(Tools.layer), withConfig(d), Effect.provide(Platform))));
});
