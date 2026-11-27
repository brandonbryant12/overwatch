/**
 * Pure declarative GenUI Visual Lens synthesis and evidence-handle grounding.
 * Imports zero view layer: every synthesized block comes strictly from stored Snapshot / ItemDetail facts, and every
 * AI-generated lens has its cited handles checked against the item's verified evidence handles.
 */
import type {
  CausalStep,
  CommitRiskItem,
  KeyFactItem,
  LensBlock,
  LensSpec,
  MetricCompareRow,
  SpanEntry,
  TimelineEvent,
} from "./domain/Lens.ts";
import type { Environment, Incident, ItemDetail, Piece, Snapshot } from "./domain/Overwatch.ts";
import * as m from "./model.ts";

export type LensMode = "auto" | "ai" | "derived";

export interface LensValidation {
  readonly verified: ReadonlyArray<string>;
  readonly ungrounded: ReadonlyArray<string>;
  readonly grounded: boolean;
}

/** Every evidence handle actually delivered and stored on this item. */
export function knownHandles(detail: ItemDetail | null | undefined): ReadonlySet<string> {
  const handles = new Set<string>();
  if (!detail) return handles;
  for (const f of detail.findings) {
    for (const c of f.claims ?? []) {
      for (const p of c.pieces ?? []) handles.add(p.handle);
    }
  }
  for (const inv of detail.investigations) {
    for (const p of inv.result?.challenge?.pieces ?? []) handles.add(p.handle);
  }
  return handles;
}

/** Collects every handle cited inside a LensSpec's blocks and verifiedHandles header. */
export function citedHandles(lens: LensSpec): ReadonlyArray<string> {
  const out = new Set<string>();
  for (const h of lens.verifiedHandles) if (h) out.add(h);
  for (const block of lens.blocks) {
    switch (block.kind) {
      case "causal_flow":
        for (const s of block.steps) if (s.handle) out.add(s.handle);
        break;
      case "span_waterfall":
        for (const s of block.spans) if (s.handle) out.add(s.handle);
        break;
      case "metric_compare":
        for (const r of block.rows) if (r.handle) out.add(r.handle);
        break;
      case "commit_risk":
        for (const c of block.commits) if (c.handle) out.add(c.handle);
        break;
      case "timeline":
        for (const e of block.events) if (e.handle) out.add(e.handle);
        break;
      case "key_facts":
        for (const f of block.facts) if (f.handle) out.add(f.handle);
        break;
    }
  }
  return [...out];
}

/**
 * Verifies every handle cited by a lens against the item's known handles.
 * Unknown handles are flagged explicitly so the UI renders them with dashed unknown-hatch styling.
 */
export function validateLensHandles(lens: LensSpec, valid: ReadonlySet<string>): LensValidation {
  const cited = citedHandles(lens);
  const verified: Array<string> = [];
  const ungrounded: Array<string> = [];
  for (const handle of cited) {
    if (valid.has(handle)) verified.push(handle);
    else ungrounded.push(handle);
  }
  return { verified, ungrounded, grounded: ungrounded.length === 0 };
}

/** Whether one handle is verified against known handles (absence of a handle on a derived metric is allowed). */
export const isHandleGrounded = (handle: string | null | undefined, valid: ReadonlySet<string>): boolean =>
  !handle || valid.has(handle);

/** Parses canonical `SLOW <durationMs>ms <service> <resource> trace=<id>` lines into waterfall spans. */
export function parseSlowSpans(pieces: ReadonlyArray<Pick<Piece, "handle" | "text">>): ReadonlyArray<SpanEntry> {
  const spans: Array<SpanEntry> = [];
  let offset = 0;
  for (const p of pieces) {
    for (const line of p.text.split("\n")) {
      const hit = /\bSLOW\s+(\d+(?:\.\d+)?)\s*ms\s+(\S+)\s+(.+?)(?:\s+trace=(\S+))?$/i.exec(line.trim());
      if (!hit) continue;
      const durationMs = Math.round(Number(hit[1]));
      if (!Number.isFinite(durationMs) || durationMs <= 0) continue;
      const service = hit[2]!;
      const label = hit[3]!.trim();
      spans.push({
        label,
        service,
        durationMs,
        offsetMs: offset,
        status: durationMs >= 1000 ? "error" : "slow",
        handle: p.handle,
      });
      offset += Math.max(12, Math.round(durationMs * 0.14));
    }
  }
  return spans.slice(0, 6);
}

