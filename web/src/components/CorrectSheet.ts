/** "Was this right?": one dated line in the app's playbook, read by later investigations of that app. */
import { Effect, Schema } from "effect";
import { Overwatch } from "../services/Overwatch.ts";
import { Command, defineView, el, emit, Option, run, type Step, TaggedEnum } from "../ui.ts";
import { Opening, sheet } from "./Sheet.ts";

export const Props = Schema.Struct({
  ...Opening,
  id: Schema.String,
  title: Schema.String,
  /** The verdict being corrected, in words. */
  verdict: Schema.String,
  app: Schema.String,
  jobId: Schema.String,
});
export type Props = typeof Props.Type;

export const Model = Schema.Struct({ text: Schema.String, error: Schema.String });
export type Model = typeof Model.Type;
export const init: Model = { text: "", error: "" };

export const Message = TaggedEnum({
  UpdatedText: { value: Schema.String },
  SubmittedSheet: {},
  SucceededSaveCorrection: {},
  FailedSaveCorrection: { message: Schema.String },
  RequestedCloseDialog: {},
  CompletedMount: { name: Schema.String },
});
export type Message = typeof Message.Type;

/** `Saved` also tells the page the item changed, so it reads it again. */
export const Events = TaggedEnum({ Saved: {}, RequestedClose: {} });
export type Events = typeof Events.Type;

/** Saves the correction under a fresh request key. */
export const SaveCorrection = Command.define("SaveCorrection", {
  args: { id: Schema.String, jobId: Schema.String, text: Schema.String },
  messages: [Message.SucceededSaveCorrection, Message.FailedSaveCorrection],
  execute: ({ id, jobId, text }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      const focus = yield* api.focus(id);
      yield* api.correct(id, jobId, text, focus.requestKey);
    }).pipe(
      Effect.match({
        onSuccess: () => Message.SucceededSaveCorrection(),
        onFailure: (error) => Message.FailedSaveCorrection({ message: error.message }),
      }),
    ),
});

export const update = (model: Model, message: Message, props: Props): Step<Model, Message, Events> =>
  Message.match(message, {
    UpdatedText: ({ value }) => ({ model: { ...model, text: value } }),
    SubmittedSheet: () => {
      const text = model.text.trim();
      return text ? run(model, SaveCorrection({ id: props.id, jobId: props.jobId, text })) : { model: { ...model, error: "Write what was wrong or what to check" } };
    },
    SucceededSaveCorrection: () => emit(model, Events.Saved()),
    FailedSaveCorrection: ({ message }) => ({ model: { ...model, error: message } }),
    RequestedCloseDialog: () => emit(model, Events.RequestedClose()),
    CompletedMount: () => ({ model }),
  });

export const view = defineView<Model, Message, Props>((model, props, h) =>
  sheet(
    h,
    { opened: props.opened, close: Message.RequestedCloseDialog(), mounted: (message) => message, labelledBy: "correct-title", popup: { class: ["sheet"] } },
    el(
      h,
      "form",
      { attrs: { "data-sheet": "correct", "data-job": props.jobId }, on: [h.OnSubmit(Message.SubmittedSheet())] },
      el(h, "h2", { attrs: { id: "correct-title" } }, "Was this right?"),
      el(h, "p", { class: "sheet-subject" }, `${props.title}: ${props.verdict}`),
      el(
        h,
        "label",
        {},
        `What should the next investigation of ${props.app} know? `,
        el(h, "textarea", {
          attrs: { "data-sheet-input": "", rows: "4", maxlength: "1000", placeholder: "e.g. The regional maintenance window runs 02:00–03:00 UTC; check it first." },
          on: [
            h.Autofocus(true),
            h.Value(model.text),
            h.OnInput((value) => Message.UpdatedText({ value })),
            h.OnKeyDownPreventDefault((key, { metaKey, ctrlKey }) => (key === "Enter" && (metaKey || ctrlKey) ? Option.some(Message.SubmittedSheet()) : Option.none())),
          ],
        }),
      ),
      el(h, "p", { class: "hint" }, `It becomes one dated line in ${props.app}'s playbook and is given to later readers as guidance. It does not change this verdict.`),
      el(h, "p", { class: "error", attrs: { "data-sheet-error": "" } }, model.error),
      el(
        h,
        "div",
        { class: "sheet-actions" },
        el(h, "button", { attrs: { type: "button", "data-close": "" }, on: [h.OnClick(Message.RequestedCloseDialog())] }, "Cancel ", el(h, "kbd", {}, "Esc")),
        el(h, "button", { class: "primary", attrs: { type: "submit" } }, "Save ", el(h, "kbd", {}, "⌘↵")),
      ),
    ),
  )
);
