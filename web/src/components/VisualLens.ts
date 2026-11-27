/**
 * Declarative GenUI Visual Lens renderer: draws 6 bounded, schema-validated engineering visual blocks using pure
 * Foldkit elements and inline SVG (zero innerHTML). Every cited handle is checked against ItemDetail's verified
 * handles; ungrounded items render with dashed unknown-hatch styling.
 */
import type {
  CausalFlowBlock,
  CommitRiskBlock,
  KeyFactsBlock,
  LensBlock,
  LensSpec,
  MetricCompareBlock,
  SpanWaterfallBlock,
  TimelineBlock,
} from "../domain/Lens.ts";
import { isHandleGrounded, type LensMode, type LensValidation } from "../lens.ts";
import * as m from "../model.ts";
import { el, type H } from "../ui.ts";
import { CommitIcon, LensIcon } from "./Glyphs.ts";

export interface VisualLensHandlers<M> {
  readonly onCopyHandle: (handle: string) => M;
  readonly onSwitchMode?: (mode: LensMode) => M;
  readonly onGenerateAi?: () => M;
}

export interface VisualLensViewOptions {
  readonly lens: LensSpec;
  readonly validation: LensValidation;
  readonly validHandles: ReadonlySet<string>;
  readonly hasAi: boolean;
  readonly mode: LensMode;
  readonly loading: boolean;
  readonly canGenerate: boolean;
}

const HandleChip = <M>(h: H<M>, handle: string | null | undefined, valid: ReadonlySet<string>, onCopy: (handle: string) => M) => {
  if (!handle) return null;
  const grounded = valid.has(handle);
  return el(
    h,
    "button",
    {
      class: ["handle", "lens-handle", !grounded && "ungrounded"],
      attrs: {
        type: "button",
        "data-handle": handle,
        title: grounded ? `${handle} · click to copy verified handle` : `${handle} · unverified handle (not in stored evidence)`,
      },
      on: [h.OnClick(onCopy(handle))],
    },
    grounded ? m.shortHandle(handle) : `? ${m.shortHandle(handle)}`,
  );
};

const renderCausalFlow = <M>(h: H<M>, block: CausalFlowBlock, valid: ReadonlySet<string>, onCopy: (handle: string) => M) =>
  el(
    h,
    "div",
    { class: ["lens-block", "lens-causal"], attrs: { "data-lens-block": "causal_flow" } },
    el(h, "div", { class: "lens-block-head" }, el(h, "span", {}, block.title)),
    el(
      h,
      "ol",
      { class: "causal-steps" },
      ...block.steps.map((step, i) => {
        const grounded = isHandleGrounded(step.handle, valid);
        return el(
          h,
          "li",
          { class: ["causal-step", `tone-${step.tone}`, !grounded && "lens-ungrounded"] },
          el(h, "span", { class: "causal-idx", attrs: { "aria-hidden": "true" } }, String(i + 1)),
          el(
            h,
            "div",
            { class: "causal-body" },
            el(h, "div", { class: "causal-top" }, el(h, "b", {}, step.label), HandleChip(h, step.handle, valid, onCopy)),
            el(h, "p", {}, step.detail),
          ),
        );
      }),
    ),
  );

