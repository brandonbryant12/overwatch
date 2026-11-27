/**
 * / or ⌘K: find problems, findings, evidence and prompts, even what was put away. ↑ and ↓ choose, past the last
 * result loads the next page so every match can be reached, and ↵ puts the choice in focus.
 */
import { Effect, Schema } from "effect";
import { Incident, SearchHit } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { Overwatch } from "../services/Overwatch.ts";
import { Command, defineView, el, emit, Option, run, type Step, TaggedEnum } from "../ui.ts";
import { SearchIcon } from "./Glyphs.ts";
import { Opening, sheet } from "./Sheet.ts";

export const Props = Schema.Struct({
  ...Opening,
  /** What was typed in the bar when the finder opened, searched at once. */
  initialQuery: Schema.String,
  incidents: Schema.Array(Incident),
});
export type Props = typeof Props.Type;

const Results = Schema.Struct({ items: Schema.Array(SearchHit), nextCursor: Schema.NullOr(Schema.String) });

export const Model = Schema.Struct({
  q: Schema.String,
  selected: Schema.Number,
  /** The search being answered: each new query counts up, so a late answer to an earlier one is dropped. */
  search: Schema.Number,
  /** The matches loaded so far, null until the first page answers. */
  results: Schema.NullOr(Results),
  /** The next page, while it is on its way: one request at a time. */
  loadingMore: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = TaggedEnum({
  UpdatedQuery: { value: Schema.String },
  PressedArrow: { delta: Schema.Number },
  PressedEnter: {},
  ClickedResult: { id: Schema.String },
  ClickedMore: {},
  RequestedCloseDialog: {},
  LoadedResults: { search: Schema.Number, items: Schema.Array(SearchHit), nextCursor: Schema.NullOr(Schema.String), more: Schema.Boolean },
  FailedResults: { search: Schema.Number, message: Schema.String },
  CompletedMount: { name: Schema.String },
});
export type Message = typeof Message.Type;

export const Events = TaggedEnum({ Picked: { id: Schema.String }, RequestedClose: {} });
export type Events = typeof Events.Type;

/** One page of matches: the first a moment after the owner stops typing, later ones from the cursor. */
export const Search = Command.define("Search", {
  args: { q: Schema.String, search: Schema.Number, cursor: Schema.NullOr(Schema.String) },
  messages: [Message.LoadedResults, Message.FailedResults],
  execute: ({ q, search, cursor }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      if (cursor === null) yield* Effect.sleep("90 millis");
      return yield* api.search(q, Option.fromNullishOr(cursor));
    }).pipe(
      Effect.match({
        onSuccess: (page) => Message.LoadedResults({ search, items: page.items, nextCursor: page.nextCursor, more: cursor !== null }),
        onFailure: (error) => Message.FailedResults({ search, message: error.message }),
      }),
    ),
});

const query = (model: Model, q: string): Step<Model, Message, never> => {
  const next = { ...model, q, selected: 0, search: model.search + 1, results: null, loadingMore: false, error: null };
  return q.trim() ? run(next, Search({ q, search: next.search, cursor: null })) : { model: next };
};

/** A fresh finder searches what the bar held. */
export const init = (props: Props) => query({ q: "", selected: 0, search: 0, results: null, loadingMore: false, error: null }, props.initialQuery);

const loadMore = (model: Model): Step<Model, Message, never> =>
  model.results?.nextCursor == null || model.loadingMore
    ? { model }
    : run({ ...model, loadingMore: true }, Search({ q: model.q, search: model.search, cursor: model.results.nextCursor }));

export const update = (model: Model, message: Message): Step<Model, Message, Events> =>
  Message.match(message, {
    UpdatedQuery: ({ value }) => query(model, value),
    PressedArrow: ({ delta }): Step<Model, Message, Events> => {
      const items = model.results?.items ?? [];
      if (!items.length) return { model };
      // Moving past the last result loads the next page: every match can be reached.
      if (delta > 0 && model.selected === items.length - 1 && model.results?.nextCursor != null) return loadMore(model);
      return { model: { ...model, selected: Math.min(items.length - 1, Math.max(0, model.selected + delta)) } };
    },
    PressedEnter: () => {
      const hit = model.results?.items[model.selected];
      return hit ? emit(model, Events.Picked({ id: hit.id })) : { model };
    },
    ClickedResult: ({ id }) => emit(model, Events.Picked({ id })),
    ClickedMore: () => loadMore(model),
    RequestedCloseDialog: () => emit(model, Events.RequestedClose()),
    LoadedResults: ({ search, items, nextCursor, more }) => {
      if (search !== model.search) return { model };
      const before = more ? model.results?.items ?? [] : [];
      const known = new Set(before.map((x) => x.id));
      return { model: { ...model, results: { items: [...before, ...items.filter((x) => !known.has(x.id))], nextCursor }, loadingMore: false, error: null } };
    },
    FailedResults: ({ search, message }) => ({ model: search === model.search ? { ...model, loadingMore: false, error: message } : model }),
    CompletedMount: () => ({ model }),
  });

const WAY_LABEL: Record<string, string> = { done: "Done", later: "Later", never: "Never" };

export const view = defineView<Model, Message, Props>((model, props, h) => {
  const where = (id: string) => {
    const i = props.incidents.find((x) => x.id === id);
    return !i ? "" : i.way ? `put away: ${WAY_LABEL[i.way.kind] ?? ""}` : m.GROUP_LABEL[(i.group ?? "") as m.Group] ?? "";
  };
  const results = model.results;
  const list = !model.q.trim() ? []
    : model.error !== null ? [el(h, "li", { class: "no-results" }, model.error || "Search failed")]
    : results !== null
    ? [
      ...(results.items.length
        ? results.items.map((r, n) =>
          el(
            h,
            "li",
            { class: ["result", n === model.selected && "selected"], attrs: { "data-result-id": r.id, role: "option" }, on: [h.Key(r.id), h.OnClick(Message.ClickedResult({ id: r.id }))] },
            el(h, "b", {}, r.title),
            el(h, "span", { class: "where" }, where(r.id)),
            r.excerpt.trim() === r.title.trim() ? null : el(h, "span", { class: "excerpt" }, r.excerpt),
          )
        )
        : [el(h, "li", { class: "no-results" }, `Nothing matches “${model.q}”`)]),
      results.nextCursor === null ? null
        : el(h, "li", { class: "more", attrs: { "data-more": "", role: "option" }, on: [h.OnClick(Message.ClickedMore())] }, "More results ", el(h, "kbd", {}, "↓")),
    ]
    : [];
  return sheet(
    h,
    { opened: props.opened, close: Message.RequestedCloseDialog(), mounted: (message) => message, popup: { class: ["palette"], attrs: { "aria-label": "Find" } } },
    el(
      h,
      "div",
      { class: "palette-input" },
      SearchIcon(h),
      el(h, "input", {
        attrs: { "data-search": "", placeholder: "Find problems, findings, evidence and prompts, even put away", "aria-label": "Find" },
        on: [
          h.Autofocus(true),
          h.Value(model.q),
          h.OnInput((value) => Message.UpdatedQuery({ value })),
          h.OnKeyDownPreventDefault((key) =>
            key === "ArrowDown" ? Option.some(Message.PressedArrow({ delta: 1 }))
              : key === "ArrowUp" ? Option.some(Message.PressedArrow({ delta: -1 }))
              : key === "Enter" ? Option.some(Message.PressedEnter())
              : Option.none()
          ),
        ],
      }),
    ),
    el(h, "ul", { class: "results", attrs: { "data-results": "", role: "listbox" } }, ...list),
    el(
      h,
      "footer",
      {},
      el(h, "span", {}, el(h, "kbd", {}, "↑"), el(h, "kbd", {}, "↓"), " choose"),
      el(h, "span", {}, el(h, "kbd", {}, "↵"), " focus"),
      el(h, "span", {}, el(h, "kbd", {}, "Esc"), " close"),
    ),
  );
});
