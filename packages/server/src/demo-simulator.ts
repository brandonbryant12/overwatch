import type { MetricPoint } from "@overwatch/connectors";

type Levels = Omit<MetricPoint, "tsMs">;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

function levelsFrom(points: ReadonlyArray<MetricPoint>): Levels {
  const pick = (key: keyof Levels) => median(points.map((p) => p[key]));
  return {
    p50LatencyMs: pick("p50LatencyMs"),
    p95LatencyMs: pick("p95LatencyMs"),
    errorRatePct: pick("errorRatePct"),
    cpuPct: pick("cpuPct"),
    memoryPct: pick("memoryPct"),
    rps: pick("rps"),
  };
}

/**
 * Demo-mode telemetry source.
 *
 * Each environment has a healthy baseline and a current level. Samples are the current level plus
 * bounded noise, so a quiet demo stays quiet instead of drifting. Injecting a regression or a
 * recovery moves the level, and the real monitor loop reacts to it exactly as it would to
 * production telemetry. Nothing in here decides what an incident is.
 */
export class DemoSimulator {
  private readonly baseline = new Map<string, Levels>();
  private readonly current = new Map<string, Levels>();
  private tick = 0;

  /** Learns levels from stored history: early samples are "healthy", the latest are "now". */
  prime(envKey: string, history: ReadonlyArray<MetricPoint>): void {
    if (this.current.has(envKey) || history.length === 0) return;
    const head = history.slice(0, Math.max(1, Math.min(10, Math.floor(history.length / 2))));
    const tail = history.slice(-3);
    this.baseline.set(envKey, levelsFrom(head));
    this.current.set(envKey, levelsFrom(tail));
  }

  baselineOf(envKey: string): Readonly<Levels> | undefined {
    return this.baseline.get(envKey);
  }

  /** Simulates a bad deploy: latency and errors jump, CPU follows. */
  injectRegression(envKey: string, factor = 2.6): boolean {
    const base = this.baseline.get(envKey);
    if (!base) return false;
    this.current.set(envKey, {
      ...base,
      p50LatencyMs: base.p50LatencyMs * (1 + (factor - 1) * 0.35),
      p95LatencyMs: base.p95LatencyMs * factor,
      errorRatePct: Math.max(base.errorRatePct * 12, 1.6),
      cpuPct: Math.min(96, base.cpuPct + 22),
      memoryPct: Math.min(96, base.memoryPct + 6),
    });
    return true;
  }

  /** Simulates the fix reaching the environment: levels return to baseline. */
  recover(envKey: string): boolean {
    const base = this.baseline.get(envKey);
    if (!base) return false;
    this.current.set(envKey, { ...base });
    return true;
  }

  next(envKey: string, tsMs: number): MetricPoint | undefined {
    const level = this.current.get(envKey);
    if (!level) return undefined;
    this.tick += 1;
    // Deterministic, bounded (about +/-4%) and not cumulative.
    const noise = Math.sin(this.tick * 0.9 + envKey.length) * 0.03 + Math.cos(this.tick * 0.37) * 0.01;
    return {
      tsMs,
      p50LatencyMs: Math.max(1, Math.round(level.p50LatencyMs * (1 + noise))),
      p95LatencyMs: Math.max(1, Math.round(level.p95LatencyMs * (1 + noise))),
      errorRatePct: Number(Math.max(0.01, level.errorRatePct * (1 + noise)).toFixed(2)),
      cpuPct: Math.min(98, Math.max(1, Math.round(level.cpuPct * (1 + noise * 0.6)))),
      memoryPct: Math.min(98, Math.max(1, Math.round(level.memoryPct * (1 + noise * 0.3)))),
      rps: Math.max(1, Math.round(level.rps * (1 + noise))),
    };
  }
}
