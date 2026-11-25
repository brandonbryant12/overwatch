import { formatDuration, iso, parseDuration } from "./duration.ts";
import type { Incident } from "./incidents.ts";
import type { Options } from "./options.ts";
import { renderProductSummary } from "./report.ts";
import { loadWatcher, scanAll, type InvestigationRecord, type KV } from "./store.ts";

/** Terse status: watchers and their coverage, open incidents, recent investigations. */
export async function renderStatus(kv: KV, options: Options, errors: ReadonlyArray<string>, now: number): Promise<string> {
  const lines: string[] = ["## Overwatch"];
  if (errors.length) lines.push("", "**Configuration errors** (watchers are not scheduled until these are fixed):", ...errors.map((e) => `- ${e}`));
  if (!options.watchers.length) lines.push("", "No watchers configured. See docs/configuration.md.");

  for (const watcher of options.watchers) {
    const state = await loadWatcher(kv, watcher.id);
    const last = state.lastRun;
    const age = state.lastRunAt === undefined ? "never run" : `last run ${formatDuration(Math.max(60_000, Math.round((now - state.lastRunAt) / 60_000) * 60_000))} ago`;
    lines.push("", `**${watcher.id}** every ${formatDuration(watcher.everyMs)}, ${age}`);
    for (const source of watcher.sources) {
      const checkpoint = state.checkpoints[source];
      lines.push(`- ${source}: ${checkpoint === undefined ? "not checked yet" : `checked through ${iso(checkpoint)}`}`);
    }
    for (const note of last?.coverage ?? []) lines.push(`- ⚠ ${note}`);
  }

  const incidents = (await scanAll<Incident>(kv, "incident/")).filter((i) => i.status === "open").sort((a, b) => b.lastAt - a.lastAt);
  lines.push("", `**Open incidents:** ${incidents.length || "none"}`);
  for (const incident of incidents.slice(0, 20)) {
    lines.push(`- ${incident.id} ${incident.watcherId}: ${incident.title} (${incident.count}×, since ${iso(incident.firstAt)}, last ${iso(incident.lastAt)})`);
  }

  const investigations = (await scanAll<InvestigationRecord>(kv, "investigation/")).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  if (investigations.length) lines.push("", "**Recent investigations:**");
  for (const inv of investigations) {
    const verdict = inv.finding ? ` ${inv.finding.engineering.verdict.replace("_", " ")}:` : "";
    const summary = inv.finding ? ` ${renderProductSummary(inv.finding)}` : inv.error ? ` ${inv.error}` : "";
    lines.push(`- ${inv.id} [${inv.status}] ${inv.app}${inv.environment ? `/${inv.environment}` : ""} ${inv.title} —${verdict}${summary}${inv.pullRequest ? ` Draft PR: ${inv.pullRequest}` : ""}`);
  }
  return lines.join("\n");
}

export interface InvestigateArgs {
  readonly app?: string;
  readonly environment?: string;
  readonly since?: number;
  readonly until?: number;
  readonly text: string;
}

/** Parses `/investigate [--app a] [--env e] [--since 6h|ISO] [--until ISO] <pasted bug report>`. */
export function parseInvestigateArgs(input: string, now: number): InvestigateArgs | { error: string } {
  let rest = input.trim();
  const out: { app?: string; environment?: string; since?: number; until?: number } = {};
  for (;;) {
    const match = /^--(app|env|environment|since|until)(?:=|\s+)(\S+)\s*/.exec(rest);
    if (!match) break;
    rest = rest.slice(match[0].length);
    const [, flag, value] = match;
    if (flag === "app") out.app = value!;
    else if (flag === "env" || flag === "environment") out.environment = value!;
    else {
      const relative = parseDuration(value);
      const absolute = Date.parse(value!);
      const at = relative !== undefined ? now - relative : absolute;
      if (!Number.isFinite(at)) return { error: `--${flag} must be a duration such as 6h or an ISO time` };
      if (flag === "since") out.since = at;
      else out.until = at;
    }
  }
  if (!rest) return { error: "Paste the bug report after /investigate." };
  return { ...out, text: rest };
}

/** Picks the app for a manual investigation: named, the one whose checkout holds the directory, or the only one. */
export function pickApp(options: Options, named: string | undefined, directory: string | undefined): string | { error: string } {
  const names = Object.keys(options.apps);
  if (named) return options.apps[named] ? named : { error: `Unknown app "${named}". Configured: ${names.join(", ") || "none"}` };
  const inside = directory ? names.filter((n) => directory === options.apps[n]!.checkout || directory.startsWith(`${options.apps[n]!.checkout}/`)) : [];
  if (inside.length === 1) return inside[0]!;
  if (names.length === 1) return names[0]!;
  return { error: `Name the app with --app. Configured: ${names.join(", ") || "none"}` };
}
