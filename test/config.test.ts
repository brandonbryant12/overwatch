import "./scratch.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { ConfigError, parseConfig } from "../src/config.ts";

const pods = { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" };
const config = (apps: number, sources: number, every: string) => ({
  version: 2,
  dataDir: "/tmp/ow-config-test",
  apps: Object.fromEntries(
    Array.from({ length: apps }, (_, i) => [`app${i}`, { checkout: "/tmp", environments: { prod: { sources: Object.fromEntries(Array.from({ length: sources }, (_, j) => [`s${j}`, pods])) } } }]),
  ),
  watchers: Array.from({ length: apps }, (_, i) => ({ app: `app${i}`, environment: "prod", every })),
});

test("watchers, sources per watcher and the polling interval are refused beyond their limits, exactly", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 52 }), fc.integer({ min: 1, max: 6 }), fc.integer({ min: 30, max: 90 }), (n, s, secs) => {
      const ok = n <= 50 && s <= 4 && secs >= 60;
      const run = () => parseConfig(config(n, s, `${secs}s`), "/tmp/config.json");
      if (ok) assert.equal(run().watchers.length, n);
      else assert.throws(run, ConfigError);
    }),
    { numRuns: 200 },
  );
});

test("keys outside the grammar, duplicates and the wrong version are refused with the path", () => {
  assert.throws(() => parseConfig({ ...config(1, 1, "1m"), extra: true }, "/tmp/c.json"), /config\.extra/);
  assert.throws(() => parseConfig({ ...config(1, 1, "1m"), version: 1 }, "/tmp/c.json"), /version must be 2/);
  const twice = config(1, 1, "1m");
  twice.watchers.push(twice.watchers[0]!);
  assert.throws(() => parseConfig(twice, "/tmp/c.json"), /watched twice/);
  const bad = config(1, 1, "1m");
  (bad.apps.app0!.environments.prod.sources as Record<string, unknown>).s0 = { ...pods, readings: ["logs", "telepathy"] };
  assert.throws(() => parseConfig(bad, "/tmp/c.json"), /readings/);
});

test("readings left out are recorded as excluded, and production defaults to two minutes", () => {
  const c = config(1, 1, "1m");
  (c.apps.app0!.environments.prod.sources as Record<string, unknown>).s0 = { ...pods, readings: ["logs"] };
  delete (c.watchers[0] as { every?: string }).every;
  const parsed = parseConfig(c, "/tmp/c.json");
  assert.deepEqual(parsed.sources[0]!.excluded, ["events", "workloads", "usage"]);
  assert.equal(parsed.watchers[0]!.everyMs, 120_000);
});
