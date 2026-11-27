/**
 * The bar: one draft, asked about what is in focus, or a search when nothing is. One draft makes one request: a key
 * from the service is kept until the request is accepted, so a retry never queues the same prompt twice, and a late
 * reply clears only the draft it answered.
 */
import { Effect, Schema, Stream } from "effect";
import { Focus } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { Overwatch } from "../services/Overwatch.ts";
import { Command, CompletedMount, defineView, el, emit, Mount, Option, run, type Step, TaggedEnum } from "../ui.ts";

export const Props = Schema.Struct({
  focus: Schema.NullOr(Schema.String),
  /** What the chip says about the subject in focus. */
  label: Schema.String,
  down: Schema.Boolean,
  /** Whether a sheet or the finder is open: the page's keys are theirs then. */
  overlay: Schema.Boolean,
});
export type Props = typeof Props.Type;

export const Model = Schema.Struct({
  draft: Schema.String,
  /** A draft on its way: a second Enter meanwhile is ignored. */
  sending: Schema.Boolean,
  /** The draft's request key, kept until the request is accepted. */
  key: Schema.NullOr(Schema.Struct({ subject: Schema.String, value: Schema.String })),
  /** Where a prompt on the subject in focus goes, with a fresh request key, as last read. */
  target: Schema.NullOr(Focus),
});
export type Model = typeof Model.Type;
export const init: Model = { draft: "", sending: false, key: null, target: null };

export const Message = TaggedEnum({
  UpdatedDraft: { value: Schema.String },
  SubmittedDraft: { fresh: Schema.Boolean },
  SucceededAsk: { text: Schema.String, mode: Schema.String },
  FailedAsk: { subject: Schema.String, key: Schema.NullOr(Schema.String), message: Schema.String },
  LoadedTarget: { target: Focus },
  FailedTarget: { subject: Schema.String },
  CompletedFitBar: {},
  CompletedMount: { name: Schema.String },
});
export type Message = typeof Message.Type;

/** `Asked` and `FailedAsk` also tell the page the item may have changed, so it reads it again. */
export const Events = TaggedEnum({
  RequestedFind: { text: Schema.String },
  Asked: { mode: Schema.String },
  FailedAsk: { message: Schema.String },
});
export type Events = typeof Events.Type;

/** Where a prompt on the subject goes, with a fresh request key: the page makes no identifiers. */
export const LoadTarget = Command.define("LoadTarget", {
  args: { subject: Schema.String },
  messages: [Message.LoadedTarget, Message.FailedTarget],
  execute: ({ subject }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return yield* api.focus(subject);
    }).pipe(Effect.match({ onSuccess: (target) => Message.LoadedTarget({ target }), onFailure: () => Message.FailedTarget({ subject }) })),
});

/** Asks about a subject under the draft's request key, taking one from the service when the draft has none yet. */
export const AskAgent = Command.define("AskAgent", {
  args: { subject: Schema.String, text: Schema.String, fresh: Schema.Boolean, key: Schema.NullOr(Schema.String) },
  messages: [Message.SucceededAsk, Message.FailedAsk],
  execute: ({ subject, text, fresh, key }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      const used = key ?? (yield* api.focus(subject)).requestKey;
      return yield* api.ask({ subject, text, mode: fresh ? "new" : "auto" }, used).pipe(
        Effect.match({
          onSuccess: (asked) => Message.SucceededAsk({ text, mode: asked.target.mode }),
          onFailure: (error) => Message.FailedAsk({ subject, key: used, message: error.message }),
        }),
      );
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedAsk({ subject, key, message: error.message })))),
});

/** The bar grows with its draft, up to 160 pixels. */
const fit = (node: HTMLElement) => {
  node.style.height = "auto";
  node.style.height = `${Math.min(160, node.scrollHeight)}px`;
};

/** A draft the page changed itself (a reply cleared it) fits the bar again. */
const FitBar = Command.define("FitBar", {
  messages: [Message.CompletedFitBar],
  execute: Effect.sync(() => {
    const node = document.querySelector<HTMLElement>("[data-prompt]");
    if (node) fit(node);
    return Message.CompletedFitBar();
  }),
});

/**
 * The bar as an element. It fits its draft as the owner types. And p or Enter, pressed outside a field while
 * something is in focus, puts the caret in it within the same key press, so what is typed next lands in the bar; the
 * bar says when it takes those keys (`aria-keyshortcuts`), as the page renders it. Esc leaves the bar the same way.
 */
