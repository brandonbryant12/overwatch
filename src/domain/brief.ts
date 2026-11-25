/**
 * The context pack: what a session is told about its subject. Built by code from the event log, never by a model,
 * bounded, and made only of text that was redacted on its way in. A session's citations may quote it.
 */
import type { IncidentPageState } from "./views.ts";
import type { Handoff } from "./thread.ts";

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const MAX = 8_000;

export function contextPack(input: {
  readonly page: IncidentPageState | null;
  readonly handoff: Handoff | null;
  readonly ask: string;
  readonly origin: string;
}): string {
  const { page, handoff } = input;
  const lines: string[] = [];
  if (page) {
    lines.push(
      `Incident ${page.incidentId} in ${page.app}/${page.environment}: ${page.title}`,
      `Severity ${page.severity}; ${page.occurrences} occurrence(s) from ${iso(page.firstAt)} to ${iso(page.lastAt)}; source "${page.source}".`,
    );
    if (page.sample) lines.push(`Sample line from source "${page.source}":`, page.sample);
    if (page.query) lines.push(`To see it again: ${page.query}`);
    for (const { finding, at } of page.findings.slice(-2)) {
      lines.push(`Earlier finding (${iso(at)}): ${finding.engineering.verdict}, ${finding.engineering.cause}`);
    }
  }
  if (handoff) {
    lines.push("", `Handoff from the previous session (${handoff.sessionId}, ${iso(handoff.at)}):`, `Concluded: ${handoff.concluded}`);
    if (handoff.verified.length) lines.push("Verified citations:", ...handoff.verified.map((v) => `- ${v.source}: "${v.quote}"`));
    lines.push("Ruled out:", ...(handoff.ruledOut.length ? handoff.ruledOut.map((r) => `- ${r}`) : ["- nothing recorded"]));
    if (handoff.open.length) lines.push("Still open:", ...handoff.open.map((o) => `- ${o}`));
  }
  lines.push("", input.origin === "system" ? "Overwatch asks: investigate this incident and file a finding." : `The owner asks: ${input.ask}`);
  const text = lines.join("\n");
  return text.length > MAX ? `${text.slice(0, MAX)}\n[context pack truncated]` : text;
}
