/**
 * The inbox rail: the rows as frozen when the owner last looked, by group, with what waits behind "N new". Rows never
 * move while shown; the owner's own actions remove and restore them, and `r` releases what waits.
 */
import { Effect, Schema, Stream } from "effect";
import { Snapshot } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { Command, CompletedMount, defineView, Dom, el, emit, type H, Mount, type Step, TaggedEnum } from "../ui.ts";
import { ClearIcon, SeverityGlyph, Spark } from "./Glyphs.ts";

const Group = Schema.Literals(m.GROUPS);
const Rows = Schema.Array(Schema.String);

export const Props = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  shown: Schema.NullOr(Schema.Struct({ needsYou: Rows, new: Rows, working: Rows, quiet: Rows })),
  collapsed: Schema.Struct({ needsYou: Schema.Boolean, new: Schema.Boolean, working: Schema.Boolean, quiet: Schema.Boolean }),
  focus: Schema.NullOr(Schema.String),
});
export type Props = typeof Props.Type;

export const Model = Schema.Struct({});
export type Model = typeof Model.Type;
export const init: Model = {};

export const Message = TaggedEnum({
  ClickedRow: { id: Schema.String },
  ClickedPending: {},
  ToggledGroup: { group: Group, open: Schema.Boolean },
  CompletedMount: { name: Schema.String },
});
export type Message = typeof Message.Type;

export const Events = TaggedEnum({
  Picked: { id: Schema.String },
  RequestedRefresh: {},
  Toggled: { group: Group, open: Schema.Boolean },
});
export type Events = typeof Events.Type;

export const update = (model: Model, message: Message): Step<Model, Message, Events> =>
  Message.match(message, {
    ClickedRow: ({ id }) => emit(model, Events.Picked({ id })),
    ClickedPending: () => emit(model, Events.RequestedRefresh()),
    ToggledGroup: ({ group, open }) => emit(model, Events.Toggled({ group, open })),
    CompletedMount: () => ({ model }),
  });

/**
 * A group's button says its new state the moment it is pressed, before the next render: a script that opens every
 * group by pressing each closed one in a loop sees each press take effect.
 */
const ShowPress = Mount.defineStream("ShowPress", {
  messages: [CompletedMount],
  execute: ({ element }) =>
    Stream.callback<never>(() =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const press = () => element.setAttribute("aria-expanded", element.getAttribute("aria-expanded") === "true" ? "false" : "true");
          element.addEventListener("click", press);
          return press;
        }),
        (press) => Effect.sync(() => element.removeEventListener("click", press)),
      )),
});

/** The row put in focus scrolls into view, as little as needed. */
export const RevealRow = Command.define("RevealRow", {
  args: { id: Schema.String },
  messages: [Message.CompletedMount],
  execute: ({ id }) =>
    Dom.scrollIntoView(`[data-item-id="${CSS.escape(id)}"]`, { block: "nearest" }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedMount({ name: "RevealRow" })),
    ),
});

const EMPTY: Record<m.Group, string> = {
  needsYou: "No production error waits for you",
  new: "Nothing new",
  working: "No agent work queued",
  quiet: "Nothing has gone quiet",
};