const KeepBar = Mount.defineStream("KeepBar", {
  messages: [CompletedMount],
  execute: ({ element }) =>
    Stream.callback<never>(() =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const node = element as HTMLTextAreaElement;
          const press = (event: KeyboardEvent) => {
            // Esc leaves the bar, as at once.
            if (event.key === "Escape" && event.target === node) return node.blur();
            if (event.defaultPrevented || !node.hasAttribute("aria-keyshortcuts")) return;
            const target = event.target;
            const typing = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
            if (m.command(event.key, { typing, shift: event.shiftKey, meta: event.metaKey || event.ctrlKey }) !== "prompt") return;
            event.preventDefault();
            node.focus();
          };
          const typed = () => fit(node);
          node.ownerDocument.addEventListener("keydown", press);
          node.addEventListener("input", typed);
          fit(node);
          return { node, press, typed };
        }),
        ({ node, press, typed }) =>
          Effect.sync(() => {
            node.ownerDocument.removeEventListener("keydown", press);
            node.removeEventListener("input", typed);
          }),
      )),
});

/** The subject in focus changed: read where a prompt on it goes. */
export const focusChanged = (model: Model, focus: string | null): Step<Model, Message, never> =>
  focus === null ? { model } : run(model, LoadTarget({ subject: focus }));

/** After an ask, the subject's target is read again: its key was spent and its conversation may now continue. */
const readAgain = (model: Model, props: Props, ...commands: ReadonlyArray<Command.Command<Message, never, Overwatch>>) =>
  props.focus === null ? commands : [...commands, LoadTarget({ subject: props.focus })];

export const update = (model: Model, message: Message, props: Props): Step<Model, Message, Events> =>
  Message.match(message, {
    UpdatedDraft: ({ value }) => ({ model: { ...model, draft: value } }),
    SubmittedDraft: ({ fresh }) => {
      const text = model.draft.trim();
      const subject = props.focus;
      if (subject === null) return emit(model, Events.RequestedFind({ text }));
      if (!text || props.down || model.sending) return { model };
      const key = model.key?.subject === subject ? model.key.value
        : model.target?.subject === subject ? model.target.requestKey
        : null;
      return run({ ...model, sending: true }, AskAgent({ subject, text, fresh, key }));
    },
    // A late reply clears only the draft it answered, never what was typed since.
    SucceededAsk: ({ text, mode }) => {
      const draft = model.draft.trim() === text ? "" : model.draft;
      return {
        model: { ...model, draft, key: null, sending: false },
        commands: readAgain(model, props, ...(draft === model.draft ? [] : [FitBar()])),
        outMessage: Events.Asked({ mode }),
      };
    },
    FailedAsk: ({ subject, key, message }) => ({
      model: { ...model, key: key === null ? null : { subject, value: key }, sending: false },
      commands: readAgain(model, props),
      outMessage: Events.FailedAsk({ message }),
    }),
    LoadedTarget: ({ target }) => ({ model: { ...model, target } }),
    FailedTarget: () => ({ model }),
    CompletedFitBar: () => ({ model }),
    CompletedMount: () => ({ model }),
  });

export const view = defineView<Model, Message, Props>((model, { focus, label, down, overlay }, h) => {
  const t = model.target !== null && model.target.subject === focus ? Option.some(model.target.promptTarget) : Option.none();
  const route = focus === null ? ""
    : down ? "Service not answering: your draft is kept"
    : Option.match(t, {
      onNone: () => "",
      onSome: (t) => (t.mode === "continue" ? "Continues the conversation · Shift+Enter for a new one" : "Queues a new conversation with an agent"),
    });
  return el(
    h,
    "form",
    { class: ["dock", focus !== null && "locked", down && "off"], attrs: { "data-dock": "", autocomplete: "off" }, on: [h.OnSubmit(Message.SubmittedDraft({ fresh: false }))] },
    el(
      h,
      "div",
      { class: "dock-meta" },
      el(
        h,
        "span",
        { class: "chip", attrs: { "data-chip": "" } },
        ...(focus === null ? ["Nothing in focus: Enter finds"] : [el(h, "span", { class: "reticle", attrs: { "aria-hidden": "true" } }, "⌖"), label]),
      ),
      el(h, "span", { class: "route", attrs: { "data-route": "" } }, route),
    ),
    el(
      h,
      "div",
      { class: "dock-row" },
      el(h, "textarea", {
        attrs: {
          "data-prompt": "",
          rows: "1",
          placeholder: "Find anything, or ask about what is in focus",
          "aria-label": "Find or ask",
          "aria-keyshortcuts": focus !== null && !overlay ? "p Enter" : undefined,
        },
        on: [
          h.Value(model.draft),
          h.OnMount(KeepBar()),
          h.OnInput((value) => Message.UpdatedDraft({ value })),
          h.OnKeyDownPreventDefault((key, { shiftKey }) =>
            key === "Enter" && shiftKey ? Option.some(Message.SubmittedDraft({ fresh: true }))
              : key === "Enter" ? Option.some(Message.SubmittedDraft({ fresh: false }))
              : Option.none()
          ),
        ],
      }),
      el(h, "button", { class: "send", attrs: { type: "submit", "data-send": "" }, on: [h.Disabled(down)] }, focus === null ? "Find " : "Ask ", el(h, "kbd", {}, "↵")),
    ),
  );
});
