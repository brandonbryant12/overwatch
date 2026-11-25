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
