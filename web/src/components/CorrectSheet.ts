/** "Was this right?": one dated line in the app's playbook, read by later investigations of that app. */
import { Command, Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Dialog } from "@effect/ui-kit";
import { Effect, Layer, Schema } from "effect";
import { ItemsTag } from "../queries/tags.ts";
import { Overwatch } from "../services/Overwatch.ts";

export const CorrectSheetProps = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** The verdict being corrected, in words. */
  verdict: Schema.String,
  app: Schema.String,
  jobId: Schema.String,
});

const CorrectSheetMessage = UiSchema.TaggedEnum({
  UpdatedText: { value: Schema.String },
  SubmittedSheet: {},
  SucceededSaveCorrection: {},
  FailedSaveCorrection: { message: Schema.String },
  RequestedCloseDialog: {},
});

export const CorrectSheetEvents = UiSchema.TaggedEnum({ Saved: {}, RequestedClose: {} });

/** Saves the correction under a fresh request key; the item reads again. */
class SaveCorrection extends Command.Service<SaveCorrection>()("correct/SaveCorrection", {
  args: { id: Schema.String, jobId: Schema.String, text: Schema.String },
  success: CorrectSheetMessage,
  invalidates: () => [ItemsTag],
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return ({ id, jobId, text }) =>
        api.focus(id).pipe(
          Effect.flatMap((focus) => api.correct(id, jobId, text, focus.requestKey)),
          Effect.match({
            onSuccess: () => CorrectSheetMessage.SucceededSaveCorrection(),
            onFailure: (error) => CorrectSheetMessage.FailedSaveCorrection({ message: error.message }),
          }),
        );
    }),
  );
}

export const CorrectSheetNoDeps = Html.component({
  name: "CorrectSheet",
  props: CorrectSheetProps,
  model: Schema.Struct({ text: Schema.String, error: Schema.String }),
  message: CorrectSheetMessage,
  events: CorrectSheetEvents,
}).make({
  init: () => ({ text: "", error: "" }),
  update: {
    UpdatedText: ($, { value }) => $.evolve({ text: value }),
    SubmittedSheet: ($) => {
      const text = $.model.text.trim();
      return text
        ? $.run(SaveCorrection.make({ id: $.props.id, jobId: $.props.jobId, text }))
        : $.evolve({ error: "Write what was wrong or what to check" });
    },
    SucceededSaveCorrection: ($) => $.emit(CorrectSheetEvents.Saved()),
    FailedSaveCorrection: ($, { message }) => $.evolve({ error: message }),
    RequestedCloseDialog: ($) => $.emit(CorrectSheetEvents.RequestedClose()),
  },
  view: (h, model) =>
    Dialog(h, {
      props: { open: true },
      onEmit: { RequestedOpen: () => undefined, RequestedClose: () => CorrectSheetMessage.RequestedCloseDialog(), Settled: () => undefined },
      view: (dialog) =>
        dialog.portal(h.dialog)?.children(
          dialog.backdrop(h.div.class("backdrop").attr("data-close", "")),
          dialog.popup(h.div.class("sheet").attrs({ role: "dialog", "aria-modal": "true" })).children(
            h.form.attrs({ "data-sheet": "correct", "data-job": h.props.jobId }).on("submit", CorrectSheetMessage.SubmittedSheet()).children(
              dialog.title(h.h2.id("correct-title")).children("Was this right?"),
              h.p.class("sheet-subject").children(`${h.props.title}: ${h.props.verdict}`),
              h.label(
                `What should the next investigation of ${h.props.app} know? `,
                dialog.initialFocus(h.textarea)
                  .attrs({ "data-sheet-input": "", rows: "4", maxlength: "1000", placeholder: "e.g. The regional maintenance window runs 02:00–03:00 UTC; check it first." })
                  .value(model.text)
                  .on("input", ({ value }) => CorrectSheetMessage.UpdatedText({ value }))
                  .on("keydown", ({ key, meta, ctrl }) => (key === "Enter" && (meta || ctrl) ? CorrectSheetMessage.SubmittedSheet() : undefined), { preventDefault: true }),
              ),
              h.p.class("hint").children(`It becomes one dated line in ${h.props.app}'s playbook and is given to later readers as guidance. It does not change this verdict.`),
              h.p.class("error").attr("data-sheet-error", "").children(model.error),
              h.div.class("sheet-actions").children(
                dialog.close(h.button.attrs({ type: "button", "data-close": "" })).children("Cancel ", h.kbd("Esc")),
                h.button.class("primary").attr("type", "submit").children("Save ", h.kbd("⌘↵")),
              ),
            ),
          ),
        ) ?? h.text(""),
    }),
});

export const CorrectSheet = CorrectSheetNoDeps.pipe(Component.provide(SaveCorrection.layer.pipe(Layer.provide(Overwatch.layer))));