/** Extracts clean before->after numeric transitions from causes, claims, or diffs (e.g. `3000 ms to 300 ms`, `20 to 5`). */
function extractComparisons(detail: ItemDetail | null, incident: Incident): ReadonlyArray<MetricCompareRow> {
  const rows: Array<MetricCompareRow> = [];
  const seen = new Set<string>();
  const add = (row: MetricCompareRow) => {
    const k = `${row.label}|${row.before}|${row.after}`;
    if (!seen.has(k)) {
      seen.add(k);
      rows.push(row);
    }
  };

  if (detail?.comparison) {
    const c = detail.comparison;
    const st = c.stagingCount ?? 0;
    const pr = c.productionCount ?? 0;
    add({
      label: `${c.staging} vs production`,
      before: `${pr}×`,
      after: `${st}×`,
      beforeNum: pr,
      afterNum: st,
      unit: "×",
      delta: c.state === "regression" ? `+${st - pr} in staging` : c.state.replaceAll("_", " "),
      tone: c.state === "regression" ? "warn" : c.state === "no_signal" ? "ok" : "neutral",
    });
  }

  // Extract from unified diff if a verified/candidate fix changes a scalar JSON value.
  const latestFix = [...(detail?.fixes ?? [])].reverse().find((f) => f.diff);
  if (latestFix?.diff) {
    const lines = latestFix.diff.split("\n");
    const removed = lines.find((l) => /^-\s*"([^"]+)"\s*:\s*([0-9.]+)/.test(l));
    const added = lines.find((l) => /^\+\s*"([^"]+)"\s*:\s*([0-9.]+)/.test(l));
    if (removed && added) {
      const rm = /^-\s*"([^"]+)"\s*:\s*([0-9.]+)/.exec(removed);
      const ad = /^\+\s*"([^"]+)"\s*:\s*([0-9.]+)/.exec(added);
      if (rm && ad && rm[1] === ad[1]) {
        const beforeNum = Number(rm[2]), afterNum = Number(ad[2]);
        const pct = beforeNum > 0 ? Math.round(((afterNum - beforeNum) / beforeNum) * 100) : 0;
        add({
          label: `Proposed restore · ${rm[1]}`,
          before: rm[2]!,
          after: ad[2]!,
          beforeNum,
          afterNum,
          delta: `${pct >= 0 ? "+" : ""}${pct}%`,
          tone: "ok",
        });
      }
    }
  }

  // Extract explicit "from X to Y" in causes/claims (e.g. "3000 ms to 300 ms", "pool_size from 20 to 5").
  const pieces = detail?.findings.flatMap((f) => f.claims?.flatMap((c) => c.pieces ?? []) ?? []) ?? [];
  const primaryHandle = pieces[0]?.handle;
  for (const f of detail?.findings ?? []) {
    const cause = f.body?.cause ?? "";
    const match = /\bfrom\s+(\d+(?:\.\d+)?)\s*(ms|s|%|mb|gb|kb)?\s+to\s+(\d+(?:\.\d+)?)\s*(ms|s|%|mb|gb|kb)?\b/i.exec(cause);
    if (match) {
      const b = Number(match[1]), a = Number(match[3]);
      const unit = match[4] ?? match[2] ?? "";
      const pct = b > 0 ? Math.round(((a - b) / b) * 100) : 0;
      const label = /timeout/i.test(cause) ? "Timeout threshold"
        : /pool/i.test(cause) ? "Connection pool size"
        : /limit|quota/i.test(cause) ? "Configured limit"
        : "Changed setting";
      add({
        label,
        before: `${b}${unit ? ` ${unit}` : ""}`,
        after: `${a}${unit ? ` ${unit}` : ""}`,
        beforeNum: b,
        afterNum: a,
        ...(unit ? { unit } : {}),
        delta: `${pct >= 0 ? "+" : ""}${pct}%`,
        tone: incident.severity === "error" ? "error" : "warn",
        ...(primaryHandle ? { handle: primaryHandle } : {}),
      });
    }
  }

  return rows.slice(0, 3);
}

