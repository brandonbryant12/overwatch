import { fingerprint, shortHash, type Signal } from "./signals.ts";

export interface Incident {
  readonly id: string;
  readonly watcherId: string;
  readonly fingerprint: string;
  readonly source: string;
  readonly kind: string;
  readonly title: string;
  readonly severity: Signal["severity"];
  readonly status: "open" | "resolved";
  readonly openedAt: number;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly count: number;
  readonly cleanRuns: number;
  readonly resolvedAt?: number;
  readonly sample?: string;
  readonly query?: string;
  readonly url?: string;
  readonly investigationId?: string;
}

export type IncidentAction =
  | { readonly type: "open"; readonly incident: Incident }
  | {
      readonly type: "update";
      readonly id: string;
      readonly lastAt: number;
      readonly add: number;
      readonly sample?: string;
    }
  | { readonly type: "clean"; readonly id: string; readonly cleanRuns: number }
  | { readonly type: "resolve"; readonly id: string; readonly at: number };

/** One breach, one incident: the ID derives from the watcher, the signal group and when the breach started. */
export function incidentId(watcherId: string, fp: string, firstAt: number): string {
  return `inc_${shortHash(`${watcherId}\n${fp}\n${firstAt}`)}`;
}

/**
 * Decides what one run does to a watcher's incidents. Pure.
 *
 * - A fresh signal owned by an open incident updates it; it never opens a second one.
 * - A fresh signal with no open incident opens one, if it reached `minCount` (state signals always do).
 * - An open incident with no fresh signal gets a clean run, and resolves after `resolveAfter` of them.
 * - Anything whose state is unknown this run (its source failed, its metric is pending) gets neither.
 */
export function planIncidents(input: {
  readonly watcherId: string;
  readonly open: ReadonlyArray<Incident>;
  readonly signals: ReadonlyArray<Signal>;
  /** Sources that failed this run. Their incidents are frozen. */
  readonly failedSources: ReadonlySet<string>;
  /** Fingerprints that are neither confirmed bad nor confirmed clear this run. */
  readonly pending: ReadonlySet<string>;
  readonly minCount: number;
  readonly resolveAfter: number;
  readonly now: number;
}): IncidentAction[] {
  const actions: IncidentAction[] = [];
  const open = input.open.filter((incident) => incident.status === "open");
  const touched = new Set<string>();

  for (const signal of input.signals) {
    const fp = fingerprint(signal);
    const owner = open.find((incident) => incident.fingerprint === fp);
    const lastAt = signal.occurrences.length ? Math.max(...signal.occurrences.map((o) => o.at)) : input.now;
    if (owner) {
      if (touched.has(owner.id)) continue;
      touched.add(owner.id);
      actions.push({
        type: "update",
        id: owner.id,
        lastAt: Math.max(owner.lastAt, lastAt),
        add: signal.state ? 0 : signal.total,
        ...(signal.sample ? { sample: signal.sample } : {}),
      });
      continue;
    }
    if (!signal.state && signal.total < input.minCount) continue;
    const firstAt = signal.occurrences.length ? Math.min(...signal.occurrences.map((o) => o.at)) : input.now;
    const id = incidentId(input.watcherId, fp, firstAt);
    if (actions.some((a) => a.type === "open" && a.incident.id === id)) continue;
    actions.push({
      type: "open",
      incident: {
        id,
        watcherId: input.watcherId,
        fingerprint: fp,
        source: signal.source,
        kind: signal.kind,
        title: signal.title,
        severity: signal.severity,
        status: "open",
        openedAt: input.now,
        firstAt,
        lastAt,
        count: signal.total,
        cleanRuns: 0,
        ...(signal.sample ? { sample: signal.sample } : {}),
        ...(signal.query ? { query: signal.query } : {}),
        ...(signal.url ? { url: signal.url } : {}),
      },
    });
  }

  for (const incident of open) {
    if (touched.has(incident.id)) continue;
    if (input.failedSources.has(incident.source) || input.pending.has(incident.fingerprint)) continue;
    const cleanRuns = incident.cleanRuns + 1;
    actions.push(
      cleanRuns >= input.resolveAfter
        ? { type: "resolve", id: incident.id, at: input.now }
        : { type: "clean", id: incident.id, cleanRuns },
    );
  }
  return actions;
}

export function applyIncidentAction(incident: Incident, action: IncidentAction): Incident {
  switch (action.type) {
    case "open":
      return action.incident;
    case "update":
      return {
        ...incident,
        lastAt: action.lastAt,
        count: incident.count + action.add,
        cleanRuns: 0,
        ...(action.sample ? { sample: action.sample } : {}),
      };
    case "clean":
      return { ...incident, cleanRuns: action.cleanRuns };
    case "resolve":
      return { ...incident, status: "resolved", resolvedAt: action.at, cleanRuns: incident.cleanRuns + 1 };
  }
}
