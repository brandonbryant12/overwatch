/**
 * Shift+O: OpenCode Handoff Sheet — lets the engineer pick a handoff preset (Investigate, Fix locally, QA staging,
 * MCP commands), inspect/edit the grounded prompt (enriched from GET /v2/items/:id/handoff when available), copy it in
 * one keypress, or launch an interactive OpenCode browser tab.
 */
import { Clipboard } from "@effect/platform-browser";
import { Effect, Predicate, Schema } from "effect";
import { HandoffBundle, ItemDetail, Snapshot } from "../domain/Overwatch.ts";
import { buildOpenCodeHandoff, HANDOFF_PRESETS, type HandoffPreset } from "../handoff.ts";
import * as m from "../model.ts";
import { Overwatch } from "../services/Overwatch.ts";
import { Command, defineView, el, emit, run, type Step, TaggedEnum } from "../ui.ts";
import { Opening, sheet } from "./Sheet.ts";

const Preset = Schema.Literals(["investigate", "fix_local", "qa_staging", "mcp_only"]);

export const Props = Schema.Struct({
  ...Opening,
  focus: Schema.String,
  snapshot: Schema.NullOr(Snapshot),
  detail: Schema.NullOr(ItemDetail),
});
export type Props = typeof Props.Type;

export const Model = Schema.Struct({
  preset: Preset,
  text: Schema.String,
  placed: Schema.String,
  bundle: Schema.NullOr(HandoffBundle),
  loading: Schema.Boolean,
  copied: Schema.Boolean,
});
export type Model = typeof Model.Type;

export const Message = TaggedEnum({
  SelectedPreset: { preset: Preset },
  UpdatedText: { value: Schema.String },
  LoadedBundle: { bundle: HandoffBundle },
  FailedBundle: {},
  ClickedCopy: {},
  ClickedOpenTab: {},
  SucceededCopy: {},
  FailedCopy: { reason: Schema.String },
  RequestedCloseDialog: {},
  CompletedMount: { name: Schema.String },
});
export type Message = typeof Message.Type;

export const Events = TaggedEnum({
  Copied: { handles: Schema.Number },
  FailedCopy: { reason: Schema.String },
  RequestedOpenTab: {},
  RequestedClose: {},
});
export type Events = typeof Events.Type;

export const LoadHandoff = Command.define("LoadHandoff", {
  args: { id: Schema.String },
  messages: [Message.LoadedBundle, Message.FailedBundle],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return yield* api.handoff(id);
    }).pipe(Effect.match({ onSuccess: (bundle) => Message.LoadedBundle({ bundle }), onFailure: () => Message.FailedBundle() })),
});

export const CopyHandoffPrompt = Command.define("CopyHandoffPrompt", {
  args: { text: Schema.String },
  messages: [Message.SucceededCopy, Message.FailedCopy],
  execute: ({ text }) =>
    Effect.gen(function* () {
      const clipboard = yield* Clipboard.Clipboard;
      yield* clipboard.writeString(text);
    }).pipe(
      Effect.match({
        onSuccess: () => Message.SucceededCopy(),
        onFailure: (error) => Message.FailedCopy({ reason: Predicate.isError(error.cause) ? error.cause.message : error.message }),
      }),
    ),
});

export const init = (snapshot: Snapshot | null, focus: string, detail: ItemDetail | null): Step<Model, Message, never> => {
  const initial = buildOpenCodeHandoff(snapshot, focus, detail, "investigate")?.text ?? "";
  const model: Model = { preset: "investigate", text: initial, placed: initial, bundle: null, loading: m.isIncident(focus), copied: false };
  return m.isIncident(focus) ? run(model, LoadHandoff({ id: focus })) : { model };
};

