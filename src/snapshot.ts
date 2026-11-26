/**
 * The snapshot: everything `status`, the change stream and (later) the page show, computed by the server.
 *
 * Health is the least-known reading. An environment is signed out if a source's sign-in failed; stale if any expected
 * reading has never succeeded or is older than three polling intervals (by the wall clock or, while the process
 * lives, the monotonic clock, so it ages even while a read hangs); partial if a source is failing, a reading is
 * failed, missing, capped or cut, or collection is paused; needs a look (attention) if an error is open; and only then
 * quiet. With no expected reading at all it can never be quiet.
 */
import { comparisons, forecasts } from "./outlook.ts";
import { LIMITS, type Config } from "./config.ts";
import { clock } from "./clock.ts";
import { approvalKey } from "./trial.ts";
import { inbox, rows as incidentRows } from "./inbox.ts";
import type { Collector } from "./collect.ts";
import type { Store } from "./store.ts";

export type Health = "quiet" | "attention" | "partial" | "stale" | "signed_out";

interface SourceRow {
  id: string;
  checkpoint_ms: number | null;
  failure: string | null;
  streak: number;
  next_ms: number | null;
  suspended: number;
  endpoint: string | null;
  fix: string | null;
}

export function snapshot(store: Store, config: Config, collector: Collector | null, live: boolean) {
  const now = clock.now(), mono = clock.mono();
  const rows = new Map(store.all<SourceRow>("SELECT * FROM sources").map((r) => [r.id, r]));
  const readings = new Map(
    store.all<{ source: string; reading: string; state: string; ok_ms: number | null }>("SELECT source, reading, state, ok_ms FROM readings").map((r) => [`${r.source}|${r.reading}`, r]),
  );
  const errors = new Set(store.all<{ place: string }>("SELECT DISTINCT app || '/' || environment AS place FROM incidents WHERE severity = 'error' AND active = 1").map((r) => r.place));

  const environments = config.watchers.map((w) => {
    const limit = LIMITS.freshIntervals * w.everyMs;
    let health: Health = "quiet";
    const worse = (h: Health) => {
      const order: Health[] = ["quiet", "attention", "partial", "stale", "signed_out"];
      if (order.indexOf(h) > order.indexOf(health)) health = h;
    };
    if (w.sources.every((s) => s.readings.length === 0)) worse("stale");
    if (errors.has(`${w.app}/${w.environment}`)) worse("attention");
    if (collector?.paused) worse("partial");
    // Each expected reading with when it was last measured (by the older-looking clock, as of atMs): a viewer ages
    // these on its own clock, so a live connection never certifies a measurement that has since gone old.
    const measured: Array<{ source: string; reading: string; state: string | null; okMs: number | null }> = [];
    for (const s of w.sources) {
      const row = rows.get(s.id);
      if (row?.failure === "signin") worse("signed_out");
      else if (row?.failure) worse("partial");
      for (const reading of s.readings) {
        const r = readings.get(`${s.id}|${reading}`);
        const okMono = collector?.okAtMono(s.id, reading);
        const age = r?.ok_ms == null ? Infinity : Math.max(now - r.ok_ms, okMono === undefined ? 0 : mono - okMono);
        measured.push({ source: s.id, reading, state: r?.state ?? null, okMs: Number.isFinite(age) ? now - age : null });
        if (age > limit) worse("stale");
        else if (r!.state !== "ok") worse("partial");
      }
    }
    return {
      app: w.app,
      environment: w.environment,
      subject: `env:${w.app}/${w.environment}`,
      health,
      readings: measured,
      freshForMs: limit,
      excluded: w.sources.flatMap((s) => s.excluded.map((r) => `${s.name}:${r}`)),
    };
  });

  const sources = config.sources.map((s) => {
    const r = rows.get(s.id);
    return { id: s.id, subject: `src:${s.id}`, app: s.app, environment: s.environment, kind: s.kind, checkpointMs: r?.checkpoint_ms ?? null, failure: r?.failure ?? null, streak: r?.streak ?? 0, nextMs: r?.next_ms ?? null, suspended: r?.suspended === 1, fix: r?.failure ? r.fix : null };
  });

  // One cause per failure; everything unreachable at once, across several independent endpoints, is one: offline.
  const failing = config.sources.filter((s) => rows.get(s.id)?.failure);
  const endpoints = new Set(failing.map((s) => rows.get(s.id)!.endpoint));
  const offline = failing.length >= 2 && failing.length === config.sources.length && endpoints.size >= 2 && failing.every((s) => rows.get(s.id)!.failure === "unreachable");
  const causes = offline
    ? [{ id: "offline", kind: "offline", sources: failing.map((s) => s.id) }]
    : failing.map((s) => ({ id: s.id, kind: rows.get(s.id)!.failure!, sources: [s.id], fix: rows.get(s.id)!.fix }));

  const coverage = store
    .all<{ source: string; reading: string; from_ms: number; to_ms: number; state: string; missed: number | null }>(
      `SELECT source, reading, from_ms, to_ms, state, missed FROM coverage
       WHERE id IN (SELECT max(id) FROM coverage GROUP BY source, reading)
          OR id IN (SELECT id FROM coverage WHERE state IN ('gap', 'capped') ORDER BY id DESC LIMIT 100)
       ORDER BY id`,
    )
    .map((c) => ({ source: c.source, reading: c.reading, fromMs: c.from_ms, toMs: c.to_ms, state: c.state, missed: c.missed }));

  return {
    version: 2,
    seq: store.seq(),
    atMs: now,
    live,
    paused: collector?.paused ?? null,
    pausedFix: collector?.paused === "disk"
      ? `Free disk space (collection needs ${LIMITS.freeFloorBytes / 1024 ** 2} MiB free) or move dataDir to a larger disk; the database is kept under ${LIMITS.databaseBudgetBytes / 1024 ** 3} GiB by dropping old history, never evidence a finding cites`
      : null,
    automation: store.meta(approvalKey(config)) === "on",
    environments,
    sources,
    incidents: incidentRows(store),
    inbox: inbox(store),
    coverage,
    metrics: store.all<{ source: string; name: string; value: number; at_ms: number; breach: number }>("SELECT * FROM metrics ORDER BY source, name").map((m) => ({ source: m.source, name: m.name, value: m.value, atMs: m.at_ms, breach: m.breach === 1 })),
    deploys: store.all("SELECT app, environment, revision, previous, seq FROM deploys ORDER BY seq"),
    outlook: { forecasts: forecasts(store, config), comparisons: comparisons(store, config) },
    causes,
    // Real work at the top; the trial's calibration work in its own namespace.
    jobs: jobs(store, false),
    findings: findings(store, false),
    trial: { jobs: jobs(store, true), findings: findings(store, true) },
  };
}