const renderSpanWaterfall = <M>(h: H<M>, block: SpanWaterfallBlock, valid: ReadonlySet<string>, onCopy: (handle: string) => M) => {
  const maxEnd = Math.max(1, ...block.spans.map((s) => s.offsetMs + s.durationMs), block.p50Ms ?? 0, block.slowMs ?? 0);
  const p50Pct = block.p50Ms != null ? Math.min(98, Math.max(2, (block.p50Ms / maxEnd) * 100)) : null;
  const slowPct = block.slowMs != null ? Math.min(98, Math.max(2, (block.slowMs / maxEnd) * 100)) : null;
  return el(
    h,
    "div",
    { class: ["lens-block", "lens-waterfall"], attrs: { "data-lens-block": "span_waterfall" } },
    el(
      h,
      "div",
      { class: "lens-block-head" },
      el(h, "span", {}, block.title),
      el(
        h,
        "span",
        { class: "lens-submeta" },
        ...[
          block.p50Ms != null ? `p50 ${block.p50Ms}ms` : null,
          block.slowMs != null ? `threshold ${block.slowMs}ms` : null,
        ].filter(Boolean).join(" · "),
      ),
    ),
    el(
      h,
      "ul",
      { class: "waterfall-rows" },
      ...block.spans.map((span) => {
        const left = Math.min(94, Math.max(0, (span.offsetMs / maxEnd) * 100));
        const width = Math.min(100 - left, Math.max(4, (span.durationMs / maxEnd) * 100));
        const grounded = isHandleGrounded(span.handle, valid);
        return el(
          h,
          "li",
          { class: ["wf-row", `wf-${span.status}`, !grounded && "lens-ungrounded"] },
          el(
            h,
            "div",
            { class: "wf-meta" },
            el(h, "span", { class: "wf-service" }, span.service),
            el(h, "span", { class: "wf-label", attrs: { title: span.label } }, span.label),
            HandleChip(h, span.handle, valid, onCopy),
          ),
          el(
            h,
            "div",
            { class: "wf-track" },
            p50Pct !== null && el(h, "span", { class: "wf-ref", attrs: { style: `left:${p50Pct.toFixed(1)}%`, title: `p50 ${block.p50Ms}ms` } }),
            slowPct !== null && el(h, "span", { class: ["wf-ref", "wf-thresh"], attrs: { style: `left:${slowPct.toFixed(1)}%`, title: `slow threshold ${block.slowMs}ms` } }),
            el(h, "span", { class: ["wf-bar", `wf-${span.status}`], attrs: { style: `left:${left.toFixed(1)}%;width:${width.toFixed(1)}%` } }),
          ),
          el(h, "span", { class: "wf-dur" }, `${span.durationMs.toLocaleString("en-US")} ms`),
        );
      }),
    ),
  );
};

const renderMetricCompare = <M>(h: H<M>, block: MetricCompareBlock, valid: ReadonlySet<string>, onCopy: (handle: string) => M) =>
  el(
    h,
    "div",
    { class: ["lens-block", "lens-compare"], attrs: { "data-lens-block": "metric_compare" } },
    el(h, "div", { class: "lens-block-head" }, el(h, "span", {}, block.title)),
    el(
      h,
      "ul",
      { class: "compare-rows" },
      ...block.rows.map((row) => {
        const grounded = isHandleGrounded(row.handle, valid);
        const maxN = Math.max(1, row.beforeNum ?? 0, row.afterNum ?? 0);
        const hasBars = row.beforeNum != null && row.afterNum != null;
        const bPct = hasBars ? Math.max(4, ((row.beforeNum ?? 0) / maxN) * 100) : 0;
        const aPct = hasBars ? Math.max(4, ((row.afterNum ?? 0) / maxN) * 100) : 0;
        return el(
          h,
          "li",
          { class: ["compare-row", `tone-${row.tone}`, !grounded && "lens-ungrounded"] },
          el(
            h,
            "div",
            { class: "compare-top" },
            el(h, "b", {}, row.label),
            el(h, "span", { class: ["compare-delta", `tone-${row.tone}`] }, row.delta),
            HandleChip(h, row.handle, valid, onCopy),
          ),
          el(
            h,
            "div",
            { class: "compare-vals" },
            el(h, "span", { class: "compare-before" }, row.before),
            el(h, "span", { class: "compare-arrow", attrs: { "aria-hidden": "true" } }, "→"),
            el(h, "span", { class: "compare-after" }, row.after),
          ),
          hasBars &&
            el(
              h,
              "div",
              { class: "compare-bars", attrs: { "aria-hidden": "true" } },
              el(h, "span", { class: "bar-before", attrs: { style: `width:${bPct.toFixed(1)}%` } }),
              el(h, "span", { class: ["bar-after", `tone-${row.tone}`], attrs: { style: `width:${aPct.toFixed(1)}%` } }),
            ),
        );
      }),
    ),
  );

