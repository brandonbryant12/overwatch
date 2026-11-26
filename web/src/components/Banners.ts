/** What stands between the owner and a current picture: a stale or silent service, paused collection, failing sources. */
import { Html } from "@effect/ui/html";
import { Schema } from "effect";
import { Snapshot } from "../domain/Overwatch.ts";

export const BannersProps = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  connection: Schema.Literals(["unknown", "live", "stale", "down"]),
  /** Whole seconds since the page last heard the service. */
  silence: Schema.Number,
});

export const causeTitle = (kind: string): string =>
  ({ signin: "Signed out", permission: "Permission refused", rate: "Rate limited", unreachable: "Unreachable", config: "Configuration", offline: "Offline" } as Record<string, string>)[kind] ?? kind;

export const Banners = Html.component({
  name: "Banners",
  props: BannersProps,
  model: Schema.Struct({}),
  message: Schema.Never,
}).make({
  init: () => ({}),
  update: {},
  view: (h) => {
    const { snapshot, connection, silence } = h.props;
    const age = h.span.attr("data-age", "").children(`${silence}s ago`);
    return h.div.class("banners").attr("data-banners", "").children(
      connection === "stale" &&
        h.div.class("banner", "stale").attr("role", "status").children(
          h.b("Stale"),
          h.span("Last heard ", age, ". Health unknown until the service answers again."),
        ),
      connection === "down" &&
        h.div.class("banner", "down").attr("role", "alert").children(
          h.b("Service not answering"),
          h.span("Last heard ", age, ". Actions are off; your draft is kept. Start it again with"),
          h.code("bin/overwatch serve"),
        ),
      snapshot?.paused === "disk" &&
        h.div.class("banner", "paused").attr("role", "status").children(h.b("Collection paused for disk space"), h.span(snapshot.pausedFix ?? "")),
      ...(snapshot?.causes ?? []).map((c, n) =>
        h.div.key(`${c.kind}:${n}`).class("banner", "cause", c.kind).children(
          h.b(causeTitle(c.kind)),
          h.span(c.sources.join(", ")),
          c.fix != null && c.fix !== "" && h.code(c.fix),
        )
      ),
    );
  },
});
