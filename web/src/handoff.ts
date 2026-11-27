/**
 * Pure OpenCode session handoff prompt builder.
 * Zero view-layer imports: builds structured, copy-ready Markdown prompts grounded in Snapshot, ItemDetail, evidence
 * handles, and optional server `/v2/items/:id/handoff` payloads so engineers can jump straight into a local OpenCode
 * session with full context.
 */
import type { HandoffBundle, ItemDetail, Snapshot } from "./domain/Overwatch.ts";
import { knownHandles } from "./lens.ts";
import * as m from "./model.ts";

export type HandoffPreset = "investigate" | "fix_local" | "qa_staging" | "mcp_only";

export const HANDOFF_PRESETS: ReadonlyArray<{ readonly id: HandoffPreset; readonly label: string; readonly hint: string }> = [
  { id: "investigate", label: "Investigate", hint: "Deep-dive root cause with evidence handles and MCP tools" },
  { id: "fix_local", label: "Fix locally", hint: "Reproduce, patch, and run verify checks in your checkout" },
  { id: "qa_staging", label: "QA staging", hint: "Compare staging vs production rollout and verify safety" },
  { id: "mcp_only", label: "MCP commands", hint: "Minimal structured context for an already-open OpenCode session" },
];

const presetGoal = (preset: HandoffPreset, subject: string): string => {
  switch (preset) {
    case "investigate":
      return `Inspect \`${subject}\` via Overwatch MCP tools (\`ow_get\`, \`ow_search\`, \`ow_outlook\`), verify the cited evidence handles, and explain root cause + blast radius.`;
    case "fix_local":
      return `Reproduce \`${subject}\` locally, inspect the commit diff and failing code paths, prepare a minimal verified patch, and run the project's test/verify commands before opening a draft PR.`;
    case "qa_staging":
      return `Compare staging against production for \`${subject}\` using \`ow_outlook\` and \`ow_get\`, check whether this regression blocks promotion, and list targeted QA checks.`;
    case "mcp_only":
      return `Call \`ow_get({ id: "${subject}" })\` first, then inspect \`ow_outlook\` and \`ow_inbox\` as needed.`;
  }
};

export interface HandoffSummary {
  readonly text: string;
  readonly handleCount: number;
  readonly subject: string;
}

/**
 * Builds a structured OpenCode starter prompt for the focused incident, environment, or source.
 * Uses server `/v2/items/:id/handoff` data when available and gracefully synthesizes client-side otherwise.
 */
