export type WakeTier = "short_nap" | "overnight" | "extended_offline";

export interface WakeEvent {
  readonly sleptAtMs: number;
  readonly wokeAtMs: number;
  readonly gapMs: number;
  readonly tier: WakeTier;
}

export function classifyWakeTier(gapMs: number): WakeTier {
  if (gapMs <= 15 * 60_000) return "short_nap";
  if (gapMs <= 72 * 60 * 60_000) return "overnight";
  return "extended_offline";
}

/**
 * Sleep-native host lifecycle monitor.
 * Compares wall-clock (`Date.now()`) against monotonic uptime (`performance.now()`) every 5s.
 * Any drift > 15s indicates laptop sleep, firing a single coalesced wake sweep after a
 * brief network-settle barrier. On always-on headless servers, drift stays ~0 and never triggers.
 */
export class WakeCoordinator {
  private lastWallMs = Date.now();
  private lastMonoMs = performance.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private waking = false;

  constructor(
    private readonly onWake: (event: WakeEvent) => Promise<void> | void,
    private readonly options: {
      readonly pollMs?: number;
      readonly jumpThresholdMs?: number;
      readonly settleBarrierMs?: number;
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const pollMs = this.options.pollMs ?? 5_000;
    this.lastWallMs = Date.now();
    this.lastMonoMs = performance.now();
    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
    if (typeof (this.timer as any).unref === "function") {
      (this.timer as any).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Exposed for deterministic tests and manual wake simulation.
   */
  async tick(nowWallMs = Date.now(), nowMonoMs = performance.now()): Promise<WakeEvent | undefined> {
    const wallDelta = nowWallMs - this.lastWallMs;
    const monoDelta = nowMonoMs - this.lastMonoMs;
    const jumpMs = wallDelta - monoDelta;
    const prevWall = this.lastWallMs;
    this.lastWallMs = nowWallMs;
    this.lastMonoMs = nowMonoMs;

    const threshold = this.options.jumpThresholdMs ?? 15_000;
    if (jumpMs > threshold && !this.waking) {
      this.waking = true;
      try {
        const settleMs = this.options.settleBarrierMs ?? 1_500;
        if (settleMs > 0) {
          await new Promise((r) => setTimeout(r, settleMs));
        }
        const event: WakeEvent = {
          sleptAtMs: prevWall,
          wokeAtMs: nowWallMs,
          gapMs: Math.round(jumpMs),
          tier: classifyWakeTier(jumpMs),
        };
        await this.onWake(event);
        return event;
      } finally {
        this.waking = false;
      }
    }
    return undefined;
  }
}

/**
 * Bounded idle-sleep prevention during critical local verification (`caffeinate -i -t 300` on macOS,
 * pure NoOp on headless Linux servers).
 */
export async function withHostPowerLease<T>(
  seconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "darwin" || process.env.OVERWATCH_HEADLESS === "1") {
    return fn();
  }
  const bounded = Math.max(5, Math.min(300, Math.round(seconds)));
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn(["caffeinate", "-i", "-t", String(bounded)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return await fn();
  } finally {
    try {
      proc?.kill();
    } catch {
      // ignore already-exited caffeinate
    }
  }
}
