/**
 * The bar: one draft, asked about what is in focus, or a search when nothing is. One draft makes one request: a key
 * from the service is kept until the request is accepted, so a retry never queues the same prompt twice, and a late
 * reply clears only the draft it answered.
 */
import { Command, Component, Mount, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { AsyncResult } from "effect/reactivity";
import * as m from "../model.ts";
import { GetFocus } from "../queries/GetFocus.ts";
import { FocusTag, ItemsTag } from "../queries/tags.ts";
import { Overwatch } from "../services/Overwatch.ts";

export const DockProps = Schema.Struct({
  focus: Schema.NullOr(Schema.String),
  /** What the chip says about the subject in focus. */
  label: Schema.String,
  down: Schema.Boolean,
  /** Whether a sheet or the finder is open: the page's keys are theirs then. */
  overlay: Schema.Boolean,
});

const DockMessage = UiSchema.TaggedEnum({
  UpdatedDraft: { value: Schema.String },
  SubmittedDraft: { fresh: Schema.Boolean },
  SucceededAsk: { text: Schema.String, mode: Schema.String },
  FailedAsk: { subject: Schema.String, key: Schema.NullOr(Schema.String), message: Schema.String },
});

export const DockEvents = UiSchema.TaggedEnum({
  RequestedFind: { text: Schema.String },
  Asked: { mode: Schema.String },
  FailedAsk: { message: Schema.String },
});

/** Asks about a subject under the draft's request key, taking one from the service when the draft has none yet. */
class AskAgent extends Command.Service<AskAgent>()("dock/AskAgent", {
  args: { subject: Schema.String, text: Schema.String, fresh: Schema.Boolean, key: Schema.NullOr(Schema.String) },
  success: DockMessage,
  invalidates: () => [ItemsTag, FocusTag],
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return ({ subject, text, fresh, key }) =>
        Effect.gen(function* () {
          const used = key ?? (yield* api.focus(subject)).requestKey;
          return yield* api.ask({ subject, text, mode: fresh ? "new" : "auto" }, used).pipe(
            Effect.match({
              onSuccess: (asked) => DockMessage.SucceededAsk({ text, mode: asked.target.mode }),
              onFailure: (error) => DockMessage.FailedAsk({ subject, key: used, message: error.message }),
            }),
          );
        }).pipe(Effect.catch((error) => Effect.succeed(DockMessage.FailedAsk({ subject, key, message: error.message }))));
    }),
  );
}

/**
 * The bar as an element. It grows with its draft, up to 160 pixels. And p or Enter, pressed outside a field while
 * something is in focus, puts the caret in it within the same key press, so what is typed next lands in the bar; the
 * bar says when it takes those keys (`aria-keyshortcuts`), as the page renders it. Esc leaves the bar the same way.
 */
const KeepBar = Mount.make("KeepBar", { args: { draft: Schema.String } }, (node: HTMLTextAreaElement, _args, changes) => {
  const fit = Effect.sync(() => {
    node.style.height = "auto";
    node.style.height = `${Math.min(160, node.scrollHeight)}px`;
  });
  const takeKeys = Effect.acquireRelease(
    Effect.sync(() => {
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
      node.ownerDocument.addEventListener("keydown", press);
      return press;
    }),
    (press) => Effect.sync(() => node.ownerDocument.removeEventListener("keydown", press)),
  );
  return takeKeys.pipe(Effect.andThen(fit), Effect.andThen(Stream.runForEach(changes, () => fit)), Effect.andThen(Effect.never), Effect.as(Component.noop));
});

export const DockNoDeps = Html.component({
  name: "Dock",
  props: DockProps,
  model: Schema.Struct({
    draft: Schema.String,
    /** A draft on its way: a second Enter meanwhile is ignored. */
    sending: Schema.Boolean,
    /** The draft's request key, kept until the request is accepted. */
    key: Schema.NullOr(Schema.Struct({ subject: Schema.String, value: Schema.String })),
  }),
  message: DockMessage,
  events: DockEvents,
  queries: {
    target: { query: GetFocus, args: ({ props }) => (props.focus === null ? undefined : { subject: props.focus }) },
  },
}).make({
  init: () => ({ draft: "", sending: false, key: null }),
  update: {
    UpdatedDraft: ($, { value }) => $.evolve({ draft: value }),
    SubmittedDraft: ($, { fresh }) => {
      const text = $.model.draft.trim();
      const subject = $.props.focus;
      if (subject === null) return $.emit(DockEvents.RequestedFind({ text }));
      if (!text || $.props.down || $.model.sending) return $.model;
      const target = $.queries.target;
      const key = $.model.key?.subject === subject ? $.model.key.value
        : AsyncResult.isSuccess(target) && target.value.subject === subject ? target.value.requestKey
        : null;
      return $.evolve({ sending: true }).run(AskAgent.make({ subject, text, fresh, key }));
    },
    // A late reply clears only the draft it answered, never what was typed since.
    SucceededAsk: ($, { text, mode }) =>
      $.evolve({ draft: (draft) => (draft.trim() === text ? "" : draft), key: null, sending: false }).emit(DockEvents.Asked({ mode })),
    FailedAsk: ($, { subject, key, message }) =>
      $.evolve({ key: key === null ? null : { subject, value: key }, sending: false }).emit(DockEvents.FailedAsk({ message })),
  },
  view: (h, model) => {
    const { focus, label, down } = h.props;
    const target = h.queries.target;
    const t = AsyncResult.isSuccess(target) && target.value.subject === focus ? Option.some(target.value.promptTarget) : Option.none();
    const route = focus === null ? ""
      : down ? "Service not answering: your draft is kept"
      : Option.match(t, {
        onNone: () => "",
        onSome: (t) => (t.mode === "continue" ? "Continues the conversation · Shift+Enter for a new one" : "Queues a new conversation with an agent"),
      });
    return h.form.class("dock", focus !== null && "locked", down && "off").attrs({ "data-dock": "", autocomplete: "off" })
      .on("submit", DockMessage.SubmittedDraft({ fresh: false }))
      .children(
        h.div.class("dock-meta").children(
          h.span.class("chip").attr("data-chip", "").children(
            ...(focus === null ? ["Nothing in focus: Enter finds"] : [h.span.class("reticle").attr("aria-hidden", "true").children("⌖"), label]),
          ),
          h.span.class("route").attr("data-route", "").children(route),
        ),
        h.div.class("dock-row").children(
          h.textarea
            .attrs({
              "data-prompt": "",
              rows: "1",
              placeholder: "Find anything, or ask about what is in focus",
              "aria-label": "Find or ask",
              "aria-keyshortcuts": focus !== null && !h.props.overlay ? "p Enter" : undefined,
            })
            .value(model.draft)
            .onMount(KeepBar({ draft: model.draft }))
            .on("input", ({ value }) => DockMessage.UpdatedDraft({ value }))
            .on("keydown", ({ key, shift, composing }) =>
              key === "Enter" && shift ? DockMessage.SubmittedDraft({ fresh: true })
                : key === "Enter" && !composing ? DockMessage.SubmittedDraft({ fresh: false })
                : undefined, { preventDefault: true }),
          h.button.class("send").attrs({ type: "submit", "data-send": "" }).disabled(down).children(focus === null ? "Find " : "Ask ", h.kbd("↵")),
        ),
      );
  },
});

export const Dock = DockNoDeps.pipe(
  Component.provide(Layer.mergeAll(AskAgent.layer, GetFocus.layer).pipe(Layer.provide(Overwatch.layer))),
);
