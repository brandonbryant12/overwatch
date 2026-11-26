/**
 * The environments strip: one cell per watched environment, its health aged on the page's own clock, time left on its
 * capacity and a staging check. Nothing the page cannot vouch for is shown as measured.
 */
import { UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Schema } from "effect";
import { Snapshot } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { HealthGlyph } from "./Glyphs.ts";
import { ahead } from "./Outlook.ts";

export const StripProps = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  connection: Schema.Literals(["unknown", "live", "stale", "down"]),
  /** The service's clock as the page knows it, or null before it has been stated. */
  serverNow: Schema.NullOr(Schema.Number),
  focus: Schema.NullOr(Schema.String),
});
export type StripProps = typeof StripProps.Type;

const StripMessage = UiSchema.TaggedEnum({ ClickedEnvironment: { subject: Schema.String } });
export const StripEvents = UiSchema.TaggedEnum({ Picked: { subject: Schema.String } });

const detailOf = (health: string, errors: number) =>
  health === "attention" ? `${errors} active error${errors === 1 ? "" : "s"}`
    : health === "unknown" ? "until the service answers"
    : health === "signed_out" ? "sign in again"
    : health === "stale" ? "readings are old"
    : health === "partial" ? "not every reading"
    : "every reading fresh";

export const Strip = Html.component({
  name: "Strip",
  props: StripProps,
  model: Schema.Struct({}),
  message: StripMessage,
  events: StripEvents,
}).make({
  init: () => ({}),
  update: {
    ClickedEnvironment: ($, { subject }) => $.emit(StripEvents.Picked({ subject })),
  },
  view: (h) => {
    const { snapshot, connection, serverNow, focus } = h.props;
    const strip = h.nav.class("strip").attrs({ "data-strip": "", "aria-label": "Environments" });
    if (snapshot === null) return strip.children(h.div.class("strip-empty").children("Waiting for the first snapshot…"));
    return strip.children(
      ...snapshot.environments.map((e) => {
        const health = m.cellHealth(e, connection, serverNow);
        const errors = snapshot.incidents.filter((i) => i.app === e.app && i.environment === e.environment && i.active && i.severity === "error").length;
        const { left, signal } = ahead(snapshot, e, serverNow ?? snapshot.atMs);
        return h.button
          .key(e.subject)
          .class("env", health, focus === e.subject && "focused")
          .attrs({ type: "button", "data-env": e.environment, "data-app": e.app, "data-health": health, "data-subject": e.subject })
          .on("click", StripMessage.ClickedEnvironment({ subject: e.subject }))
          .children(
            h.span.class("glyph").children(HealthGlyph(h, health)),
            h.span.class("env-name").children(h.b(e.environment), h.span(e.app)),
            h.span.class("env-state").children(
              h.b(m.HEALTH_LABEL[health] ?? ""),
              h.span(detailOf(health, errors)),
              left !== null && h.span.class("ahead").attr("title", left.long).children(left.short),
              signal?.state === "regression" &&
                h.span.class("ahead", "warn")
                  .attr("title", "A comparison of this staging release with production, separate from this environment's health reading")
                  .children("staging check: a new problem since its release"),
            ),
          );
      }),
    );
  },
});
