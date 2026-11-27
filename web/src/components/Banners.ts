/**
 * What stands between the owner and a current picture: a stale or silent service, paused collection, failing sources.
 * It has no state and sends nothing, so it is a view of its props drawn with the page's builder.
 */
import { Schema } from "effect";
import { Snapshot } from "../domain/Overwatch.ts";
import { el, type H } from "../ui.ts";

export const BannersProps = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  connection: Schema.Literals(["unknown", "live", "stale", "down"]),
  /** Whole seconds since the page last heard the service. */
  silence: Schema.Number,
});
export type BannersProps = typeof BannersProps.Type;

export const causeTitle = (kind: string): string =>
  ({ signin: "Signed out", permission: "Permission refused", rate: "Rate limited", unreachable: "Unreachable", config: "Configuration", offline: "Offline" } as Record<string, string>)[kind] ?? kind;

export const view = <M>(h: H<M>, { snapshot, connection, silence }: BannersProps) => {
  const age = () => el(h, "span", { attrs: { "data-age": "" } }, `${silence}s ago`);
  return el(
    h,
    "div",
    { class: "banners", attrs: { "data-banners": "" } },
    connection === "stale" &&
      el(
        h,
        "div",
        { class: ["banner", "stale"], attrs: { role: "status" } },
        el(h, "b", {}, "Stale"),
        el(h, "span", {}, "Last heard ", age(), ". Health unknown until the service answers again."),
      ),
    connection === "down" &&
      el(
        h,
        "div",
        { class: ["banner", "down"], attrs: { role: "alert" } },
        el(h, "b", {}, "Service not answering"),
        el(h, "span", {}, "Last heard ", age(), ". Actions are off; your draft is kept. Start it again with"),
        el(h, "code", {}, "bin/overwatch serve"),
      ),
    snapshot?.paused === "disk" &&
      el(h, "div", { class: ["banner", "paused"], attrs: { role: "status" } }, el(h, "b", {}, "Collection paused for disk space"), el(h, "span", {}, snapshot.pausedFix ?? "")),
    ...(snapshot?.causes ?? []).map((c, n) =>
      el(
        h,
        "div",
        { class: ["banner", "cause", c.kind], on: [h.Key(`${c.kind}:${n}`)] },
        el(h, "b", {}, causeTitle(c.kind)),
        el(h, "span", {}, c.sources.join(", ")),
        c.fix != null && c.fix !== "" && el(h, "code", {}, c.fix),
      )
    ),
  );
};
