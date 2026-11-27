/**
 * Later and Never ask one thing before they are sent: until when, or why. The decision is bound to the state the owner
 * was shown when the sheet opened; the page that opened it sends it.
 */
import { Effect, Schema } from "effect";
import { WayOutBody } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { Command, defineView, Dom, el, emit, run, type Step, TaggedEnum } from "../ui.ts";
import { Opening, sheet } from "./Sheet.ts";

export const Props = Schema.Struct({
  ...Opening,
  kind: Schema.Literals(["later", "never"]),
  title: Schema.String,
  /** The page's wall clock, for Later's times. */
  nowMs: Schema.Number,
});
export type Props = typeof Props.Type;

export const Model = Schema.Struct({ text: Schema.String, error: Schema.String });
export type Model = typeof Model.Type;
export const init: Model = { text: "", error: "" };

export const Message = TaggedEnum({
  UpdatedInput: { value: Schema.String },
  ClickedReason: { reason: Schema.String },
  SubmittedSheet: {},
  RequestedCloseDialog: {},
  CompletedFocusInput: {},
  CompletedMount: { name: Schema.String },
});
export type Message = typeof Message.Type;

export const Events = TaggedEnum({
  Submitted: { body: WayOutBody },
  RequestedClose: {},
});
export type Events = typeof Events.Type;

/** Puts the caret back in the sheet's field after a reason chip filled it. */
const FocusInput = Command.define("FocusInput", {
  messages: [Message.CompletedFocusInput],
  execute: Dom.focus("[data-sheet-input]").pipe(Effect.ignore, Effect.as(Message.CompletedFocusInput())),
});

export const update = (model: Model, message: Message, props: Props): Step<Model, Message, Events> =>
  Message.match(message, {
    UpdatedInput: ({ value }) => ({ model: { ...model, text: value } }),
    ClickedReason: ({ reason }) => run({ ...model, text: reason }, FocusInput()),
    SubmittedSheet: () => {
      if (props.kind === "never") {
        const reason = model.text.trim();
        return emit(model, Events.Submitted({ body: reason ? { action: "never", reason } : { action: "never" } }));
      }
      const body = m.later(model.text, props.nowMs);
      return "error" in body ? { model: { ...model, error: body.error } } : emit(model, Events.Submitted({ body }));
    },
    RequestedCloseDialog: () => emit(model, Events.RequestedClose()),
    CompletedFocusInput: () => ({ model }),
    CompletedMount: () => ({ model }),
  });

export const view = defineView<Model, Message, Props>((model, props, h) => {
  const later = props.kind === "later";
  const input = (name: string, placeholder: string) =>
    el(h, "input", {
      attrs: { name, "data-sheet-input": "", placeholder },
      on: [h.Autofocus(true), h.Value(model.text), h.OnInput((value) => Message.UpdatedInput({ value }))],
    });
  return sheet(
    h,
    { opened: props.opened, close: Message.RequestedCloseDialog(), mounted: (message) => message, labelledBy: "sheet-title", popup: { class: ["sheet"] } },
    el(
      h,
      "form",
      { attrs: { "data-sheet": props.kind }, on: [h.OnSubmit(Message.SubmittedSheet())] },
      el(h, "h2", { attrs: { id: "sheet-title" } }, later ? "Later" : "Never"),
      el(h, "p", { class: "sheet-subject" }, props.title),
      ...(later
        ? [
          el(h, "label", {}, "Until ", input("until", "something changes")),
          el(
            h,
            "p",
            { class: "hint" },
            "Leave empty for ",
            el(h, "b", {}, "until something changes"),
            " (a deploy here, a finding, or worse). Or type ",
            el(h, "code", {}, "2h"),
            ", ",
            el(h, "code", {}, "tomorrow"),
            ", ",
            el(h, "code", {}, "monday"),
            ", ",
            el(h, "code", {}, "worse"),
            ".",
          ),
        ]
        : [
          el(h, "p", { class: "hint" }, "It stays counted and searchable, and comes back only if it becomes more severe or ten times as frequent."),
          el(
            h,
            "div",
            { class: "chips" },
            ...["noise", "expected", "duplicate"].map((reason) =>
              el(h, "button", { class: "chip-option", attrs: { type: "button", "data-reason": reason }, on: [h.OnClick(Message.ClickedReason({ reason }))] }, reason)
            ),
          ),
          el(h, "label", {}, "Reason ", input("reason", "optional")),
        ]),
      el(h, "p", { class: "error", attrs: { "data-sheet-error": "" } }, model.error),
      el(
        h,
        "div",
        { class: "sheet-actions" },
        el(h, "button", { attrs: { type: "button", "data-close": "" }, on: [h.OnClick(Message.RequestedCloseDialog())] }, "Cancel ", el(h, "kbd", {}, "Esc")),
        el(h, "button", { class: "primary", attrs: { type: "submit" } }, later ? "Later " : "Never ", el(h, "kbd", {}, "↵")),
      ),
    ),
  );
});
