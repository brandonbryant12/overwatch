/** What lies ahead for an environment: time left on its capacity sources, and its staging comparison. */
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

/** The Time left and Staging panels of an environment. */
export const OutlookPanels = <M>(h: H<M>, snapshot: Snapshot, place: { readonly app: string; readonly environment: string }, now: number) => {
  const { forecasts, signal } = ahead(snapshot, place, now);
  const lines = forecasts.map((f) => {
    const t = m.timeLeft(f, now);
    const next = t ? t.long : m.outlookNext(f.state === "forecast" ? { ...f, state: "unknown", reason: "The newest reading is older than one interval" } : f) ?? "";
    return el(h, "li", { class: t ? "breach" : "" }, el(h, "span", {}, `${f.source} · ${f.resource}`), el(h, "b", {}, t ? t.short : "no estimate"), el(h, "em", {}, next));
  });
  const nextStep = m.outlookNext(signal);
  return [
    lines.length > 0 && el(h, "section", { class: "panel" }, el(h, "h3", {}, "Time left"), el(h, "ul", { class: "gauges" }, ...lines)),
    signal !== null && el(
      h,
      "section",
      { class: "panel" },
      el(h, "h3", {}, "Staging against production (a comparison, not a health reading)"),
      el(h, "p", { class: ["note", signal.state === "regression" && "warn"] }, m.comparisonText(signal) ?? ""),
      nextStep !== null && el(h, "p", { class: "note" }, nextStep),
    ),
  ];
};