/** Synthesizes an immediate, zero-latency deterministic Visual Lens grounded strictly in Snapshot + ItemDetail. */
export function synthesizeIncidentLens(
  snapshot: Snapshot,
  incident: Incident,
  detail: ItemDetail | null,
  nowMs: number,
): LensSpec {
  const blocks: Array<LensBlock> = [];
  const pieces = [
    ...(detail?.findings.flatMap((f) => f.claims?.flatMap((c) => c.pieces ?? []) ?? []) ?? []),
    ...(detail?.investigations.flatMap((inv) => inv.result?.challenge?.pieces ?? []) ?? []),
  ];
  const uniquePieces = [...new Map(pieces.map((p) => [p.handle, p])).values()];
  const verifiedHandles = uniquePieces.map((p) => p.handle);
  const firstHandle = uniquePieces[0]?.handle;
  const started = [...snapshot.deploys].reverse().find((x) => x.app === incident.app && x.environment === incident.environment && x.seq < incident.firstSeq);
  const latestInv = detail?.investigations.filter((x) => x.result).at(-1)?.result ?? null;
  const latestFix = [...(detail?.fixes ?? [])].reverse()[0] ?? null;
  const primaryFinding = detail?.findings.find((f) => !f.body?.challenge && f.body?.cause);

  // 1. Slow-span waterfall when canonical SLOW lines are present in evidence.
  const spans = parseSlowSpans(uniquePieces);
  if (spans.length > 0) {
    const durations = [...spans.map((s) => s.durationMs)].sort((a, b) => a - b);
    const p50Ms = durations[Math.floor(durations.length / 2)] ?? durations[0]!;
    blocks.push({
      kind: "span_waterfall",
      title: "Slow span waterfall",
      p50Ms,
      slowMs: Math.max(250, Math.round(p50Ms * 0.7)),
      spans,
    });
  }

  // 2. Causal flow when deploy onset, finding cause, or fix connects the chain.
  const steps: Array<CausalStep> = [];
  if (started) {
    steps.push({
      label: `Deploy ${started.revision.slice(0, 8)}`,
      detail: started.previous ? `from ${started.previous.slice(0, 8)} on ${incident.environment}` : `rolled out to ${incident.environment}`,
      tone: "neutral",
    });
  }
  if (primaryFinding?.body?.cause) {
    steps.push({
      label: latestInv ? (latestInv.verdict === "real" ? "Verified cause" : m.verdictView(latestInv).label) : "Filed cause",
      detail: primaryFinding.body.cause,
      tone: latestInv?.verdict === "real" ? "error" : latestInv?.verdict === "not_real" ? "ok" : "warn",
      ...(firstHandle ? { handle: firstHandle } : {}),
    });
  }
  steps.push({
    label: `${m.countText(incident.count, incident.exact)} in ${incident.environment}`,
    detail: incident.active ? `Active · last ${m.ago(incident.lastMs, nowMs)}` : `Quiet · last ${m.ago(incident.lastMs, nowMs)}`,
    tone: incident.active ? (incident.severity === "error" ? "error" : "warn") : "ok",
    ...(firstHandle ? { handle: firstHandle } : {}),
  });
  if (latestFix) {
    steps.push({
      label: m.FIX_LABEL[latestFix.state] ?? latestFix.state,
      detail: latestFix.pr ? `Draft #${latestFix.pr.number}` : latestFix.action ? "Press ⇧P to open draft PR" : (latestFix.reason ?? "Derived from Git"),
      tone: m.fixTone(latestFix.state) === "live" ? "ok" : m.fixTone(latestFix.state) === "working" ? "warn" : "neutral",
    });
  }
  if (steps.length >= 2) {
    blocks.push({ kind: "causal_flow", title: "Causal path", steps: steps.slice(0, 4) });
  }

  // 3. Before/after or staging-vs-prod visual comparison.
  const comparisons = extractComparisons(detail, incident);
  if (comparisons.length > 0) {
    blocks.push({ kind: "metric_compare", title: "Delta", rows: comparisons });
  }

  // 4. Matching commits from outlook.commits (when commit watcher is active).
  const appCommits = (snapshot.outlook?.commits ?? []).filter((c) => c.app === incident.app).slice(0, 3);
  if (appCommits.length > 0) {
    const commits: Array<CommitRiskItem> = appCommits.map((c) => ({
      sha: c.sha,
      subject: c.subject,
      files: c.files,
      insertions: c.insertions,
      deletions: c.deletions,
      flags: c.flags,
      deployed: c.deployedEnvs.includes(incident.environment),
    }));
    blocks.push({ kind: "commit_risk", title: "Recent commits", commits });
  }

  // 5. Fallback compact key-facts + timeline when no richer comparison/span block applied.
  if (blocks.length < 2) {
    const facts: Array<KeyFactItem> = [
      { label: "Occurrences", value: `${m.countText(incident.count, incident.exact)} (${incident.exact ? "exact" : "lower bound"})`, origin: "telemetry", ...(firstHandle ? { handle: firstHandle } : {}) },
      { label: "Onset", value: started ? `after ${started.revision.slice(0, 8)}` : `first ${m.ago(incident.firstMs, nowMs)}`, origin: "history" },
      {
        label: "Verdict",
        value: latestInv ? `${m.verdictView(latestInv).label} (${m.verdictView(latestInv).votes})` : "Not investigated yet",
        origin: latestInv?.observed ? "telemetry" : "history",
      },
    ];
    blocks.push({ kind: "key_facts", title: "At a glance", facts });
  }

  // Add compact event timeline if still room (max 3 blocks for calm focus).
  if (blocks.length < 3 && detail && detail.history.length > 0) {
    const events: Array<TimelineEvent> = [];
    if (started) events.push({ at: `seq ${started.seq}`, label: `Deployed ${started.revision.slice(0, 8)}`, kind: "deploy" });
    events.push({ at: m.ago(incident.firstMs, nowMs), label: "First counted", kind: "spike" });
    if (latestInv) events.push({ at: "adjudicated", label: `${m.verdictView(latestInv).label} (${m.verdictView(latestInv).votes})`, kind: "finding", ...(firstHandle ? { handle: firstHandle } : {}) });
    if (latestFix) events.push({ at: latestFix.state, label: m.FIX_LABEL[latestFix.state] ?? latestFix.state, kind: "fix" });
    if (events.length >= 2) blocks.push({ kind: "timeline", title: "Sequence", events: events.slice(0, 4) });
  }

  const summary = primaryFinding?.body?.cause
    ? primaryFinding.body.cause
    : detail?.comparison?.state === "regression"
    ? `New in ${detail.comparison.staging}: ${detail.comparison.stagingCount ?? 0}× vs ${detail.comparison.productionCount ?? 0}× in production`
    : `${m.countText(incident.count, incident.exact)} in ${incident.app}/${incident.environment} · first seen ${m.ago(incident.firstMs, nowMs)}`;

  return {
    source: "derived",
    title: "Visual lens",
    summary,
    generatedAt: nowMs,
    verifiedHandles,
    blocks: blocks.slice(0, 3),
  };
}