const renderCommitRisk = <M>(h: H<M>, block: CommitRiskBlock, valid: ReadonlySet<string>, onCopy: (handle: string) => M) =>
  el(
    h,
    "div",
    { class: ["lens-block", "lens-commits"], attrs: { "data-lens-block": "commit_risk" } },
    el(h, "div", { class: "lens-block-head" }, el(h, "span", {}, block.title)),
    el(
      h,
      "ul",
      { class: "commit-rows" },
      ...block.commits.map((c) => {
        const grounded = isHandleGrounded(c.handle, valid);
        return el(
          h,
          "li",
          { class: ["commit-row", !grounded && "lens-ungrounded"] },
          el(h, "span", { class: "commit-icon" }, CommitIcon(h)),
          el(h, "code", { class: "commit-sha" }, c.sha.slice(0, 8)),
          el(h, "span", { class: "commit-subject" }, c.subject),
          el(
            h,
            "span",
            { class: "commit-stat" },
            el(h, "ins", {}, `+${c.insertions}`),
            " ",
            el(h, "del", {}, `-${c.deletions}`),
            ` · ${c.files}f`,
          ),
          el(
            h,
            "span",
            { class: "commit-flags" },
            el(h, "span", { class: ["flag", c.deployed ? "flag-ok" : "flag-warn"] }, c.deployed ? "deployed" : "unreleased"),
            ...c.flags.slice(0, 3).map((flag) => el(h, "span", { class: "flag" }, flag)),
          ),
          HandleChip(h, c.handle, valid, onCopy),
        );
      }),
    ),
  );

const renderTimeline = <M>(h: H<M>, block: TimelineBlock, valid: ReadonlySet<string>, onCopy: (handle: string) => M) =>
  el(
    h,
    "div",
    { class: ["lens-block", "lens-timeline"], attrs: { "data-lens-block": "timeline" } },
    el(h, "div", { class: "lens-block-head" }, el(h, "span", {}, block.title)),
    el(
      h,
      "ol",
      { class: "timeline-strip" },
      ...block.events.map((ev) => {
        const grounded = isHandleGrounded(ev.handle, valid);
        return el(
          h,
          "li",
          { class: ["tl-node", `tl-${ev.kind}`, !grounded && "lens-ungrounded"] },
          el(h, "span", { class: "tl-dot", attrs: { "aria-hidden": "true" } }),
          el(h, "span", { class: "tl-at" }, ev.at),
          el(h, "span", { class: "tl-label" }, ev.label),
          HandleChip(h, ev.handle, valid, onCopy),
        );
      }),
    ),
  );

const renderKeyFacts = <M>(h: H<M>, block: KeyFactsBlock, valid: ReadonlySet<string>, onCopy: (handle: string) => M) =>
  el(
    h,
    "div",
    { class: ["lens-block", "lens-facts"], attrs: { "data-lens-block": "key_facts" } },
    el(h, "div", { class: "lens-block-head" }, el(h, "span", {}, block.title)),
    el(
      h,
      "dl",
      { class: "facts-grid" },
      ...block.facts.map((fact) => {
        const grounded = isHandleGrounded(fact.handle, valid);
        return el(
          h,
          "div",
          { class: ["fact-tile", !grounded && "lens-ungrounded"] },
          el(h, "dt", {}, el(h, "span", {}, fact.label), el(h, "span", { class: ["origin-tag", `origin-${fact.origin}`] }, fact.origin)),
          el(h, "dd", {}, el(h, "b", {}, fact.value), HandleChip(h, fact.handle, valid, onCopy)),
        );
      }),
    ),
  );

