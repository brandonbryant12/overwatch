/** Types for freshness.mjs, which stays plain JavaScript: the acceptance suite imports it as it is. */
export interface Clocks {
  readonly wallMs: number;
  readonly monoMs: number;
}
export function freshness(last: Clocks | null, now: Clocks): "unknown" | "live" | "stale" | "down";
export function silence(last: Clocks | null, now: Clocks): number;
