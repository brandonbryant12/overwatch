/**
 * One run of one watcher: every source is read since its checkpoint, in slices, oldest first. Occurrences already
 * counted are dropped, what is new is reported to the incidents, and only then do the checkpoint, the
 * de-duplication state and the covered windows move, together. A crash between the two repeats the run; the reports
 * carry deterministic command ids, so nothing is counted twice.
 *
 * Only what happened becomes an event: a run that finds nothing writes rows to the coverage table and nothing to the
 * journal. A stretch the lookback cap cut off is a gap, recorded on the Watcher.
 */
import type { DatabaseSync } from "node:sqlite";
import type { WatcherConfig } from "../collect/options.ts";
import { sourceContext, type Runtime } from "../collect/runtime.ts";
import { dedupe, fingerprint, pruneSeen, type Seen, type Signal } from "../collect/signals.ts";
import { sourceType } from "../collect/sources/index.ts";
import { planWindows } from "../collect/window.ts";
import { redactText } from "../domain/redact.ts";
import { incidentIdOf, type IncidentId, type Severity } from "../domain/ids.ts";

export interface SignalReport {
  readonly incidentId: IncidentId;
  /** Deterministic, so a repeated run cannot count the same occurrences twice. */
  readonly commandId: string;
  readonly app: string;
  readonly environment: string;
  readonly watcher: string;
  readonly source: string;
  readonly fingerprint: string;
  readonly title: string;
  readonly severity: Severity;
  readonly at: number;
  readonly count: number;
  readonly firstAt?: number;
  readonly sample?: string;
  readonly query?: string;
}

