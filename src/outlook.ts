/**
 * Looking ahead, from stored observations only. Time left: a forecast of when used capacity reaches its configured
 * ceiling, only when six fresh, distinct, consistent provider samples support it; otherwise none, with the reason.
 * Staging against production: after a staging release, two aligned fully measured intervals on both sides; a new
 * staging-only problem seen in both is a regression signal. Neither has any authority over a release.
 */
import type { Config, Source } from "./config.ts";
import { clock } from "./clock.ts";
import { afterChange, announce, groupNow } from "./inbox.ts";
import { json, type Clean, type Store, type Writer } from "./store.ts";
import { sha, type ProviderTime } from "./parse.ts";

const DAY_MS = 86_400_000;

export interface Forecast {
  source: string;
  resource: string;
  unit: string;
  limit: number;
  state: "forecast" | "unknown" | "reached" | "outside_horizon";
  reason: string | null;
  asOfMs: number | null;
  samples: number;
  etaMinutes: number | null;
  /** Used units per minute (the median pairwise slope), and the polling interval the samples are spaced by. */
  ratePerMinute: number | null;
  intervalMs: number;
}

/**
 * Time left for one capacity source. The series is the run of measured samples since the latest gap, ceiling change
 * or decrease (a reset), one per distinct provider time. Six of them, at least five polling intervals end to end,
 * each step positive and at most two intervals, the newest at most one interval old; every increment within 25% of
 * what the median of the 15 pairwise slopes predicts. ETA = (limit − latest) / slope, rounded up to whole minutes.
 */
export function forecast(source: Source, rows: ReadonlyArray<{ series: string; at_ms: ProviderTime; value: number | null }>, now: number): Forecast {
  const cap = source.capacity!, every = source.everyMs;
  const series = sha(source.metric, cap.resource, cap.unit, cap.limit);
  const base = { source: source.id, resource: cap.resource, unit: cap.unit, limit: cap.limit, intervalMs: every };
  const run: Array<{ at: number; value: number }> = [];
  let why: string | null = null;
  let unit: string | null = null;
  for (const r of rows) {
    // Samples combine only when they carry the same metric, ceiling and provider unit.
    const [hash, provider = ""] = r.series.split(":");
    if (hash !== series || provider !== unit) { run.length = 0; why = hash !== series ? "the metric or its ceiling changed; history starts again" : "the provider's unit changed; samples in different units do not combine"; unit = provider; if (hash !== series) continue; }
    if (r.value === null || !Number.isFinite(r.value) || r.value < 0) { run.length = 0; why = "a reading was not measured; the series starts again after it"; continue; }
    const last = run.at(-1);
    if (last && r.at_ms <= last.at) continue; // the same provider point returned again is not a new sample
    if (last && r.value < last.value) { run.length = 0; why = "usage went down (a reset or cleanup); the series starts again"; }
    run.push({ at: r.at_ms, value: r.value });
  }
  const latestRaw = rows.at(-1);
  // The samples' unit must be the configured limit's: none for a count of units, "byte" for bytes. No ETA otherwise.
  if (latestRaw && unit !== (cap.unit === "bytes" ? "byte" : "")) return { ...base, state: "unknown", reason: `the provider reports ${unit || "no unit"}, not the limit's ${cap.unit}; no time can be computed`, asOfMs: null, samples: 0, etaMinutes: null, ratePerMinute: null };
  const points = run.slice(-6);
  const none = (reason: string, state: Forecast["state"] = "unknown"): Forecast => ({ ...base, state, reason, asOfMs: points.at(-1)?.at ?? null, samples: points.length, etaMinutes: null, ratePerMinute: null });
  if (latestRaw && latestRaw.value === null) return none("the latest reading was not measured");
  const latest = points.at(-1);
  if (latest && latest.value >= cap.limit) return none(`the limit of ${cap.limit} ${cap.unit} is reached`, "reached");
  if (points.length < 6) return none(`${points.length} of the six measured readings needed${why && points.length ? ` (${why})` : ""}`);
  if (now - latest!.at > every) return none("the newest reading is older than one polling interval");
  if (latest!.at - points[0]!.at < 5 * every) return none("the readings span less than five polling intervals");
  const steps = points.slice(1).map((p, i) => ({ dt: p.at - points[i]!.at, dv: p.value - points[i]!.value }));
  if (steps.some((s) => s.dt <= 0 || s.dt > 2 * every)) return none("the readings are not evenly spaced");
  if (steps.some((s) => s.dv <= 0)) return none("usage did not rise at every reading");
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) slopes.push((points[j]!.value - points[i]!.value) / (points[j]!.at - points[i]!.at));
  slopes.sort((a, b) => a - b);
  const slope = (slopes[7]! + slopes[7]!) / 2; // 15 slopes: the 8th is the median
  if (!(slope > 0)) return none("usage is flat");
  if (steps.some((s) => Math.abs(s.dv - slope * s.dt) > 0.25 * slope * s.dt)) return none("usage rose unevenly; the rate cannot support a time");
  const etaMs = (cap.limit - latest!.value) / slope;
  if (!Number.isFinite(etaMs)) return none("usage is flat");
  const ratePerMinute = slope * 60_000;
  if (etaMs > DAY_MS) return { ...none("more than 24 hours at this rate", "outside_horizon"), ratePerMinute };
  return { ...base, state: "forecast", reason: null, asOfMs: latest!.at, samples: points.length, etaMinutes: Math.ceil(etaMs / 60_000), ratePerMinute };
}

