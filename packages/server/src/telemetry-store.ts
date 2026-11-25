import type { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import type { ConnectorCoverage, EvidenceId } from "@overwatch/domain";
import {
  redactText,
  redactValue,
  type BuildRecord,
  type EnvironmentTelemetrySnapshot,
  type EvidenceBlob,
  type K8sWarningEvent,
  type MetricPoint,
  type PodSnapshot,
  type RouteCohort,
  type TraceDiffPayload,
} from "@overwatch/connectors";

/**
 * Plane 1: Operational Telemetry Store inside `overwatch.sqlite` (WAL).
 * Holds high-frequency mutable pod snapshots, metric rings, connector health,
 * exploration frontier coverage, and immutable content-addressed `evidence_blobs`.
 */
export class TelemetryStore {
  constructor(private readonly db: Database) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connector_health (
        env_key TEXT NOT NULL,
        connector TEXT NOT NULL,
        coverage TEXT NOT NULL,
        detail TEXT NOT NULL,
        remediation TEXT,
        checkpoint_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (env_key, connector)
      );

      CREATE TABLE IF NOT EXISTS resource_snapshots (
        env_key TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        env_id TEXT NOT NULL,
        coverage TEXT NOT NULL,
        coverage_detail TEXT NOT NULL,
        remediation TEXT,
        pods_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        builds_json TEXT NOT NULL,
        routes_json TEXT NOT NULL,
        sampled_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metric_ring (
        env_key TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        p50_ms REAL NOT NULL,
        p95_ms REAL NOT NULL,
        err_pct REAL NOT NULL,
        cpu_pct REAL NOT NULL,
        mem_pct REAL NOT NULL,
        rps REAL NOT NULL,
        PRIMARY KEY (env_key, ts_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_metric_ring_env_ts ON metric_ring (env_key, ts_ms DESC);

      CREATE TABLE IF NOT EXISTS exploration_frontier (
        env_key TEXT NOT NULL,
        route TEXT NOT NULL,
        mode TEXT NOT NULL,
        last_explored_ms INTEGER NOT NULL,
        priority_score REAL NOT NULL,
        last_outcome TEXT NOT NULL,
        PRIMARY KEY (env_key, route, mode)
      );

      CREATE TABLE IF NOT EXISTS evidence_blobs (
        evidence_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        env_key TEXT NOT NULL,
        title TEXT NOT NULL,
        query TEXT NOT NULL,
        deep_link TEXT NOT NULL,
        captured_at_ms INTEGER NOT NULL,
        excerpt TEXT NOT NULL,
        trace_diff_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_env ON evidence_blobs (env_key, captured_at_ms DESC);
    `);
  }

  saveEnvironmentSnapshot(snap: EnvironmentTelemetrySnapshot): void {
    this.db
      .prepare(
        `INSERT INTO resource_snapshots
          (env_key, app_id, env_id, coverage, coverage_detail, remediation, pods_json, warnings_json, builds_json, routes_json, sampled_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(env_key) DO UPDATE SET
           coverage = excluded.coverage,
           coverage_detail = excluded.coverage_detail,
           remediation = excluded.remediation,
           pods_json = excluded.pods_json,
           warnings_json = excluded.warnings_json,
           builds_json = excluded.builds_json,
           routes_json = excluded.routes_json,
           sampled_at_ms = excluded.sampled_at_ms`,
      )
      .run(
        snap.envKey,
        snap.appId,
        snap.envId,
        snap.coverage,
        redactText(snap.coverageDetail, { maxBytes: 400 }),
        snap.remediation ?? null,
        JSON.stringify(redactValue(snap.pods)),
        JSON.stringify(redactValue(snap.warningEvents)),
        JSON.stringify(redactValue(snap.builds)),
        JSON.stringify(redactValue(snap.routeCohorts)),
        snap.sampledAtMs,
      );

    const metricStmt = this.db.prepare(
      `INSERT INTO metric_ring (env_key, ts_ms, p50_ms, p95_ms, err_pct, cpu_pct, mem_pct, rps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(env_key, ts_ms) DO UPDATE SET
         p50_ms = excluded.p50_ms,
         p95_ms = excluded.p95_ms,
         err_pct = excluded.err_pct,
         cpu_pct = excluded.cpu_pct,
         mem_pct = excluded.mem_pct,
         rps = excluded.rps`,
    );
    for (const m of snap.metrics) {
      metricStmt.run(
        snap.envKey,
        m.tsMs,
        m.p50LatencyMs,
        m.p95LatencyMs,
        m.errorRatePct,
        m.cpuPct,
        m.memoryPct,
        m.rps,
      );
    }

    // Ring buffer retention: keep latest 240 points per environment
    this.db
      .prepare(
        `DELETE FROM metric_ring
         WHERE env_key = ? AND ts_ms NOT IN (
           SELECT ts_ms FROM metric_ring WHERE env_key = ? ORDER BY ts_ms DESC LIMIT 240
         )`,
      )
      .run(snap.envKey, snap.envKey);

    // Update connector health checkpoints
    for (const conn of ["kubernetes", "datadog", "jenkins"] as const) {
      this.db
        .prepare(
          `INSERT INTO connector_health (env_key, connector, coverage, detail, remediation, checkpoint_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(env_key, connector) DO UPDATE SET
             coverage = excluded.coverage,
             detail = excluded.detail,
             remediation = excluded.remediation,
             checkpoint_ms = excluded.checkpoint_ms,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          snap.envKey,
          conn,
          snap.coverage,
          snap.coverageDetail,
          snap.remediation ?? null,
          snap.sampledAtMs,
          Date.now(),
        );
    }
  }

  getEnvironmentSnapshot(envKey: string): EnvironmentTelemetrySnapshot | undefined {
    const row = this.db
      .query<
        {
          env_key: string;
          app_id: string;
          env_id: string;
          coverage: ConnectorCoverage;
          coverage_detail: string;
          remediation: string | null;
          pods_json: string;
          warnings_json: string;
          builds_json: string;
          routes_json: string;
          sampled_at_ms: number;
        },
        [string]
      >("SELECT * FROM resource_snapshots WHERE env_key = ?")
      .get(envKey);
    if (!row) return undefined;

    const metrics = this.getMetricSeries(envKey, 60);
    return {
      envKey: row.env_key,
      appId: row.app_id,
      envId: row.env_id,
      coverage: row.coverage,
      coverageDetail: row.coverage_detail,
      remediation: row.remediation ?? undefined,
      pods: JSON.parse(row.pods_json) as PodSnapshot[],
      warningEvents: JSON.parse(row.warnings_json) as K8sWarningEvent[],
      builds: JSON.parse(row.builds_json) as BuildRecord[],
      routeCohorts: JSON.parse(row.routes_json) as RouteCohort[],
      metrics,
      sampledAtMs: row.sampled_at_ms,
    };
  }

  listEnvironmentSnapshots(): EnvironmentTelemetrySnapshot[] {
    const keys = this.db
      .query<{ env_key: string }, []>("SELECT env_key FROM resource_snapshots ORDER BY env_key ASC")
      .all();
    return keys
      .map((k) => this.getEnvironmentSnapshot(k.env_key))
      .filter((s): s is EnvironmentTelemetrySnapshot => s !== undefined);
  }

  getMetricSeries(envKey: string, limit = 60): MetricPoint[] {
    const rows = this.db
      .query<
        {
          ts_ms: number;
          p50_ms: number;
          p95_ms: number;
          err_pct: number;
          cpu_pct: number;
          mem_pct: number;
          rps: number;
        },
        [string, number]
      >(
        `SELECT ts_ms, p50_ms, p95_ms, err_pct, cpu_pct, mem_pct, rps
         FROM metric_ring WHERE env_key = ? ORDER BY ts_ms DESC LIMIT ?`,
      )
      .all(envKey, limit);
    return rows.reverse().map((r) => ({
      tsMs: r.ts_ms,
      p50LatencyMs: r.p50_ms,
      p95LatencyMs: r.p95_ms,
      errorRatePct: r.err_pct,
      cpuPct: r.cpu_pct,
      memoryPct: r.mem_pct,
      rps: r.rps,
    }));
  }

  putEvidence(blob: Omit<EvidenceBlob, "evidenceId"> & { readonly evidenceId?: EvidenceId }): EvidenceBlob {
    const scrubbedExcerpt = redactText(blob.excerpt, { maxBytes: 8192 });
    const scrubbedDiff = blob.traceDiff ? redactValue(blob.traceDiff) : undefined;
    const hash = crypto
      .createHash("sha256")
      .update(`${blob.source}:${blob.envKey}:${blob.query}:${scrubbedExcerpt}`)
      .digest("hex")
      .slice(0, 12);
    const evidenceId = blob.evidenceId ?? (`ev_${hash}` as EvidenceId);

    this.db
      .prepare(
        `INSERT INTO evidence_blobs
          (evidence_id, source, env_key, title, query, deep_link, captured_at_ms, excerpt, trace_diff_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(evidence_id) DO NOTHING`,
      )
      .run(
        evidenceId,
        blob.source,
        blob.envKey,
        redactText(blob.title, { maxBytes: 240 }),
        redactText(blob.query, { maxBytes: 512 }),
        blob.deepLink,
        blob.capturedAtMs,
        scrubbedExcerpt,
        scrubbedDiff ? JSON.stringify(scrubbedDiff) : null,
      );

    return {
      ...blob,
      evidenceId,
      excerpt: scrubbedExcerpt,
      traceDiff: scrubbedDiff,
    };
  }

  getEvidence(evidenceId: string): EvidenceBlob | undefined {
    const row = this.db
      .query<
        {
          evidence_id: string;
          source: EvidenceBlob["source"];
          env_key: string;
          title: string;
          query: string;
          deep_link: string;
          captured_at_ms: number;
          excerpt: string;
          trace_diff_json: string | null;
        },
        [string]
      >("SELECT * FROM evidence_blobs WHERE evidence_id = ?")
      .get(evidenceId);
    if (!row) return undefined;
    return {
      evidenceId: row.evidence_id as EvidenceId,
      source: row.source,
      envKey: row.env_key,
      title: row.title,
      query: row.query,
      deepLink: row.deep_link,
      capturedAtMs: row.captured_at_ms,
      excerpt: row.excerpt,
      traceDiff: row.trace_diff_json ? (JSON.parse(row.trace_diff_json) as TraceDiffPayload) : undefined,
    };
  }

  listEvidence(envKey?: string): EvidenceBlob[] {
    const rows = envKey
      ? this.db
          .query<any, [string]>(
            "SELECT * FROM evidence_blobs WHERE env_key = ? ORDER BY captured_at_ms DESC LIMIT 80",
          )
          .all(envKey)
      : this.db
          .query<any, []>(
            "SELECT * FROM evidence_blobs ORDER BY captured_at_ms DESC LIMIT 80",
          )
          .all();
    return rows.map((row) => ({
      evidenceId: row.evidence_id as EvidenceId,
      source: row.source,
      envKey: row.env_key,
      title: row.title,
      query: row.query,
      deepLink: row.deep_link,
      capturedAtMs: row.captured_at_ms,
      excerpt: row.excerpt,
      traceDiff: row.trace_diff_json ? (JSON.parse(row.trace_diff_json) as TraceDiffPayload) : undefined,
    }));
  }

  recordExploration(entry: {
    readonly envKey: string;
    readonly route: string;
    readonly mode: string;
    readonly priorityScore: number;
    readonly outcome: string;
    readonly atMs?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO exploration_frontier (env_key, route, mode, last_explored_ms, priority_score, last_outcome)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(env_key, route, mode) DO UPDATE SET
           last_explored_ms = excluded.last_explored_ms,
           priority_score = excluded.priority_score,
           last_outcome = excluded.last_outcome`,
      )
      .run(
        entry.envKey,
        entry.route,
        entry.mode,
        entry.atMs ?? Date.now(),
        entry.priorityScore,
        entry.outcome,
      );
  }

  listExplorationFrontier(): Array<{
    readonly envKey: string;
    readonly route: string;
    readonly mode: string;
    readonly lastExploredMs: number;
    readonly priorityScore: number;
    readonly lastOutcome: string;
  }> {
    return this.db
      .query<any, []>(
        "SELECT * FROM exploration_frontier ORDER BY priority_score DESC LIMIT 40",
      )
      .all()
      .map((r) => ({
        envKey: r.env_key,
        route: r.route,
        mode: r.mode,
        lastExploredMs: r.last_explored_ms,
        priorityScore: r.priority_score,
        lastOutcome: r.last_outcome,
      }));
  }
}
