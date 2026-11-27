/**
 * B: a brief to copy. The owner edits it and sends it themselves; nothing is sent from here. Choosing an audience asks
 * for its brief, and the answer replaces the text only if the owner has not typed since: an edit made while the
 * request waits is never overwritten by a late template.
 */
import { Clipboard } from "@effect/platform-browser";
import { Effect, Predicate, Schema } from "effect";
import { Audience } from "../domain/Overwatch.ts";
import { Overwatch } from "../services/Overwatch.ts";
import { Command, defineView, el, emit, run, type Step, TaggedEnum } from "../ui.ts";
import { Opening, sheet } from "./Sheet.ts";

const LOADING = "Loading…";

export const Props = Schema.Struct(Opening);
export type Props = typeof Props.Type;

export const Model = Schema.Struct({
  audience: Audience,
  text: Schema.String,
  /** The text the page last put in the field; the owner's own edits differ from it. */
  placed: Schema.String,
});
export type Model = typeof Model.Type;

export const Message = TaggedEnum({
  ChangedAudience: { value: Schema.String },
  UpdatedText: { value: Schema.String },
  LoadedBrief: { audience: Schema.String, text: Schema.String },
  FailedBrief: { message: Schema.String },
  ClickedCopy: {},
  SucceededCopyBrief: {},
  FailedCopyBrief: { reason: Schema.String },
  RequestedCloseDialog: {},
  CompletedMount: { name: Schema.String },
});
export type Message = typeof Message.Type;

export const Events = TaggedEnum({
  Copied: {},
  FailedCopy: { reason: Schema.String },
  Failed: { message: Schema.String },
  RequestedClose: {},
});
export type Events = typeof Events.Type;

/** What changed, from the event log, written for one audience. */
export const LoadBrief = Command.define("LoadBrief", {
  args: { audience: Audience },
  messages: [Message.LoadedBrief, Message.FailedBrief],
  execute: ({ audience }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return yield* api.brief(audience);
    }).pipe(
      Effect.match({ onSuccess: (brief) => Message.LoadedBrief(brief), onFailure: (error) => Message.FailedBrief({ message: error.message }) }),
    ),
});

/** Copies the text as it stands in the sheet. */
export const CopyBrief = Command.define("CopyBrief", {
  args: { text: Schema.String },
  messages: [Message.SucceededCopyBrief, Message.FailedCopyBrief],
  execute: ({ text }) =>
    Effect.gen(function* () {
      const clipboard = yield* Clipboard.Clipboard;
      yield* clipboard.writeString(text);
    }).pipe(
      Effect.match({
        onSuccess: () => Message.SucceededCopyBrief(),
        onFailure: (error) => Message.FailedCopyBrief({ reason: Predicate.isError(error.cause) ? error.cause.message : error.message }),
      }),
    ),
});

/** A fresh sheet asks for the owner's brief at once. */
export const init = () => run<Model, Message>({ audience: "owner", text: LOADING, placed: LOADING }, LoadBrief({ audience: "owner" }));

export const update = (model: Model, message: Message): Step<Model, Message, Events> =>
  Message.match(message, {
    ChangedAudience: ({ value }) =>
      Schema.is(Audience)(value) ? run({ audience: value, text: LOADING, placed: LOADING }, LoadBrief({ audience: value })) : { model },
    UpdatedText: ({ value }) => ({ model: { ...model, text: value } }),
    LoadedBrief: ({ audience, text }) =>
      ({ model: audience === model.audience && model.text === model.placed ? { ...model, text, placed: text } : model }),
    FailedBrief: ({ message }) => emit(model.text === model.placed ? { ...model, text: "", placed: "" } : model, Events.Failed({ message })),
    ClickedCopy: () => run(model, CopyBrief({ text: model.text })),
    SucceededCopyBrief: () => emit(model, Events.Copied()),
    FailedCopyBrief: ({ reason }) => emit(model, Events.FailedCopy({ reason })),
    RequestedCloseDialog: () => emit(model, Events.RequestedClose()),
    CompletedMount: () => ({ model }),
  });

export const view = defineView<Model, Message, Props>((model, { opened }, h) =>
  sheet(
    h,
    { opened, close: Message.RequestedCloseDialog(), mounted: (message) => message, labelledBy: "brief-title", popup: { class: ["sheet", "brief-sheet"] } },
    el(h, "h2", { attrs: { id: "brief-title" } }, "Brief"),
    el(
      h,
      "label",
      {},
      "For ",
      el(
        h,
        "select",
        { attrs: { "data-brief-audience": "" }, on: [h.Autofocus(true), h.OnChange((value) => Message.ChangedAudience({ value }))] },
        el(h, "option", { attrs: { value: "owner" }, on: [h.Selected(model.audience === "owner")] }, "you (technical)"),
        el(h, "option", { attrs: { value: "team" }, on: [h.Selected(model.audience === "team")] }, "the team (plain words)"),
      ),
    ),
    el(h, "textarea", {
      attrs: { "data-brief-text": "", rows: "14", spellcheck: "true", "aria-label": "Brief text" },
      on: [h.Value(model.text), h.OnInput((value) => Message.UpdatedText({ value }))],
    }),
    el(h, "p", { class: "hint" }, "What changed, from the event log. Edit it, copy it, send it yourself."),
    el(
      h,
      "div",
      { class: "sheet-actions" },
      el(h, "button", { attrs: { type: "button", "data-close": "" }, on: [h.OnClick(Message.RequestedCloseDialog())] }, "Close ", el(h, "kbd", {}, "Esc")),
      el(h, "button", { class: "primary", attrs: { type: "button", "data-brief-copy": "" }, on: [h.OnClick(Message.ClickedCopy())] }, "Copy"),
    ),
  )
);
