/**
 * Later and Never ask one thing before they are sent: until when, or why. The decision is bound to the state the owner
 * was shown when the sheet opened; the page that opened it sends it.
 */
import { Command, UiSchema } from "@effect/ui";
import { Html, HtmlCommand } from "@effect/ui/html";
import { Dialog } from "@effect/ui-kit";
import { Schema } from "effect";
import { WayOutBody } from "../domain/Overwatch.ts";
import * as m from "../model.ts";

export const WayOutSheetProps = Schema.Struct({
  kind: Schema.Literals(["later", "never"]),
  title: Schema.String,
  /** The page's wall clock, for Later's times. */
  nowMs: Schema.Number,
});

const WayOutSheetMessage = UiSchema.TaggedEnum({
  UpdatedInput: { value: Schema.String },
  ClickedReason: { reason: Schema.String },
  SubmittedSheet: {},
  RequestedCloseDialog: {},
});

export const WayOutSheetEvents = UiSchema.TaggedEnum({
  Submitted: { body: WayOutBody },
  RequestedClose: {},
});

const SheetInput = Html.ref("SheetInput", "input");

export const WayOutSheet = Html.component({
  name: "WayOutSheet",
  props: WayOutSheetProps,
  model: Schema.Struct({ text: Schema.String, error: Schema.String }),
  message: WayOutSheetMessage,
  events: WayOutSheetEvents,
}).make({
  init: () => ({ text: "", error: "" }),
  update: {
    UpdatedInput: ($, { value }) => $.evolve({ text: value }),
    ClickedReason: ($, { reason }) => $.evolve({ text: reason }).run(HtmlCommand.focus(SheetInput, () => undefined).pipe(Command.asNoop)),
    SubmittedSheet: ($) => {
      if ($.props.kind === "never") {
        const reason = $.model.text.trim();
        return $.emit(WayOutSheetEvents.Submitted({ body: reason ? { action: "never", reason } : { action: "never" } }));
      }
      const body = m.later($.model.text, $.props.nowMs);
      return "error" in body ? $.evolve({ error: body.error }) : $.emit(WayOutSheetEvents.Submitted({ body }));
    },
    RequestedCloseDialog: ($) => $.emit(WayOutSheetEvents.RequestedClose()),
  },
  view: (h, model) => {
    const later = h.props.kind === "later";
    const input = (name: string, placeholder: string) =>
      h.input.ref(SheetInput).attrs({ name, "data-sheet-input": "", placeholder, autofocus: "" }).value(model.text)
        .on("input", ({ value }) => WayOutSheetMessage.UpdatedInput({ value }));
    return Dialog(h, {
      props: { open: true },
      onEmit: { RequestedOpen: () => undefined, RequestedClose: () => WayOutSheetMessage.RequestedCloseDialog(), Settled: () => undefined },
      view: (dialog) =>
        dialog.portal(h.dialog)?.children(
          dialog.backdrop(h.div.class("backdrop").attr("data-close", "")),
          dialog.popup(h.div.class("sheet").attrs({ role: "dialog", "aria-modal": "true" })).children(
            h.form.attr("data-sheet", h.props.kind).on("submit", WayOutSheetMessage.SubmittedSheet()).children(
              dialog.title(h.h2.id("sheet-title")).children(later ? "Later" : "Never"),
              h.p.class("sheet-subject").children(h.props.title),
              ...(later
                ? [
                  h.label("Until ", dialog.initialFocus(input("until", "something changes"))),
                  h.p.class("hint").children(
                    "Leave empty for ",
                    h.b("until something changes"),
                    " (a deploy here, a finding, or worse). Or type ",
                    h.code("2h"),
                    ", ",
                    h.code("tomorrow"),
                    ", ",
                    h.code("monday"),
                    ", ",
                    h.code("worse"),
                    ".",
                  ),
                ]
                : [
                  h.p.class("hint").children("It stays counted and searchable, and comes back only if it becomes more severe or ten times as frequent."),
                  h.div.class("chips").children(
                    ...["noise", "expected", "duplicate"].map((reason) =>
                      h.button.class("chip-option").attrs({ type: "button", "data-reason": reason }).on("click", WayOutSheetMessage.ClickedReason({ reason })).children(reason)
                    ),
                  ),
                  h.label("Reason ", dialog.initialFocus(input("reason", "optional"))),
                ]),
              h.p.class("error").attr("data-sheet-error", "").children(model.error),
              h.div.class("sheet-actions").children(
                dialog.close(h.button.attrs({ type: "button", "data-close": "" })).children("Cancel ", h.kbd("Esc")),
                h.button.class("primary").attr("type", "submit").children(later ? "Later " : "Never ", h.kbd("↵")),
              ),
            ),
          ),
        ) ?? h.text(""),
    });
  },
});
