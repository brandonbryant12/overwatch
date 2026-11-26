/**
 * / or ⌘K: find problems, findings, evidence and prompts, even what was put away. ↑ and ↓ choose, past the last
 * result loads the next page so every match can be reached, and ↵ puts the choice in focus.
 */
import { Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Dialog } from "@effect/ui-kit";
import { Layer, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Incident } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { SearchItems } from "../queries/SearchItems.ts";
import { Overwatch } from "../services/Overwatch.ts";
import { SearchIcon } from "./Glyphs.ts";

export const FinderProps = Schema.Struct({
  /** What was typed in the bar when the finder opened, searched at once. */
  initialQuery: Schema.String,
  incidents: Schema.Array(Incident),
});

const FinderMessage = UiSchema.TaggedEnum({
  UpdatedQuery: { value: Schema.String },
  PressedArrow: { delta: Schema.Number },
  PressedEnter: {},
  ClickedResult: { id: Schema.String },
  ClickedMore: {},
  RequestedCloseDialog: {},
});

export const FinderEvents = UiSchema.TaggedEnum({ Picked: { id: Schema.String }, RequestedClose: {} });

const WAY_LABEL: Record<string, string> = { done: "Done", later: "Later", never: "Never" };

/** The matches loaded so far, and whether more can be loaded. */
const loaded = (result: AsyncResult.AsyncResult<{ readonly items: ReadonlyArray<{ readonly id: string }>; readonly more: { readonly _tag: string } }, unknown>) =>
  AsyncResult.isSuccess(result) ? { items: result.value.items, more: result.value.more._tag === "Available" } : { items: [], more: false };

export const FinderNoDeps = Html.component({
  name: "Finder",
  props: FinderProps,
  model: Schema.Struct({ q: Schema.String, selected: Schema.Number }),
  message: FinderMessage,
  events: FinderEvents,
  queries: {
    results: { query: SearchItems, debounce: "90 millis", args: ({ model }) => (model.q.trim() ? { q: model.q } : undefined) },
  },
}).make({
  init: ($) => ({ q: $.props.initialQuery, selected: 0 }),
  update: {
    UpdatedQuery: ($, { value }) => $.evolve({ q: value, selected: 0 }),
    PressedArrow: ($, { delta }) => {
      const { items, more } = loaded($.queries.results);
      if (!items.length) return $.model;
      // Moving past the last result loads the next page: every match can be reached.
      if (delta > 0 && $.model.selected === items.length - 1 && more) return $.loadMore("results");
      return $.evolve({ selected: Math.min(items.length - 1, Math.max(0, $.model.selected + delta)) });
    },
    PressedEnter: ($) => {
      const hit = loaded($.queries.results).items[$.model.selected];
      return hit ? $.emit(FinderEvents.Picked({ id: hit.id })) : $.model;
    },
    ClickedResult: ($, { id }) => $.emit(FinderEvents.Picked({ id })),
    ClickedMore: ($) => (loaded($.queries.results).more ? $.loadMore("results") : $.model),
    RequestedCloseDialog: ($) => $.emit(FinderEvents.RequestedClose()),
  },
  view: (h, model) => {
    const where = (id: string) => {
      const i = h.props.incidents.find((x) => x.id === id);
      return !i ? "" : i.way ? `put away: ${WAY_LABEL[i.way.kind] ?? ""}` : m.GROUP_LABEL[(i.group ?? "") as m.Group] ?? "";
    };
    const results = h.queries.results;
    const list = !model.q.trim() ? []
      : AsyncResult.isFailure(results) ? [h.li.class("no-results").children(results.cause.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error.message] : []))[0] ?? "Search failed")]
      : AsyncResult.isSuccess(results)
      ? [
        ...(results.value.items.length
          ? results.value.items.map((r, n) =>
            h.li.key(r.id).class("result", n === model.selected && "selected").attrs({ "data-result-id": r.id, role: "option" })
              .on("click", FinderMessage.ClickedResult({ id: r.id }))
              .children(h.b(r.title), h.span.class("where").children(where(r.id)), r.excerpt.trim() === r.title.trim() ? null : h.span.class("excerpt").children(r.excerpt))
          )
          : [h.li.class("no-results").children(`Nothing matches “${model.q}”`)]),
        results.value.more._tag === "End" ? null
          : h.li.class("more").attrs({ "data-more": "", role: "option" }).on("click", FinderMessage.ClickedMore()).children("More results ", h.kbd("↓")),
      ]
      : [];
    return Dialog(h, {
      props: { open: true },
      onEmit: { RequestedOpen: () => undefined, RequestedClose: () => FinderMessage.RequestedCloseDialog(), Settled: () => undefined },
      view: (dialog) =>
        dialog.portal(h.dialog)?.children(
          dialog.backdrop(h.div.class("backdrop").attr("data-close", "")),
          dialog.popup(h.div.class("palette").attrs({ role: "dialog", "aria-modal": "true", "aria-label": "Find" })).children(
            h.div.class("palette-input").children(
              SearchIcon(h),
              dialog.initialFocus(h.input)
                .attrs({ "data-search": "", placeholder: "Find problems, findings, evidence and prompts, even put away", "aria-label": "Find" })
                .value(model.q)
                .on("input", ({ value }) => FinderMessage.UpdatedQuery({ value }))
                .on("keydown", ({ key }) =>
                  key === "ArrowDown" ? FinderMessage.PressedArrow({ delta: 1 })
                    : key === "ArrowUp" ? FinderMessage.PressedArrow({ delta: -1 })
                    : key === "Enter" ? FinderMessage.PressedEnter()
                    : undefined, { preventDefault: true }),
            ),
            h.ul.class("results").attrs({ "data-results": "", role: "listbox" }).children(...list),
            h.footer(
              h.span(h.kbd("↑"), h.kbd("↓"), " choose"),
              h.span(h.kbd("↵"), " focus"),
              h.span(h.kbd("Esc"), " close"),
            ),
          ),
        ) ?? h.text(""),
    });
  },
});

export const Finder = FinderNoDeps.pipe(Component.provide(SearchItems.layer.pipe(Layer.provide(Overwatch.layer))));