export const update = (model: Model, message: Message, props: Props): Step<Model, Message, Events> =>
  Message.match(message, {
    SelectedPreset: ({ preset }) => {
      const next = buildOpenCodeHandoff(props.snapshot, props.focus, props.detail, preset, model.bundle)?.text ?? "";
      return { model: { ...model, preset, text: next, placed: next, copied: false } };
    },
    UpdatedText: ({ value }) => ({ model: { ...model, text: value, copied: false } }),
    LoadedBundle: ({ bundle }) => {
      const next = buildOpenCodeHandoff(props.snapshot, props.focus, props.detail, model.preset, bundle)?.text ?? model.text;
      // Preserve user edits made while the network request was in flight.
      const keep = model.text !== model.placed;
      return { model: { ...model, bundle, loading: false, text: keep ? model.text : next, placed: keep ? model.placed : next } };
    },
    FailedBundle: () => ({ model: { ...model, loading: false } }),
    ClickedCopy: () => run(model, CopyHandoffPrompt({ text: model.text })),
    ClickedOpenTab: () => emit(model, Events.RequestedOpenTab()),
    SucceededCopy: () => {
      const handles = buildOpenCodeHandoff(props.snapshot, props.focus, props.detail, model.preset, model.bundle)?.handleCount ?? 0;
      return emit({ ...model, copied: true }, Events.Copied({ handles }));
    },
    FailedCopy: ({ reason }) => emit(model, Events.FailedCopy({ reason })),
    RequestedCloseDialog: () => emit(model, Events.RequestedClose()),
    CompletedMount: () => ({ model }),
  });

export const view = defineView<Model, Message, Props>((model, { opened, focus, snapshot, detail }, h) => {
  const summary = buildOpenCodeHandoff(snapshot, focus, detail, model.preset, model.bundle);
  const presetInfo = HANDOFF_PRESETS.find((p) => p.id === model.preset);
  return sheet(
    h,
    { opened, close: Message.RequestedCloseDialog(), mounted: (message) => message, labelledBy: "handoff-title", popup: { class: ["sheet", "handoff-sheet"] } },
    el(h, "h2", { attrs: { id: "handoff-title" } }, "OpenCode handoff"),
    el(
      h,
      "p",
      { class: "sheet-subject" },
      `${focus} · ${summary?.handleCount ?? 0} verified handle${summary?.handleCount === 1 ? "" : "s"}${model.bundle?.checkout ? ` · ${model.bundle.checkout}` : ""}${model.loading ? " · enriching…" : ""}`,
    ),
    el(
      h,
      "div",
      { class: "segmented handoff-presets", attrs: { role: "radiogroup", "aria-label": "Handoff preset" } },
      ...HANDOFF_PRESETS.map((p) =>
        el(
          h,
          "button",
          {
            class: model.preset === p.id ? "active" : "",
            attrs: { type: "button", role: "radio", "aria-checked": String(model.preset === p.id), "data-handoff-preset": p.id },
            on: [h.OnClick(Message.SelectedPreset({ preset: p.id as HandoffPreset }))],
          },
          p.label,
        )
      ),
    ),
    el(h, "p", { class: "hint" }, presetInfo?.hint ?? ""),
    el(h, "textarea", {
      attrs: { "data-handoff-text": "", rows: "14", spellcheck: "false", "aria-label": "OpenCode handoff prompt" },
      on: [h.Autofocus(true), h.Value(model.text), h.OnInput((value) => Message.UpdatedText({ value }))],
    }),
    el(
      h,
      "div",
      { class: "sheet-actions" },
      el(h, "button", { attrs: { type: "button", "data-close": "" }, on: [h.OnClick(Message.RequestedCloseDialog())] }, "Close ", el(h, "kbd", {}, "Esc")),
      el(h, "button", { attrs: { type: "button", "data-handoff-open": "" }, on: [h.OnClick(Message.ClickedOpenTab())] }, "Open tab ", el(h, "kbd", {}, "o")),
      el(
        h,
        "button",
        {
          class: ["primary", model.copied && "copied"],
          attrs: { type: "button", "data-handoff-copy": "", "data-copied": model.copied ? "true" : undefined },
          on: [h.OnClick(Message.ClickedCopy())],
        },
        model.copied ? "Copied for OpenCode" : "Copy prompt",
      ),
    ),
  );
});
