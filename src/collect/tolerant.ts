/**
 * Reading other systems' JSON without trusting its shape.
 *
 * `kubectl` and the Datadog API answer with whatever the cluster version, an admission webhook, a proxy or an
 * outage makes of the request. A missing list, a number where a string was, or a field spelled in another case
 * must cost one field, never the whole collection: a parser that throws fails the slice, and a slice that fails
 * the same way every time never lets its checkpoint move.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value as an object; anything else is an empty object. */
export const rec = (value: unknown): Record<string, any> => (isRecord(value) ? value : {});

/** The value as a list; a single object is a list of one; anything else is empty. */
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : isRecord(value) ? [value] : []);

/** The value as a list of objects, dropping entries that are not objects. */
export const records = (value: unknown): Array<Record<string, any>> => list(value).filter(isRecord);

/** A string from a string, number or boolean; objects become compact JSON; nothing becomes `fallback`. */
export function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

/** A finite number from a number or a numeric string. */
export function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Milliseconds since the epoch from an ISO string or an epoch in seconds, milliseconds or nanoseconds. NaN if neither. */
export function time(value: unknown): number {
  if (typeof value === "string" && value.trim() !== "" && !/^\d+(\.\d+)?$/.test(value.trim())) return Date.parse(value);
  const n = num(value);
  if (n === undefined || n <= 0) return Number.NaN;
  if (n < 1e11) return Math.round(n * 1000);
  if (n < 1e14) return Math.round(n);
  if (n < 1e17) return Math.round(n / 1000);
  return Math.round(n / 1e6);
}

const fold = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The first of `names` the object has. Exact names win; otherwise names match whatever their case or separators
 * (`lastTimestamp`, `last_timestamp`, `LastTimestamp`). Null and undefined count as absent.
 */
export function pick(value: unknown, ...names: ReadonlyArray<string>): unknown {
  if (!isRecord(value)) return undefined;
  for (const name of names) if (value[name] !== undefined && value[name] !== null) return value[name];
  const folded = new Map<string, unknown>();
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null && !folded.has(fold(key))) folded.set(fold(key), entry);
  }
  for (const name of names) {
    const entry = folded.get(fold(name));
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/**
 * Parses JSON that may carry a byte-order mark or stray lines around it (a warning printed before the document,
 * a proxy banner after). Throws an error that says what was asked for and what came back instead.
 */
export function parseJson(input: string, what: string): unknown {
  const body = input.replace(/^﻿/, "").trim();
  if (!body) throw new Error(`${what} returned nothing`);
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[{[]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        // Fall through to the error below.
      }
    }
    const looksCut = /^[{[]/.test(body) && !/[}\]]$/.test(body);
    throw new Error(
      `${what} did not return JSON (${body.length} characters${looksCut ? ", cut off before the end" : ""}, starting ${JSON.stringify(body.slice(0, 60))})`,
    );
  }
}

/** The objects of a Kubernetes list (`{ items: [...] }`), a bare array, or a single object. */
export function items(value: unknown): Array<Record<string, any>> {
  if (Array.isArray(value)) return records(value);
  const inner = pick(value, "items");
  if (inner !== undefined) return records(inner);
  return isRecord(value) && (value.metadata !== undefined || value.kind !== undefined) && !/List$/.test(text(value.kind)) ? [value] : [];
}
