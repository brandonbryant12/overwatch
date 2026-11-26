/**
 * How fresh the page's picture is, by its own clocks. `last` is when the page last heard the service (a snapshot, a
 * change or a heartbeat), sampled locally as { wallMs, monoMs }; `now` is sampled the same way. Either clock can age
 * it: a wall clock set back cannot keep it live, and neither can a monotonic clock that stopped during sleep.
 *
 * @param {{ wallMs: number, monoMs: number } | null} last
 * @param {{ wallMs: number, monoMs: number }} now
 * @returns {"unknown" | "live" | "stale" | "down"}
 */
export function freshness(last, now) {
  if (!last) return "unknown";
  const age = Math.max(0, now.wallMs - last.wallMs, now.monoMs - last.monoMs);
  return age >= 30_000 ? "down" : age >= 15_000 ? "stale" : "live";
}

/** Milliseconds since the page last heard the service, by the older-looking clock. */
export function silence(last, now) {
  return last ? Math.max(0, now.wallMs - last.wallMs, now.monoMs - last.monoMs) : Infinity;
}
