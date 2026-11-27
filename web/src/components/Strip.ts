/**
 * The environments strip: one cell per watched environment, its health aged on the page's own clock, time left on its
 * capacity and a staging check. Nothing the page cannot vouch for is shown as measured.
 */
import { Schema } from "effect";
import { Snapshot } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { defineView, el, emit, type Step, TaggedEnum } from "../ui.ts";
import { HealthGlyph } from "./Glyphs.ts";
import { ahead } from "./Outlook.ts";

export const Props = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  connection: Schema.Literals(["unknown", "live", "stale", "down"]),
  /** The service's clock as the page knows it, or null before it has been stated. */
  serverNow: Schema.NullOr(Schema.Number),
  focus: Schema.NullOr(Schema.String),
});
export type Props = typeof Props.Type;

export const Model = Schema.Struct({});
export type Model = typeof Model.Type;
export const init: Model = {};

export const Message = TaggedEnum({ ClickedEnvironment: { subject: Schema.String } });
export type Message = typeof Message.Type;
export const Events = TaggedEnum({ Picked: { subject: Schema.String } });
export type Events = typeof Events.Type;

export const update = (model: Model, message: Message): Step<Model, Message, Events> =>
  Message.match(message, {
    ClickedEnvironment: ({ subject }) => emit(model, Events.Picked({ subject })),
  });

const detailOf = (health: string, errors: number) =>
  health === "attention" ? `${errors} active error${errors === 1 ? "" : "s"}`
    : health === "unknown" ? "until the service answers"
    : health === "signed_out" ? "sign in again"
    : health === "stale" ? "readings are old"
    : health === "partial" ? "not every reading"
    : "every reading fresh";

export const view = defineView<Model, Message, Props>((_model, { snapshot, connection, serverNow, focus }, h) => {
  const strip = { class: "strip", attrs: { "data-strip": "", "aria-label": "Environments" } };
  if (snapshot === null) return el(h, "nav", strip, el(h, "div", { class: "strip-empty" }, "Waiting for the first snapshot…"));
  return el(
    h,
    "nav",
    strip,
    ...snapshot.environments.map((e) => {
      const health = m.cellHealth(e, connection, serverNow);
      const errors = snapshot.incidents.filter((i) => i.app === e.app && i.environment === e.environment && i.active && i.severity === "error").length;
      const { left, signal } = ahead(snapshot, e, serverNow ?? snapshot.atMs);
      return el(
        h,
        "button",
        {
          class: ["env", health, focus === e.subject && "focused"],
          attrs: { type: "button", "data-env": e.environment, "data-app": e.app, "data-health": health, "data-subject": e.subject },
          on: [h.Key(e.subject), h.OnClick(Message.ClickedEnvironment({ subject: e.subject }))],
        },
        el(h, "span", { class: "glyph" }, HealthGlyph(h, health)),
        el(h, "span", { class: "env-name" }, el(h, "b", {}, e.environment), el(h, "span", {}, e.app)),
        el(
          h,
          "span",
          { class: "env-state" },
          el(h, "b", {}, m.HEALTH_LABEL[health] ?? ""),
          el(h, "span", {}, detailOf(health, errors)),
          left !== null && el(h, "span", { class: "ahead", attrs: { title: left.long } }, left.short),
          signal?.state === "regression" &&
            el(
              h,
              "span",
              { class: ["ahead", "warn"], attrs: { title: "A comparison of this staging release with production, separate from this environment's health reading" } },
              "staging check: a new problem since its release",
            ),
        ),
      );
    }),
  );
});