export const view = defineView<Model, Message, Props>((_model, { snapshot, shown, collapsed, focus }, h) => {
  const pending = snapshot !== null && shown !== null ? m.pendingLabel(m.staged(shown, snapshot.inbox)) : null;

  const row = (id: string) => {
    const i = snapshot?.incidents.find((x) => x.id === id);
    if (snapshot === null || i === undefined) return null;
    const unseen = i.lastSeq > (i.seenSeq ?? 0) && i.group !== "quiet";
    const group = (i.group ?? "") as m.Group;
    const left = !(snapshot.inbox.groups[group] ?? []).includes(id);
    const why = i.returned != null && i.way == null ? el(h, "div", { class: ["why", "back"] }, i.returned.reason)
      : i.group === "working" ? el(h, "div", { class: ["why", "working"] }, el(h, "span", { class: "orbit", attrs: { "aria-hidden": "true" } }), "Queued for an agent")
      : i.group === "quiet" ? el(h, "div", { class: ["why", "quiet"] }, "Quiet: nothing new for three checked intervals")
      : null;
    return el(
      h,
      "div",
      {
        class: ["row", `sev-${i.severity}`, focus === id && "focused", unseen && "unseen", left && "left"],
        attrs: { "data-item-id": id, role: "option", "aria-selected": String(focus === id) },
        on: [h.Key(id), h.OnClick(Message.ClickedRow({ id }))],
      },
      el(h, "span", { class: "sev", attrs: { title: i.severity } }, SeverityGlyph(h, i.severity)),
      el(
        h,
        "div",
        { class: "row-body" },
        el(h, "div", { class: "title" }, i.title),
        el(
          h,
          "div",
          { class: "meta" },
          el(h, "span", { class: "place" }, `${i.app} / ${i.environment}`),
          el(h, "span", { class: ["count", !i.exact && "bound"], attrs: { title: i.exact ? "exact" : "at least: part of the time was not fully read" } }, m.countText(i.count, i.exact)),
          el(h, "span", {}, m.ago(i.lastMs, snapshot.atMs)),
        ),
        why,
      ),
      Spark(h, i.spark),
    );
  };

  const groupOf = (g: m.Group, rows: ReadonlyArray<string>, h_: H<Message>) => {
    const open = !collapsed[g];
    const panel = `inbox-${g}-rows`;
    return el(
      h_,
      "section",
      { class: ["group", g], attrs: { "data-group": g }, on: [h_.Key(g)] },
      el(
        h_,
        "button",
        {
          class: "group-head",
          attrs: { "data-toggle": g, "data-panel-open": open ? "" : undefined, type: "button", "aria-expanded": String(open), "aria-controls": open ? panel : undefined },
          on: [h_.OnClick(Message.ToggledGroup({ group: g, open: !open })), h_.OnMount(ShowPress())],
        },
        el(h_, "span", { class: "caret", attrs: { "aria-hidden": "true" } }),
        el(h_, "span", { class: "group-name" }, m.GROUP_LABEL[g]),
        el(h_, "span", { class: "group-count" }, String(rows.length)),
      ),
      el(
        h_,
        "div",
        { class: "group-rows", attrs: { "data-open": open ? "" : undefined, "data-closed": open ? undefined : "", id: panel }, on: [h_.Hidden(!open)] },
        ...(rows.length ? rows.map(row) : [el(h_, "div", { class: "group-empty" }, EMPTY[g])]),
      ),
    );
  };

  const groups = () => {
    if (snapshot === null || shown === null) {
      return [el(h, "div", { class: "loading" }, el(h, "span", { class: "bar" }), el(h, "span", { class: "bar" }), el(h, "span", { class: "bar" }))];
    }
    if (m.GROUPS.every((g) => shown[g].length === 0)) {
      return [
        el(
          h,
          "div",
          { class: "empty-inbox" },
          ClearIcon(h),
          el(h, "b", {}, "Nothing needs you"),
          el(h, "span", {}, "New problems appear here as they are counted. The strip above says what was checked."),
        ),
      ];
    }
    return m.GROUPS.map((g) => groupOf(g, shown[g], h));
  };

  return el(
    h,
    "section",
    { class: "rail", attrs: { "aria-label": "Inbox" } },
    el(
      h,
      "div",
      { class: "rail-head" },
      el(h, "h1", {}, "Inbox"),
      el(
        h,
        "button",
        {
          class: ["pending", pending !== null && !pending.attention && "moves"],
          attrs: { type: "button", "data-pending": "", "data-pending-count": String(pending?.count ?? 0) },
          on: [h.Hidden(pending === null || pending.count === 0), h.OnClick(Message.ClickedPending())],
        },
        ...(pending === null ? [] : [`${pending.text} `, el(h, "kbd", {}, "r")]),
      ),
    ),
    el(h, "div", { class: "groups", attrs: { "data-groups": "" } }, ...groups()),
  );
});
