/**
 * The context pack: what a session is told about its subject. Built by code from the event log, never by a model,
 * bounded, and made only of text that was redacted on its way in. A session's citations may quote it.
 */
import type { IncidentPageState } from "./views.ts";
import type { Handoff } from "./thread.ts";

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const MAX = 8_000;

/**
 * One piece of the context pack, with what it is. Only an `excerpt` is text a telemetry source returned, and only
 * an excerpt from source X can support a quote attributed to X. The owner's question, Overwatch's own description of
 * the incident and earlier conclusions are shown to the session too, but they are not evidence from any source.
 */
export type BriefPart =
  | { readonly kind: "excerpt"; readonly source: string; readonly text: string }
  | { readonly kind: "context" | "conclusion" | "question"; readonly text: string };

export interface ContextInput {
  readonly page: IncidentPageState | null;
  readonly handoff: Handoff | null;
  readonly ask: string;
  readonly origin: string;
  /** Lines about what is deployed, from the deploy context, when the service could read it. */
  readonly deploy?: ReadonlyArray<string>;
}

export function contextParts(input: ContextInput): BriefPart[] {
  const { page, handoff } = input;
  const parts: BriefPart[] = [];
  const context = (text: string) => parts.push({ kind: "context", text });
  if (page) {
    context(`Incident ${page.incidentId} in ${page.app}/${page.environment}: ${page.title}`);
    context(`Severity ${page.severity}; ${page.occurrences} occurrence(s) from ${iso(page.firstAt)} to ${iso(page.lastAt)}; source "${page.source}".`);
    if (page.sample) {
      context(`Sample line from source "${page.source}":`);
      parts.push({ kind: "excerpt", source: page.source, text: page.sample });
    }
    if (page.query) context(`To see it again: ${page.query}`);
    for (const { finding, at } of page.findings.slice(-2)) {
      parts.push({ kind: "conclusion", text: `Earlier finding (${iso(at)}): ${finding.engineering.verdict}, ${finding.engineering.cause}` });
    }
  }
  for (const line of input.deploy ?? []) context(line);
  if (handoff) {
    context("");
    parts.push({ kind: "conclusion", text: `Handoff from the previous session (${handoff.sessionId}, ${iso(handoff.at)}):\nConcluded: ${handoff.concluded}` });
    if (handoff.verified.length) {
      context("Verified citations (checked against their source when they were filed):");
      for (const v of handoff.verified) parts.push({ kind: "excerpt", source: v.source, text: `- ${v.source}: "${v.quote}"` });
    }
    parts.push({ kind: "conclusion", text: ["Ruled out:", ...(handoff.ruledOut.length ? handoff.ruledOut.map((r) => `- ${r}`) : ["- nothing recorded"])].join("\n") });
    if (handoff.open.length) parts.push({ kind: "conclusion", text: ["Still open:", ...handoff.open.map((o) => `- ${o}`)].join("\n") });
  }
  context("");
  parts.push({ kind: "question", text: input.origin === "system" ? "Overwatch asks: investigate this incident and file a finding." : `The owner asks: ${input.ask}` });
  return parts;
}

export function contextPack(input: ContextInput): string {
  const text = contextParts(input)
    .map((p) => p.text)
    .join("\n");
  return text.length > MAX ? `${text.slice(0, MAX)}\n[context pack truncated]` : text;
}

/** How a part is recorded as shown to a session: an excerpt under its source's name, anything else as `brief:<kind>`. */
export const shownLabel = (part: BriefPart) => (part.kind === "excerpt" ? part.source : `brief:${part.kind}`);
