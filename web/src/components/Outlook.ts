/** What lies ahead for an environment: time left on its capacity sources (with visual fill bar), and its staging comparison. */
import type { Snapshot } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { el, type H } from "../ui.ts";

const none = { forecasts: [], comparisons: [] };

/** An environment's forecasts, the first time left among them, and its staging comparison; aged at `now`. */
export const ahead = (snapshot: Snapshot, place: { readonly app: string; readonly environment: string }, now: number) => {
  const outlook = snapshot.outlook ?? none;
  const forecasts = outlook.forecasts.filter((f) => f.source.startsWith(`${place.app}/${place.environment}/`));
  return {
    forecasts,
    left: forecasts.map((f) => m.timeLeft(f, now)).find(Boolean) ?? null,
    signal: outlook.comparisons.find((c) => c.app === place.app && c.staging === place.environment) ?? null,
  };
};

/** Approximate visual fill percentage for an active forecast within its 24h horizon (clamped 12%..96%). */
const horizonFill = (etaMinutes: number | null | undefined): number => {
  if (etaMinutes == null || !Number.isFinite(etaMinutes)) return 65;
  const ratio = 1 - Math.min(1, Math.max(0, etaMinutes / (24 * 60)));
  return Math.round(16 + ratio * 80);
};

/** The Time left and Staging panels of an environment. */
export const OutlookPanels = <M>(h: H<M>, snapshot: Snapshot, place: { readonly app: string; readonly environment: string }, now: number) => {
  const { forecasts, signal } = ahead(snapshot, place, now);
  const lines = forecasts.map((f) => {
    const t = m.timeLeft(f, now);
    const next = t ? t.long : m.outlookNext(f.state === "forecast" ? { ...f, state: "unknown", reason: "The newest reading is older than one interval" } : f) ?? "";
    const fill = f.state === "reached" ? 100 : t ? horizonFill(f.etaMinutes) : 0;
    return el(
      h,
      "li",
      { class: [t || f.state === "reached" ? "breach" : "calm", "capacity-row"] },
      el(
        h,
        "div",
        { class: "capacity-top" },
        el(h, "span", { class: "capacity-src" }, `${f.source} · ${f.resource}`),
        el(h, "b", {}, t ? t.short : f.state === "reached" ? "limit reached" : "no estimate"),
      ),
      (t || f.state === "reached") &&
        el(
          h,
          "div",
          { class: "capacity-bar", attrs: { "aria-hidden": "true" } },
          el(h, "span", { class: ["capacity-fill", f.state === "reached" ? "full" : "rising"], attrs: { style: `width:${fill}%` } }),
        ),
      t || f.state === "reached"
        ? el(h, "em", { class: "capacity-detail" }, next)
        : el(h, "span", { class: "gauge-note" }, next),
    );
  });
  const nextStep = m.outlookNext(signal);
  return [
    lines.length > 0 && el(h, "section", { class: "panel" }, el(h, "h3", {}, "Time left"), el(h, "ul", { class: "gauges" }, ...lines)),
    signal !== null && el(
      h,
      "section",
      { class: "panel" },
      el(h, "h3", {}, "Staging against production"),
      el(h, "p", { class: "panel-sub" }, "A comparison of this release with production, separate from environment health."),
      el(h, "p", { class: ["note", signal.state === "regression" && "warn"] }, m.comparisonText(signal) ?? ""),
      nextStep !== null && el(h, "p", { class: "note" }, nextStep),
    ),
  ];
};
