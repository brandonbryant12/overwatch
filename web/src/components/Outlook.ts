/** What lies ahead for an environment: time left on its capacity sources, and its staging comparison. */
import type { Html } from "@effect/ui/html";
import type { Snapshot } from "../domain/Overwatch.ts";
import * as m from "../model.ts";

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
export const OutlookPanels = <M>(h: Html.H<M>, snapshot: Snapshot, place: { readonly app: string; readonly environment: string }, now: number) => {
  const { forecasts, signal } = ahead(snapshot, place, now);
  const lines = forecasts.map((f) => {
    const t = m.timeLeft(f, now);
    const next = t ? t.long : m.outlookNext(f.state === "forecast" ? { ...f, state: "unknown", reason: "The newest reading is older than one interval" } : f) ?? "";
    return h.li.class(t ? "breach" : "").children(h.span(`${f.source} · ${f.resource}`), h.b(t ? t.short : "no estimate"), h.em(next));
  });
  const nextStep = m.outlookNext(signal);
  return [
    lines.length > 0 && h.section.class("panel").children(h.h3("Time left"), h.ul.class("gauges").children(...lines)),
    signal !== null && h.section.class("panel").children(
      h.h3("Staging against production (a comparison, not a health reading)"),
      h.p.class("note", signal.state === "regression" && "warn").children(m.comparisonText(signal) ?? ""),
      nextStep !== null && h.p.class("note").children(nextStep),
    ),
  ];
};
