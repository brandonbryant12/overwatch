import { createHash } from "node:crypto";

/** One occurrence of a signal: a log line, an event, a failed run. */
export interface Occurrence {
  readonly at: number;
  readonly id?: string;
}

/**
 * A group of related occurrences from one source, such as one normalized error message.
 * Sources return signals; the watcher de-duplicates them against what it has already seen.
 */
export interface Signal {
  /** Source name in the environment config. */
  readonly source: string;
  /** Free-form kind, such as `log`, `event`, `monitor`, `ci`, `pod` or `metric`. Open to extension. */
  readonly kind: string;
  /** Stable grouping key within the source. */
  readonly key: string;
  readonly title: string;
  readonly severity: "info" | "warn" | "error";
  /**
   * Every occurrence in the window, never a capped sample: a signal's count is how many are listed (one per poll for a
   * `state` signal), and de-duplication judges each one. Only `sample` is for showing.
   */
  readonly occurrences: ReadonlyArray<Occurrence>;
  /** A redacted, quotable line. */
  readonly sample?: string;
  /** How to see the same thing again: a query or command. */
  readonly query?: string;
  readonly url?: string;
  /** An ongoing condition (an alerting monitor, a crash-looping pod). Not de-duplicated; it refreshes its incident. */
  readonly state?: boolean;
}

export interface Sample {
  readonly metric: string;
  readonly at: number;
  readonly value: number;
}

export interface SeenEntry {
  readonly lastAt: number;
  /** Occurrences within the overlap before `lastAt`, so late arrivals in the overlap still count once. */
  readonly recent: ReadonlyArray<{ readonly id: string; readonly at: number }>;
}

export type Seen = Readonly<Record<string, SeenEntry>>;

export const fingerprint = (signal: Pick<Signal, "source" | "key">) => `${signal.source}:${signal.key}`;

export function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/**
 * Drops occurrences already counted by an earlier run. Pure.
 *
 * Windows overlap by `overlapMs` so late-arriving data is not missed; this is what keeps the overlap from
 * counting anything twice. An occurrence is new when it is later than the last one seen for its group, or when
 * it falls inside the overlap and carries an ID not seen before.
 */
export function dedupe(
  signals: ReadonlyArray<Signal>,
  seen: Seen,
  overlapMs: number,
): { readonly fresh: ReadonlyArray<Signal>; readonly seen: Record<string, SeenEntry> } {
  const next: Record<string, SeenEntry> = { ...seen };
  const fresh: Signal[] = [];
  for (const signal of signals) {
    if (signal.state) {
      fresh.push(signal);
      continue;
    }
    const fp = fingerprint(signal);
    const prior = next[fp];
    const isNew = (o: Occurrence) =>
      !prior ||
      o.at > prior.lastAt ||
      (o.id !== undefined && o.at >= prior.lastAt - overlapMs && !prior.recent.some((r) => r.id === o.id));
    const kept = signal.occurrences.filter(isNew);
    if (kept.length === 0) continue;
    fresh.push({ ...signal, occurrences: kept });

    const lastAt = Math.max(prior?.lastAt ?? -Infinity, ...kept.map((o) => o.at));
    const recent = [
      ...(prior?.recent ?? []),
      ...kept.flatMap((o) => (o.id === undefined ? [] : [{ id: o.id, at: o.at }])),
    ].filter((r) => r.at >= lastAt - overlapMs);
    next[fp] = { lastAt, recent: recent.slice(-500) };
  }
  return { fresh, seen: next };
}

/** Forgets groups not seen since `before`, so the seen map stays bounded. */
export function pruneSeen(seen: Seen, before: number): Record<string, SeenEntry> {
  return Object.fromEntries(Object.entries(seen).filter(([, entry]) => entry.lastAt >= before));
}

/** Merges signals with the same fingerprint, as when a long gap is walked in several slices. */
export function mergeSignals(signals: ReadonlyArray<Signal>): Signal[] {
  const merged = new Map<string, Signal>();
  for (const signal of signals) {
    const fp = fingerprint(signal);
    const prior = merged.get(fp);
    if (!prior) {
      merged.set(fp, signal);
      continue;
    }
    merged.set(fp, {
      ...signal,
      occurrences: [...prior.occurrences, ...signal.occurrences],
      sample: signal.sample ?? prior.sample,
    });
  }
  return [...merged.values()];
}

/** Normalizes a log message into a grouping key: drops timestamps, IDs, numbers and quoted values. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.,]+(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(0x)?[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/"[^"]{0,200}"|'[^']{0,200}'/g, "<str>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