export function buildOpenCodeHandoff(
  snapshot: Snapshot | null,
  focus: string | null,
  detail: ItemDetail | null,
  preset: HandoffPreset = "investigate",
  bundle?: HandoffBundle | null,
): HandoffSummary | null {
  if (!focus) return null;

  const lines: Array<string> = [];
  const incident = detail?.incident ?? snapshot?.incidents.find((x) => x.id === focus);
  const env = focus.startsWith("env:") ? snapshot?.environments.find((x) => x.subject === focus) : null;
  const source = focus.startsWith("src:") ? snapshot?.sources.find((x) => x.subject === focus) : null;

  const handles = bundle?.handles.length
    ? bundle.handles
    : [...knownHandles(detail)];
  const mcpTools = bundle?.mcpTools.length
    ? bundle.mcpTools
    : ["ow_get", "ow_search", "ow_inbox", "ow_outlook", "ow_brief", "ow_act"];

  if (preset === "mcp_only") {
    lines.push(`# Overwatch Handoff · \`${focus}\``);
    if (incident) lines.push(`- Subject: ${incident.title} (${incident.app}/${incident.environment})`);
    else if (env) lines.push(`- Environment: ${env.app}/${env.environment} (${env.health})`);
    else if (source) lines.push(`- Source: ${source.id} (${source.kind})`);
    if (bundle?.checkout) lines.push(`- Checkout: \`${bundle.checkout}\``);
    if (handles.length) lines.push(`- Evidence handles: ${handles.slice(0, 8).map((h) => `\`${h}\``).join(", ")}`);
    lines.push(`- MCP tools: ${mcpTools.map((t) => `\`${t}\``).join(", ")}`);
    lines.push("", presetGoal(preset, focus));
    return { text: lines.join("\n"), handleCount: handles.length, subject: focus };
  }

  if (bundle && preset === "investigate" && bundle.markdown.trim()) {
    return { text: bundle.markdown.trim(), handleCount: handles.length, subject: focus };
  }

  if (incident) {
    const deploy = bundle?.deploy ?? [...(snapshot?.deploys ?? [])].reverse().find((d) => d.app === incident.app && d.environment === incident.environment && d.seq < incident.firstSeq)?.revision ?? null;
    const prevDeploy = bundle?.previousDeploy ?? [...(snapshot?.deploys ?? [])].reverse().find((d) => d.app === incident.app && d.environment === incident.environment && d.revision === deploy)?.previous ?? null;
    const latestInv = detail?.investigations.filter((x) => x.result).at(-1)?.result ?? null;
    const latestFix = [...(detail?.fixes ?? [])].reverse()[0] ?? null;
    const cause = detail?.findings.find((f) => !f.body?.challenge && f.body?.cause)?.body?.cause ?? null;

    lines.push(`# Overwatch Context: ${incident.title}`);
    lines.push("");
    lines.push(`- **Subject**: \`${incident.id}\` (${incident.app} / ${incident.environment})`);
    lines.push(`- **Count**: ${m.countText(incident.count, incident.exact)} (${incident.exact ? "exact" : "lower bound"}, severity: ${incident.severity}, active: ${incident.active ? "yes" : "quiet"})`);
    if (bundle?.checkout) lines.push(`- **Checkout**: \`${bundle.checkout}\``);
    if (deploy) lines.push(`- **Deploy**: \`${deploy.slice(0, 12)}\`${prevDeploy ? ` (previous \`${prevDeploy.slice(0, 12)}\`)` : ""}`);
    if (latestInv) {
      const v = m.verdictView(latestInv);
      lines.push(`- **Verdict**: ${v.label} (${v.votes}${v.challenge ? ` · ${v.challenge}` : ""}${v.evidence ? ` · ${v.evidence}` : ""})`);
    }
    if (cause) lines.push(`- **Cause**: ${cause}`);
    if (latestFix) {
      lines.push(`- **Fix candidate**: \`${latestFix.id}\` (${m.FIX_LABEL[latestFix.state] ?? latestFix.state})${latestFix.pr ? ` · Draft #${latestFix.pr.number}` : ""}`);
    }
    if (handles.length > 0) {
      lines.push("", "## Evidence Handles", ...handles.slice(0, 10).map((h) => `- \`${h}\``));
    }
    const commands = [
      ...(bundle?.commands ?? []),
      ...(latestFix?.verification.map((v) => v.argv.join(" ")) ?? []),
      ...(deploy && prevDeploy ? [`git diff ${prevDeploy.slice(0, 12)}..${deploy.slice(0, 12)}`] : []),
    ];
    const uniqueCommands = [...new Set(commands.filter(Boolean))];
    if (uniqueCommands.length > 0) {
      lines.push("", "## Commands", ...uniqueCommands.map((cmd) => `- \`${cmd}\``));
    }
    lines.push("", "## Next Step", presetGoal(preset, incident.id));
    lines.push("", `_Overwatch MCP tools available: ${mcpTools.join(", ")}._`);
    return { text: lines.join("\n"), handleCount: handles.length, subject: incident.id };
  }

  if (env) {
    const envSources = snapshot?.sources.filter((s) => s.app === env.app && s.environment === env.environment) ?? [];
    lines.push(`# Overwatch Environment Context: ${env.app} / ${env.environment}`);
    lines.push("");
    lines.push(`- **Subject**: \`${env.subject}\``);
    lines.push(`- **Health**: ${m.HEALTH_LABEL[env.health] ?? env.health}`);
    if (envSources.length) {
      lines.push(`- **Sources**: ${envSources.map((s) => `${s.id} (${s.failure ?? "ok"})`).join(", ")}`);
    }
    const repairs = envSources.map((s) => s.fix).filter((x): x is string => Boolean(x));
    if (repairs.length) lines.push("", "## Repair Commands", ...repairs.map((r) => `- \`${r}\``));
    lines.push("", "## Next Step", presetGoal(preset, env.subject));
    return { text: lines.join("\n"), handleCount: 0, subject: env.subject };
  }

  if (source) {
    lines.push(`# Overwatch Source Context: ${source.id}`);
    lines.push("");
    lines.push(`- **Subject**: \`${source.subject}\` (${source.kind})`);
    lines.push(`- **Status**: ${source.failure ?? "healthy"}${source.suspended ? " (suspended)" : ""}`);
    if (source.fix) lines.push(`- **Repair**: \`${source.fix}\``);
    lines.push("", "## Next Step", presetGoal(preset, source.subject));
    return { text: lines.join("\n"), handleCount: 0, subject: source.subject };
  }

  lines.push(`# Overwatch Context: \`${focus}\``, "", presetGoal(preset, focus));
  return { text: lines.join("\n"), handleCount: handles.length, subject: focus };
}