function jobs(store: Store, trial: boolean) {
  return store
    .all<{ id: string; state: string; session_id: string | null; kind: string; subject: string; reason: string | null }>(
      `SELECT j.id, j.state, j.kind, j.subject, j.reason, (SELECT session_id FROM runs r WHERE r.job_id = j.id ORDER BY attempt DESC LIMIT 1) AS session_id
       FROM jobs j WHERE (j.kind = 'trial') = ? ORDER BY j.created_seq, j.id`,
      trial ? 1 : 0,
    )
    .map((j) => ({ id: j.id, kind: j.kind, subject: j.subject, state: j.state, sessionId: j.session_id, reason: j.reason }));
}

function findings(store: Store, trial: boolean) {
  return store
    .all<{ id: string; verdict: string; claims: string; code: string }>(
      "SELECT f.id, f.verdict, f.claims, f.code FROM findings f JOIN runs r ON r.id = f.run_id JOIN jobs j ON j.id = r.job_id WHERE (j.kind = 'trial') = ? ORDER BY f.rowid",
      trial ? 1 : 0,
    )
    .map((f) => ({ id: f.id, verdict: f.verdict, claims: JSON.parse(f.claims), code: JSON.parse(f.code) }));
}

export type Snapshot = ReturnType<typeof snapshot>;