const renderBlock = <M>(h: H<M>, block: LensBlock, valid: ReadonlySet<string>, onCopy: (handle: string) => M) => {
  switch (block.kind) {
    case "causal_flow": return renderCausalFlow(h, block, valid, onCopy);
    case "span_waterfall": return renderSpanWaterfall(h, block, valid, onCopy);
    case "metric_compare": return renderMetricCompare(h, block, valid, onCopy);
    case "commit_risk": return renderCommitRisk(h, block, valid, onCopy);
    case "timeline": return renderTimeline(h, block, valid, onCopy);
    case "key_facts": return renderKeyFacts(h, block, valid, onCopy);
  }
};

export const VisualLens = <M>(h: H<M>, options: VisualLensViewOptions, handlers: VisualLensHandlers<M>) => {
  const { lens, validation, validHandles, hasAi, mode, loading, canGenerate } = options;
  if (lens.blocks.length === 0) return null;
  const originText = lens.source === "ai"
    ? validation.grounded
      ? `AI lens · ${validation.verified.length} handle${validation.verified.length === 1 ? "" : "s"} verified`
      : `AI lens · ${validation.ungrounded.length} unverified ref${validation.ungrounded.length === 1 ? "" : "s"}`
    : validation.verified.length > 0
    ? `Derived · ${validation.verified.length} handle${validation.verified.length === 1 ? "" : "s"}`
    : "Derived from snapshot";

  return el(
    h,
    "section",
    {
      class: ["panel", "lens-card", lens.source === "ai" && "lens-ai", !validation.grounded && "lens-partial"],
      attrs: { "data-lens": lens.source, "aria-label": lens.title },
    },
    el(
      h,
      "header",
      { class: "lens-head" },
      el(
        h,
        "div",
        { class: "lens-title-wrap" },
        el(h, "span", { class: "lens-icon" }, LensIcon(h)),
        el(h, "h3", {}, lens.title),
        el(h, "span", { class: ["lens-origin", !validation.grounded && "warn"] }, originText),
      ),
      el(
        h,
        "div",
        { class: "lens-controls" },
        hasAi && handlers.onSwitchMode
          ? el(
            h,
            "div",
            { class: "segmented lens-toggle", attrs: { role: "radiogroup", "aria-label": "Lens source" } },
            el(
              h,
              "button",
              {
                class: mode !== "derived" ? "active" : "",
                attrs: { type: "button", role: "radio", "aria-checked": String(mode !== "derived"), "data-lens-mode": "ai" },
                on: [h.OnClick(handlers.onSwitchMode("ai"))],
              },
              "AI",
            ),
            el(
              h,
              "button",
              {
                class: mode === "derived" ? "active" : "",
                attrs: { type: "button", role: "radio", "aria-checked": String(mode === "derived"), "data-lens-mode": "derived" },
                on: [h.OnClick(handlers.onSwitchMode("derived"))],
              },
              "Derived",
            ),
          )
          : null,
        canGenerate && handlers.onGenerateAi
          ? el(
            h,
            "button",
            {
              class: "lens-gen-btn",
              attrs: { type: "button", "data-action": "lens", title: "Generate or refresh AI visual lens (g)" },
              on: [h.Disabled(loading), h.OnClick(handlers.onGenerateAi())],
            },
            loading ? el(h, "span", { class: "orbit", attrs: { "aria-hidden": "true" } }) : null,
            loading ? "Synthesizing…" : hasAi ? "Refresh lens " : "AI lens ",
            !loading && el(h, "kbd", {}, "g"),
          )
          : null,
      ),
    ),
    el(h, "p", { class: "lens-summary" }, lens.summary),
    el(
      h,
      "div",
      { class: "lens-blocks" },
      ...lens.blocks.map((block) => renderBlock(h, block, validHandles, handlers.onCopyHandle)),
    ),
  );
};
