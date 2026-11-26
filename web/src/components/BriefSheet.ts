/**
 * B: a brief to copy. The owner edits it and sends it themselves; nothing is sent from here. Choosing an audience asks
 * for its brief, and the answer replaces the text only if the owner has not typed since: an edit made while the
 * request waits is never overwritten by a late template.
 */
import { Command, Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Clipboard } from "@effect/platform-browser";
import { Dialog } from "@effect/ui-kit";
import { Effect, Layer, Predicate, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Audience } from "../domain/Overwatch.ts";
import { GetBrief } from "../queries/GetBrief.ts";
import { Overwatch } from "../services/Overwatch.ts";

const LOADING = "Loading…";

const BriefSheetMessage = UiSchema.TaggedEnum({
  ChangedAudience: { value: Schema.String },
  UpdatedText: { value: Schema.String },
  AwaitedBrief: {},
  LoadedBrief: { audience: Schema.String, text: Schema.String },
  FailedBrief: { message: Schema.String },
  ClickedCopy: {},
  SucceededCopyBrief: {},
  FailedCopyBrief: { reason: Schema.String },
  RequestedCloseDialog: {},
});

export const BriefSheetEvents = UiSchema.TaggedEnum({
  Copied: {},
  FailedCopy: { reason: Schema.String },
  Failed: { message: Schema.String },
  RequestedClose: {},
});

/** Copies the text as it stands in the sheet. */
class CopyBrief extends Command.Service<CopyBrief>()("brief/CopyBrief", {
  args: { text: Schema.String },
  success: BriefSheetMessage,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const clipboard = yield* Clipboard.Clipboard;
      return ({ text }) =>
        clipboard.writeString(text).pipe(
          Effect.match({
            onSuccess: () => BriefSheetMessage.SucceededCopyBrief(),
            onFailure: (error) => BriefSheetMessage.FailedCopyBrief({ reason: Predicate.isError(error.cause) ? error.cause.message : error.message }),
          }),
        );
    }),
  );
}

export const BriefSheetNoDeps = Html.component({
  name: "BriefSheet",
  model: Schema.Struct({
    audience: Audience,
    text: Schema.String,
    /** The text the page last put in the field; the owner's own edits differ from it. */
    placed: Schema.String,
  }),
  message: BriefSheetMessage,
  events: BriefSheetEvents,
  queries: {
    brief: {
      query: GetBrief,
      args: ({ model }) => ({ audience: model.audience }),
      onChange: (result) =>
        AsyncResult.isSuccess(result) ? BriefSheetMessage.LoadedBrief(result.value)
          : AsyncResult.isFailure(result) ? BriefSheetMessage.FailedBrief({ message: briefFailure(result.cause) })
          : BriefSheetMessage.AwaitedBrief(),
    },
  },
}).make({
  init: () => ({ audience: "owner" as const, text: LOADING, placed: LOADING }),
  update: {
    ChangedAudience: ($, { value }) =>
      Schema.is(Audience)(value) ? $.evolve({ audience: value, text: LOADING, placed: LOADING }) : $.model,
    UpdatedText: ($, { value }) => $.evolve({ text: value }),
    AwaitedBrief: ($) => $.model,
    LoadedBrief: ($, { audience, text }) =>
      audience === $.model.audience && $.model.text === $.model.placed ? $.evolve({ text, placed: text }) : $.model,
    FailedBrief: ($, { message }) =>
      ($.model.text === $.model.placed ? $.evolve({ text: "", placed: "" }) : $.evolve({})).emit(BriefSheetEvents.Failed({ message })),
    ClickedCopy: ($) => $.run(CopyBrief.make({ text: $.model.text })),
    SucceededCopyBrief: ($) => $.emit(BriefSheetEvents.Copied()),
    FailedCopyBrief: ($, { reason }) => $.emit(BriefSheetEvents.FailedCopy({ reason })),
    RequestedCloseDialog: ($) => $.emit(BriefSheetEvents.RequestedClose()),
  },
  view: (h, model) =>
    Dialog(h, {
      props: { open: true },
      onEmit: { RequestedOpen: () => undefined, RequestedClose: () => BriefSheetMessage.RequestedCloseDialog(), Settled: () => undefined },
      view: (dialog) =>
        dialog.portal(h.dialog)?.children(
          dialog.backdrop(h.div.class("backdrop").attr("data-close", "")),
          dialog.popup(h.div.class("sheet", "brief-sheet").attrs({ role: "dialog", "aria-modal": "true" })).children(
            dialog.title(h.h2.id("brief-title")).children("Brief"),
            h.label(
              "For ",
              dialog.initialFocus(h.select)
                .attr("data-brief-audience", "")
                .on("change", ({ value }) => BriefSheetMessage.ChangedAudience({ value }))
                .children(
                  h.option.attr("value", "owner").selected(model.audience === "owner").children("you (technical)"),
                  h.option.attr("value", "team").selected(model.audience === "team").children("the team (plain words)"),
                ),
            ),
            h.textarea
              .attrs({ "data-brief-text": "", rows: "14", spellcheck: "true", "aria-label": "Brief text" })
              .value(model.text)
              .on("input", ({ value }) => BriefSheetMessage.UpdatedText({ value })),
            h.p.class("hint").children("What changed, from the event log. Edit it, copy it, send it yourself."),
            h.div.class("sheet-actions").children(
              dialog.close(h.button.attrs({ type: "button", "data-close": "" })).children("Close ", h.kbd("Esc")),
              h.button.class("primary").attrs({ type: "button", "data-brief-copy": "" }).on("click", BriefSheetMessage.ClickedCopy()).children("Copy"),
            ),
          ),
        ) ?? h.text(""),
    }),
});

/** A failed read in the service's words. */
const briefFailure = (cause: AsyncResult.Failure<unknown, { readonly message: string }>["cause"]) => {
  const error = cause.reasons.find((reason) => reason._tag === "Fail");
  return error?._tag === "Fail" ? error.error.message : "The brief could not be read";
};

export const BriefSheet = BriefSheetNoDeps.pipe(
  Component.provide(Layer.mergeAll(CopyBrief.layer.pipe(Layer.provide(Clipboard.layer)), GetBrief.layer.pipe(Layer.provide(Overwatch.layer)))),
);
