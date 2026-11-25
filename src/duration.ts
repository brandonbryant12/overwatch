const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
};

/** Parses "90s", "15m", "24h", "14d" or "2 hours" into milliseconds. Numbers are taken as milliseconds. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(value);
  if (!match) return undefined;
  const name = match[2]!.toLowerCase();
  const unit = UNITS[name] ?? (name.endsWith("s") ? UNITS[name.slice(0, -1)] : undefined);
  const amount = Number(match[1]);
  if (unit === undefined || !(amount > 0)) return undefined;
  return Math.round(amount * unit);
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A point in time from what a person or an agent typed: a duration back from `now` ("6h"), an ISO 8601 time
 * ("2026-11-25T10:00:00Z", "2026-11-25") or an epoch in seconds or milliseconds. Anything else is `undefined`;
 * callers must say so rather than fall back to a default window nobody asked for.
 */
export function parseWhen(value: unknown, now: number): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 1e9 ? (value < 1e11 ? value * 1000 : value) : undefined;
  if (typeof value !== "string") return undefined;
  const input = value.trim();
  const relative = parseDuration(input);
  if (relative !== undefined) return now - relative;
  if (/^\d{10}(\d{3})?$/.test(input)) return input.length === 10 ? Number(input) * 1000 : Number(input);
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.test(input)) return undefined;
  const absolute = Date.parse(input.replace(" ", "T").replace(/\s+/g, ""));
  return Number.isFinite(absolute) ? absolute : undefined;
}

/**
 * The window an agent asked `overwatch_query` for. Defaults apply only to what was left out; a value that cannot
 * be read, or a window that is empty or in the future, is an error the agent sees and can correct.
 */
export function queryWindow(input: { readonly since?: unknown; readonly until?: unknown }, now: number, defaultMs = 3_600_000): { since: number; until: number } | { error: string } {
  const given = (value: unknown) => value !== undefined && value !== null && value !== "";
  const forms = 'an ISO time such as "2026-11-25T10:00:00Z" or a duration back from now such as "6h"';
  let until = now;
  if (given(input.until)) {
    const parsed = parseWhen(input.until, now);
    if (parsed === undefined) return { error: `until ${JSON.stringify(input.until)} is not a time. Use ${forms}.` };
    until = Math.min(parsed, now);
  }
  let since = until - defaultMs;
  if (given(input.since)) {
    const parsed = parseWhen(input.since, now);
    if (parsed === undefined) return { error: `since ${JSON.stringify(input.since)} is not a time. Use ${forms}.` };
    since = parsed;
  }
  if (since > now) return { error: `since ${iso(since)} is in the future; it is ${iso(now)} now.` };
  if (since >= until) return { error: `The window is empty: since ${iso(since)} is not before until ${iso(until)}.` };
  return { since, until };
}