export interface Gap {
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

export interface CollectorPorts {
  readonly runtime: Runtime;
  /** Runs work on the service's connection, under its lock, in one transaction. */
  readonly atomically: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  readonly read: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  readonly report: (report: SignalReport) => Promise<void>;
  readonly recordGap: (watcher: string, gap: Gap) => Promise<void>;
}

export interface WatcherRunSummary {
  readonly watcher: string;
  readonly startedAt: number;
  readonly reported: number;
  readonly windows: ReadonlyArray<{ readonly source: string; readonly from: number; readonly to: number; readonly status: "ok" | "failed"; readonly note?: string }>;
  readonly gaps: ReadonlyArray<Gap>;
  readonly failed: ReadonlyArray<string>;
}

const SEEN_KEEP_MS = 14 * 86_400_000;

export async function runWatcher(ports: CollectorPorts, watcher: WatcherConfig, signal: AbortSignal = new AbortController().signal): Promise<WatcherRunSummary> {
  const { runtime } = ports;
  const options = runtime.options;
  const now = runtime.now();
  const app = options.apps[watcher.app]!;
  const env = app.environments[watcher.environment]!;
  const windows: Array<WatcherRunSummary["windows"][number]> = [];
  const gaps: Gap[] = [];
  const failed: string[] = [];
  let reported = 0;

  for (const source of watcher.sources) {
    const config = env.sources[source]!;
    const type = sourceType(config.type);
    if (!type) {
      failed.push(source);
      continue;
    }
    const stored = await ports.read(
      (db) => db.prepare("SELECT at, seen FROM checkpoints WHERE watcher = ? AND source = ?").get(watcher.id, source) as { at: number; seen: string } | undefined,
    );
    let seen: Seen = stored ? (JSON.parse(stored.seen) as Seen) : {};
    const plan = planWindows({ now, ...(stored ? { checkpoint: stored.at } : {}), ...options.lookback });
    if (plan.truncated) {
      gaps.push({ source, from: plan.truncated.requestedFrom, to: plan.truncated.coveredFrom, reason: "older than the lookback limit when the watcher caught up" });
    }
    const scratch = new Map<string, unknown>();
    const fresh: Signal[] = [];
    let checkpoint = stored?.at;
    const covered: Array<WatcherRunSummary["windows"][number]> = [];
    for (const [index, window] of plan.windows.entries()) {
      const deadline = Date.now() + options.timeouts.sliceMs;
      try {
        const context = sourceContext(runtime, watcher.app, watcher.environment, source, signal, { deadline, scratch });
        const result = await type.collect(config, { window, final: index === plan.windows.length - 1 }, context);
        const deduped = dedupe(result.signals, seen, options.lookback.overlapMs);
        seen = deduped.seen;
        fresh.push(...deduped.fresh);
        checkpoint = window.to;
        covered.push({ source, from: window.from, to: window.to, status: "ok", ...(result.notes.length ? { note: redactText(result.notes.join("; "), { maxBytes: 1000 }) } : {}) });
      } catch (error) {
        // The checkpoint stays at the end of the last slice that worked; the next run starts there.
        covered.push({ source, from: window.from, to: window.to, status: "failed", note: redactText((error as Error).message, { maxBytes: 500 }) });
        failed.push(source);
        break;
      }
    }

    // Report first; then move the checkpoint. Group what is new by fingerprint across slices.
    const byFingerprint = new Map<string, Signal[]>();
    for (const s of fresh) byFingerprint.set(fingerprint(s), [...(byFingerprint.get(fingerprint(s)) ?? []), s]);
    for (const [fp, group] of byFingerprint) {
      const total = group.reduce((sum, s) => sum + s.total, 0);
      const stateSignal = group.some((s) => s.state);
      if (!stateSignal && total < watcher.minCount) continue;
      const newest = Math.max(...group.flatMap((s) => s.occurrences.map((o) => o.at)), stateSignal ? now : 0);
      const first = group[0]!;
      const incidentId = incidentIdOf(watcher.app, watcher.environment, fp);
      const ids = group.flatMap((s) => s.occurrences.map((o) => o.id ?? String(o.at))).sort().join(",");
      await ports.report({
        incidentId,
        commandId: `sig_${incidentId}_${newest}_${total}_${ids.length > 200 ? ids.slice(0, 200) : ids}`.slice(0, 400),
        app: watcher.app,
        environment: watcher.environment,
        watcher: watcher.id,
        source,
        fingerprint: fp,
        title: first.title,
        severity: first.severity,
        at: newest,
        count: Math.max(1, total),
        firstAt: Math.min(newest, ...group.flatMap((s) => s.occurrences.map((o) => o.at))),
        ...(first.sample ? { sample: first.sample } : {}),
        ...(first.query ? { query: first.query } : {}),
      });
      reported += 1;
    }
    for (const gap of gaps.filter((g) => g.source === source)) await ports.recordGap(watcher.id, gap);
    if (checkpoint !== undefined) {
      const keep = pruneSeen(seen, now - SEEN_KEEP_MS);
      await ports.atomically((db) => {
        db.prepare("INSERT INTO checkpoints (watcher, source, at, seen) VALUES (?, ?, ?, ?) ON CONFLICT (watcher, source) DO UPDATE SET at = excluded.at, seen = excluded.seen").run(
          watcher.id,
          source,
          checkpoint!,
          JSON.stringify(keep),
        );
        const insert = db.prepare("INSERT INTO coverage (watcher, source, from_at, to_at, status, note, run_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
        for (const w of covered) insert.run(watcher.id, w.source, w.from, w.to, w.status, w.note ?? null, now);
        for (const gap of gaps.filter((g) => g.source === source)) insert.run(watcher.id, source, gap.from, gap.to, "gap", gap.reason, now);
      });
    } else if (covered.length) {
      await ports.atomically((db) => {
        const insert = db.prepare("INSERT INTO coverage (watcher, source, from_at, to_at, status, note, run_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
        for (const w of covered) insert.run(watcher.id, w.source, w.from, w.to, w.status, w.note ?? null, now);
      });
    }
    windows.push(...covered);
  }
  return { watcher: watcher.id, startedAt: now, reported, windows, gaps, failed };
}
