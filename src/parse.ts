/**
 * Values from outside (kubectl, Datadog, OpenCode), read tolerantly. Each reader returns the value when it is
 * clearly of the kind asked for and null otherwise: null is "not measured", so a missing or malformed value can never
 * become a measured zero, false or epoch.
 */
import { createHash } from "node:crypto";

/** JSON text as a value, or undefined when it is not JSON. */
export const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
/** A stable digest of values, for keys and identities. */
export const sha = (...parts: ReadonlyArray<unknown>) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A finite number, or a string that is exactly one. Finiteness is checked last, on the value itself, for every shape. */
export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * A measurement: measured with a finite value, or not measured. Built only here, so every consumer (hysteresis,
 * health, quiet streaks, rate baselines) receives one of the two and cannot mistake one for the other.
 */
export type Sample = { readonly measured: true; readonly value: number } | { readonly measured: false };
export const UNMEASURED: Sample = Object.freeze({ measured: false });
export const sample = (v: unknown): Sample => {
  const n = num(v);
  return n === null ? UNMEASURED : Object.freeze({ measured: true, value: n });
};

/** A non-negative whole number. */
export function count(v: unknown): number | null {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * A time the provider reported, in epoch milliseconds. Made only here: from provider data by `time`, or by `answered`
 * for a live read. A wall-clock number is not one, so it cannot be passed where a provider time belongs unseen.
 */
export type ProviderTime = number & { readonly providerTime: true };
/** A provider's time from an ISO string (or a number of milliseconds). */
export function time(v: unknown): ProviderTime | null {
  const at = typeof v === "number" ? v : typeof v === "string" && v ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? (at as ProviderTime) : null;
}
/** The one cast: a live read (pods, events, usage, logs up to now, monitors) observed when the provider answered it. */
export const answered = (ms: number) => ms as ProviderTime;
