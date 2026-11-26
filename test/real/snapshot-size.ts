/**
 * Snapshot size and build time with 200 problems in six environments (manual):
 *   node --experimental-strip-types --no-warnings test/real/snapshot-size.ts [problems]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { parseConfig } from "../../src/config.ts";
import { type Clean } from "../../src/store.ts";
import { run, withConfig, withStore } from "../effect.ts";
import { snapshot } from "../../src/snapshot.ts";
import { hourly } from "../../src/inbox.ts";
import { clock } from "../../src/clock.ts";

const problems = Number(process.argv[2] ?? 200);
const dataDir = mkdtempSync(join(tmpdir(), "ow-snapshot-size-"));
const envs = ["prod", "staging", "qa", "canary", "eu", "us"];
const config = parseConfig({
  version: 2, dataDir,
  apps: { shop: { checkout: "/tmp", environments: Object.fromEntries(envs.map((e) => [e, { sources: { pods: { type: "kubernetes", context: e, namespace: "shop", selector: "app=shop" } } }])) } },
  watchers: envs.map((environment) => ({ app: "shop", environment, every: "2m" })),
}, join(dataDir, "c.json"));
const now = Date.UTC(2026, 10, 25, 12);
clock.set(now, 1e6);
await run(withStore(dataDir, (store) => Effect.gen(function* () {
  yield* store.tx((w) => Effect.gen(function* () {
    for (let n = 0; n < problems; n++) {
      const env = envs[n % envs.length]!, id = `inc_${String(n).padStart(8, "0")}`;
      const seq = yield* w.event("slice", `shop/${env}/pods` as Clean, {});
      yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES (?, 'shop', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
        id as Clean, env as Clean, `shop/${env}/pods` as Clean, `ERROR worker ${n} failed to reconcile shard ${n % 17} after timeout` as Clean, (n % 3 ? "error" : "warn") as Clean, 10 + n, now - 86_400_000, now, seq, seq);
      for (let h = 0; h < 24; h += 2) yield* hourly(w, id, now - h * 3_600_000, 1 + (n % 5));
    }
  }));
  const runs: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    bytes = JSON.stringify(yield* snapshot(null, true)).length;
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  console.log(JSON.stringify({ problems, environments: envs.length, bytes, kib: Math.round(bytes / 1024), buildMs: { median: +runs[10]!.toFixed(1), p95: +runs[18]!.toFixed(1), max: +runs[19]!.toFixed(1) } }));
}).pipe(withConfig(config))));
