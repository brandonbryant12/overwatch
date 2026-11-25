/**
 * What stops Overwatch working until the owner acts, one item per cause (plan 4.1). Pure: from the configuration, the
 * connections table and whether OpenCode is up.
 *
 * - A suspended connection is one cause, however many environments read through it.
 * - Every configured connection failing as unreachable at once (two or more) is one cause: offline or off the VPN.
 * - OpenCode not running while investigations wait is one cause, which pauses the whole queue.
 */
import type { Options } from "../collect/options.ts";
import { connectionOf, failureWords, type FailureKind } from "../collect/failures.ts";
import type { Cause } from "../domain/status.ts";
import type { ConnectionRow } from "./collector.ts";

const clock = (at: number) => new Date(at).toISOString().slice(11, 16) + " UTC";

/** The connection keys a watcher's source is read through: its connection, and the source itself. */
export function keysOf(options: Options, watcherId: string, source: string): string[] {
  const watcher = options.watchers.find((w) => w.id === watcherId);
  const config = watcher ? options.apps[watcher.app]?.environments[watcher.environment]?.sources[source] : undefined;
  if (!config) return [`source:${watcherId}/${source}`];
  return [connectionOf(config, { watcher: watcherId, source, ...(options.datadog ? { datadogSite: options.datadog.site } : {}) }), `source:${watcherId}/${source}`];
}

/** For each watcher, whether a source of it is suspended, since when and why in a word or two. */
export function suspendedEnvironments(options: Options, rows: ReadonlyArray<ConnectionRow>): Map<string, { since: number; words: string }> {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const out = new Map<string, { since: number; words: string }>();
  for (const watcher of options.watchers) {
    for (const source of watcher.sources) {
      for (const key of keysOf(options, watcher.id, source)) {
        const row = byKey.get(key);
        if (row?.suspended_at == null) continue;
        const known = out.get(watcher.id);
        if (!known || row.first_failed_at < known.since) out.set(watcher.id, { since: row.first_failed_at, words: failureWords(row.kind as FailureKind) });
      }
    }
  }
  return out;
}

export function causesOf(
  options: Options,
  rows: ReadonlyArray<ConnectionRow>,
  opencode: { readonly connected: boolean; readonly waiting: number; readonly checkedAt: number },
): Cause[] {
  const causes: Cause[] = [];
  const environmentsOf = (key: string) =>
    options.watchers.filter((w) => w.sources.some((source) => keysOf(options, w.id, source).includes(key))).map((w) => `${w.app}/${w.environment}`);
  const configured = new Set(options.watchers.flatMap((w) => w.sources.map((source) => keysOf(options, w.id, source)[0]!)));
  const failing = rows.filter((row) => configured.has(row.key));
  const offline = configured.size >= 2 && failing.length === configured.size && failing.every((row) => row.kind === "unreachable");
  if (offline) {
    const since = Math.min(...failing.map((row) => row.first_failed_at));
    causes.push({
      id: "offline",
      title: `Offline or off the VPN: none of the ${configured.size} connections answer; nothing is checked since ${clock(since)}`,
      fix: `Connect to the network or VPN. Overwatch tries again by itself, at once after a network change or waking from sleep.`,
      since,
      updatedAt: Math.max(...failing.map((row) => row.updated_at)),
      environments: [...new Set(failing.flatMap((row) => environmentsOf(row.key)))],
    });
  }
  for (const row of rows) {
    if (row.suspended_at === null || (offline && configured.has(row.key))) continue;
    const environments = environmentsOf(row.key);
    const name = row.key.replace(/^source:/, "");
    causes.push({
      id: row.key,
      title: `${name} is ${failureWords(row.kind as FailureKind)}: ${environments.join(", ") || "its sources"} not checked since ${clock(row.first_failed_at)}`,
      fix: row.fix,
      since: row.first_failed_at,
      updatedAt: row.updated_at,
      environments,
    });
  }
  if (!opencode.connected && opencode.waiting > 0) {
    causes.push({
      id: "opencode",
      title: `OpenCode is not running: ${opencode.waiting} investigation${opencode.waiting === 1 ? "" : "s"} wait${opencode.waiting === 1 ? "s" : ""}`,
      fix: "Start OpenCode (for example: opencode serve). Overwatch sends the waiting work by itself; nothing is lost.",
      since: opencode.checkedAt,
      updatedAt: opencode.checkedAt,
      environments: [],
    });
  }
  return causes;
}