export function forecasts(store: Store, config: Config): Forecast[] {
  return config.sources.filter((s) => s.capacity).map((s) =>
    forecast(s, store.all<{ series: string; at_ms: ProviderTime; value: number | null }>("SELECT series, at_ms, value FROM samples WHERE source = ? ORDER BY id", s.id), clock.now()));
}

interface Data { prodSeq?: number; baseline: string[]; marks: Record<string, number>; counts: Array<Record<string, Record<string, number>>> }
type Row = { id: string; app: string; staging_revision: string; production_revision: string | null; start_seq: number; state: string; data: string };

/** Counts by problem title in one environment: titles are the normalized fingerprints both sides share. */
const tally = (store: Store, app: string, env: string) =>
  Object.fromEntries(store.all<{ title: string; n: number }>("SELECT title, sum(count) AS n FROM incidents WHERE app = ? AND environment = ? AND reading <> 'comparison' GROUP BY title", app, env).map((r) => [r.title, r.n]));

/**
 * One step of each app's comparison, after a collection pass. A staging revision change (not the first observation)
 * starts a comparison against production's revision then; each pass where every source of both environments has a
 * new result is one interval. Both must be ordinary and fully measured, with no other rollout, or it is unknown.
 */
export function compare(store: Store, config: Config) {
  for (const [app, a] of Object.entries(config.apps)) {
    if (!a.promotion) continue;
    const { staging, production } = a.promotion;
    const deploy = (env: string) => store.get<{ seq: number; revision: string; previous: string | null }>("SELECT * FROM deploys WHERE app = ? AND environment = ? ORDER BY seq DESC LIMIT 1", app, env);
    const st = deploy(staging), pr = deploy(production);
    if (!st || st.previous === null) continue; // the first observation is a baseline only
    const current = store.get<Row>("SELECT * FROM comparisons WHERE app = ? ORDER BY start_seq DESC LIMIT 1", app);
    const sources = config.sources.filter((s) => s.app === app && (s.environment === staging || s.environment === production));
    const latest = (s: Source) => store.get<{ seq: number; kind: string; data: string }>("SELECT seq, kind, data FROM events WHERE subject = ? AND kind IN ('slice','source_failed') ORDER BY seq DESC LIMIT 1", s.id);
    if (!current || current.staging_revision !== st.revision) {
      const same = pr?.revision === st.revision;
      const data: Data = { prodSeq: pr?.seq ?? 0, baseline: [...new Set([...Object.keys(tally(store, app, staging)), ...Object.keys(tally(store, app, production))])], marks: Object.fromEntries(sources.map((s) => [s.id, latest(s)?.seq ?? 0])), counts: [{ staging: tally(store, app, staging), production: tally(store, app, production) }] };
      store.tx((w) => {
        const id = `cmp_${sha(app, st.revision, st.seq).slice(0, 24)}`;
        w.run("INSERT OR IGNORE INTO comparisons (id, app, staging_revision, production_revision, start_seq, state, reason, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id as Clean, app as Clean, st.revision as Clean, (pr?.revision ?? null) as Clean | null, st.seq, (same ? "same_release" : "pending") as Clean, (same ? "staging runs the production revision" : "waiting for two aligned intervals") as Clean, json(data));
        w.event("comparison", `env:${app}/${staging}` as Clean, { id, state: same ? "same_release" : "pending", stagingRevision: st.revision, productionRevision: pr?.revision ?? null });
      });
      continue;
    }
    // A newer production rollout invalidates any comparison made against the old one, finished or not.
    // Any newer production observation re-decides it, a finished match as well as a regression.
    const seen = (JSON.parse(current.data) as Data).prodSeq ?? pr?.seq ?? 0;
    if (pr && pr.seq > seen && (pr.revision !== current.production_revision || current.state === "same_release")) {
      const same = pr.revision === current.staging_revision;
      store.tx((w) => {
        w.run("UPDATE comparisons SET state = ?, reason = ?, data = json_set(data, '$.prodSeq', ?) WHERE id = ?", (same ? "same_release" : "unknown") as Clean, (same ? "production now runs the staging revision" : `production rolled out ${pr.revision.slice(0, 12)} since; this comparison no longer describes it`) as Clean, pr.seq, current.id as Clean);
        w.event("comparison", `env:${app}/${staging}` as Clean, { id: current.id, state: same ? "same_release" : "unknown", productionRevision: pr.revision });
      });
      continue;
    }
    if (current.state !== "pending") continue;
    const data = JSON.parse(current.data) as Data;
    const now = sources.map((s) => ({ s, e: latest(s) }));
    if (now.some(({ s, e }) => !e || e.seq <= (data.marks[s.id] ?? 0))) continue; // the interval is not complete yet
    const n = data.counts.length;
    const unmeasured = now.find(({ s, e }) => {
      if (e!.kind !== "slice") return true;
      const d = JSON.parse(e!.data) as { ordinary?: boolean; readings?: Record<string, { state: string }> };
      return !d.ordinary || s.readings.some((r) => d.readings?.[r] && d.readings[r]!.state !== "ok");
    });
    // Aligned: every source's interval ends at the same provider time (within a second), or the two are not comparable.
    const ends = now.map(({ e }) => (e!.kind === "slice" ? (JSON.parse(e!.data) as { to: number }).to : 0));
    const moved = (pr && pr.revision !== current.production_revision) ? "production rolled out another revision" : null;
    const finish = (w: Writer, state: string, reason: string | null, sc: number | null, pc: number | null, incident: string | null = null) => {
      w.run("UPDATE comparisons SET state = ?, reason = ?, staging_count = ?, production_count = ?, data = ?, incident = ? WHERE id = ?", state as Clean, reason as Clean | null, sc, pc, json(data), incident as Clean | null, current.id as Clean);
      w.event("comparison", `env:${app}/${staging}` as Clean, { id: current.id, state, reason, stagingCount: sc, productionCount: pc });
    };
    if (!unmeasured && !moved && Math.max(...ends) - Math.min(...ends) > 1000) {
      store.tx((w) => finish(w, "unknown", `staging and production intervals are not aligned (their ends differ by ${Math.round((Math.max(...ends) - Math.min(...ends)) / 1000)} s); they cannot be compared`, null, null));
      continue;
    }
    if (unmeasured || moved) {
      const side = unmeasured?.s.environment === production ? `production (${production})` : `staging (${staging})`;
      store.tx((w) => finish(w, "unknown", moved ?? `${side} was not fully measured in interval ${n}: ${unmeasured!.s.name} ${unmeasured!.e!.kind === "slice" ? "had a gap or catch-up" : "failed"}`, null, null));
      continue;
    }
    data.counts.push({ staging: tally(store, app, staging), production: tally(store, app, production) });
    data.marks = Object.fromEntries(now.map(({ s, e }) => [s.id, e!.seq]));
    if (data.counts.length < 3) {
      store.tx((w) => w.run("UPDATE comparisons SET data = ? WHERE id = ?", json(data), current.id as Clean));
      continue;
    }
    const [c0, c1, c2] = data.counts as [Data["counts"][0], Data["counts"][0], Data["counts"][0]];
    const delta = (side: "staging" | "production", t: string, a: Record<string, Record<string, number>>, b: Record<string, Record<string, number>>) => (b[side]![t] ?? 0) - (a[side]![t] ?? 0);
    const signals = Object.keys(c2.staging!).filter((t) => !data.baseline.includes(t))
      .map((t) => ({ t, first: delta("staging", t, c0, c1), second: delta("staging", t, c1, c2), prod: delta("production", t, c0, c2) }))
      .filter((x) => x.first > 0 && x.second > 0 && x.first + x.second >= 3 && x.prod === 0)
      .sort((x, y) => y.first + y.second - (x.first + x.second));
    store.tx((w) => {
      const top = signals[0];
      if (!top) return finish(w, "no_signal", "no new staging-only problem in two compared intervals (low traffic cannot certify a release)", null, null);
      const id = `inc_${sha(app, staging, "comparison", current.staging_revision, top.t).slice(0, 32)}`, seq = w.next();
      const title = `New in ${staging} since ${current.staging_revision.slice(0, 12)}: ${top.t} (production ${(current.production_revision ?? "unknown").slice(0, 12)} unchanged)`;
      const before = groupNow(store, id);
      w.event("comparison", id as Clean, { id: current.id, regression: top.t });
      w.run(`INSERT OR IGNORE INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, reading, active, streak, first_seq)
        VALUES (?, ?, ?, ?, ?, 'warn', ?, 1, ?, ?, ?, 'comparison', 1, 0, ?)`, id as Clean, app as Clean, staging as Clean, `${app}/${staging}/comparison` as Clean, title as Clean, top.first + top.second, clock.now(), clock.now(), seq, seq);
      afterChange(w, store, id, undefined, top.first + top.second, seq);
      announce(w, store, id, before, seq);
      finish(w, "regression", `${top.t}: ${top.first + top.second} in staging over two intervals, none in production`, top.first + top.second, 0, id);
    });
  }
}

export function comparisons(store: Store, config: Config) {
  return store.all<Row & { reason: string | null; staging_count: number | null; production_count: number | null; incident: string | null }>(
    "SELECT * FROM comparisons c WHERE start_seq = (SELECT max(start_seq) FROM comparisons WHERE app = c.app) ORDER BY app")
    .map((c) => ({ app: c.app, staging: config.apps[c.app]?.promotion?.staging ?? null, production: config.apps[c.app]?.promotion?.production ?? null, stagingRevision: c.staging_revision, productionRevision: c.production_revision, state: c.state === "pending" ? "unknown" : c.state, reason: c.state === "pending" ? "waiting for two aligned fully measured intervals" : c.reason, stagingCount: c.staging_count, productionCount: c.production_count, incident: c.incident, sinceSeq: c.start_seq }));
}
