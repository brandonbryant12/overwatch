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
import type { Clean, Store } from "./store.ts";

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
  store.tx((w) => {
    for (const source of config.sources) {
      const signedOut = source.environment === "qa";
      w.run(
        "INSERT INTO sources (id, checkpoint_ms, failure, streak, next_ms, suspended, fix, endpoint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        s(source.id), signedOut ? now - 3_600_000 : now, signedOut ? s("signin") : null, signedOut ? 2 : 0, now + source.everyMs, signedOut ? 1 : 0,
        signedOut ? s(`Sign in to ${source.context} again, then check with: kubectl --context ${source.context} -n shop get pods`) : null, s(`kubernetes:${source.context}`),
      );
      for (const reading of source.readings) {
        w.run("INSERT INTO readings (source, reading, state, at_ms, ok_ms) VALUES (?, ?, 'ok', ?, ?)", s(source.id), s(reading), signedOut ? now - 3_600_000 : now, signedOut ? now - 3_600_000 : now);
      }
    }
    const before = w.event("deploy", s("shop/production"), { revision: "9f8e7d6c5b4a", previous: null, demo: true });
    w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'production', '9f8e7d6c5b4a', NULL)", before);
    const old = w.event("incident", s("shop/production"), { title: "ERROR search index rebuild stalled", demo: true, resolved: true });
    w.run(
      "INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES ('inc_0d10', 'shop', 'production', 'shop/production/pods', ?, 'error', 7, 1, ?, ?, ?)",
      s("ERROR search index rebuild stalled (resolved)"), now - 9 * 86_400_000, now - 8 * 86_400_000, old,
    );
    const deploy = w.event("deploy", s("shop/production"), { revision: "a1b2c3d4e5f6", previous: "9f8e7d6c5b4a", demo: true });
    w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'production', 'a1b2c3d4e5f6', '9f8e7d6c5b4a')", deploy);
    const timeout = w.event("incident", s("shop/production"), { title: "ERROR checkout: payments timeout after 300ms", demo: true });
    w.run(
      "INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES ('inc_0d11', 'shop', 'production', 'shop/production/pods', ?, 'error', 42, 1, ?, ?, ?)",
      s("ERROR checkout: payments timeout after 300ms"), now - 1_200_000, now - 60_000, timeout,
    );
    const noise = w.event("incident", s("shop/staging"), { title: "WARN cache warm-up took longer than 2s", demo: true });
    w.run(
      "INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES ('inc_0d12', 'shop', 'staging', 'shop/staging/pods', ?, 'warn', 3, 1, ?, ?, ?)",
      s("WARN cache warm-up took longer than 2s"), now - 7_200_000, now - 600_000, noise,
    );
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
