/**
 * Values from outside (kubectl, Datadog, OpenCode), read tolerantly. Each reader returns the value when it is
 * clearly of the kind asked for and null otherwise: null is "not measured", so a missing or malformed value can never
 * become a measured zero, false or epoch.
 */
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A finite number, or a string that is exactly one. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !/^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(v)) return null;
  return Number(v);
}

/** A non-negative whole number. */
export function count(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

/** A time as epoch milliseconds, from an ISO string (or a number of milliseconds). */
export function time(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? at : null;
}