/** Synthesizes a compact lens for an environment when commits or deploy activity exist. */
export function synthesizeEnvLens(snapshot: Snapshot, env: Environment, nowMs: number): LensSpec | null {
  const appCommits = (snapshot.outlook?.commits ?? []).filter((c) => c.app === env.app).slice(0, 4);
  if (appCommits.length === 0) return null;
  return {
    source: "derived",
    title: "Recent commits",
    summary: `${appCommits.length} watched commit${appCommits.length === 1 ? "" : "s"} in ${env.app}`,
    generatedAt: nowMs,
    verifiedHandles: [],
    blocks: [
      {
        kind: "commit_risk",
        title: `Watched commits · ${env.app}`,
        commits: appCommits.map((c) => ({
          sha: c.sha,
          subject: c.subject,
          files: c.files,
          insertions: c.insertions,
          deletions: c.deletions,
          flags: c.flags,
          deployed: c.deployedEnvs.includes(env.environment),
        })),
      },
    ],
  };
}

/** Picks the active lens (AI vs Derived) and runs handle verification against ItemDetail. */
export function selectActiveLens(
  detail: ItemDetail | null,
  mode: LensMode,
  cachedAi: LensSpec | null | undefined,
  derived: LensSpec,
): { readonly lens: LensSpec; readonly hasAi: boolean; readonly validation: LensValidation } {
  const fromDetail = detail?.lens?.source === "ai"
    ? detail.lens
    : detail?.lenses?.find((l) => l.source === "ai") ?? null;
  const ai = cachedAi ?? fromDetail;
  const valid = knownHandles(detail);
  const chosen = mode === "derived" ? derived : ai ?? derived;
  return {
    lens: chosen,
    hasAi: ai !== null,
    validation: validateLensHandles(chosen, valid),
  };
}
