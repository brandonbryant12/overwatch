/**
 * The inbox rail: the rows as frozen when the owner last looked, by group, with what waits behind "N new". Rows never
 * move while shown; the owner's own actions remove and restore them, and `r` releases what waits.
 */
import { Component, Mount, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Collapsible } from "@effect/ui-kit";
import { Effect, Schema, Stream } from "effect";
import { Snapshot } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { ClearIcon, SeverityGlyph, Spark } from "./Glyphs.ts";

const Group = Schema.Literals(m.GROUPS);
const Rows = Schema.Array(Schema.String);

export const InboxProps = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  shown: Schema.NullOr(Schema.Struct({ needsYou: Rows, new: Rows, working: Rows, quiet: Rows })),
  collapsed: Schema.Struct({ needsYou: Schema.Boolean, new: Schema.Boolean, working: Schema.Boolean, quiet: Schema.Boolean }),
  focus: Schema.NullOr(Schema.String),
});

const InboxMessage = UiSchema.TaggedEnum({
  ClickedRow: { id: Schema.String },
  ClickedPending: {},
  ToggledGroup: { group: Group, open: Schema.Boolean },
});

export const InboxEvents = UiSchema.TaggedEnum({
  Picked: { id: Schema.String },
  RequestedRefresh: {},
  Toggled: { group: Group, open: Schema.Boolean },
});

/**
 * A group's button says its new state the moment it is pressed, before the next render: a script that opens every
 * group by pressing each closed one in a loop sees each press take effect.
 */
const ShowPress = Mount.makeStream("ShowPress", { args: {} }, (node: HTMLElement) =>
  Stream.callback<never>((_queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const press = () => node.setAttribute("aria-expanded", node.getAttribute("aria-expanded") === "true" ? "false" : "true");
        node.addEventListener("click", press);
        return press;
      }),
      (press) => Effect.sync(() => node.removeEventListener("click", press)),
    )));

/** The row put in focus scrolls into view, as little as needed. */
const RevealRow = Mount.make("RevealRow", { args: {} }, (node: HTMLElement) =>
  Effect.sync(() => node.scrollIntoView({ block: "nearest" })).pipe(Effect.as(Component.noop)));

const EMPTY: Record<m.Group, string> = {
  needsYou: "No production error waits for you",
  new: "Nothing new",
  working: "No agent work queued",
  quiet: "Nothing has gone quiet",
};

export const Inbox = Html.component({
  name: "Inbox",
  props: InboxProps,
  model: Schema.Struct({}),
  message: InboxMessage,
  events: InboxEvents,
}).make({
  init: () => ({}),
  update: {
    ClickedRow: ($, { id }) => $.emit(InboxEvents.Picked({ id })),
    ClickedPending: ($) => $.emit(InboxEvents.RequestedRefresh()),
    ToggledGroup: ($, { group, open }) => $.emit(InboxEvents.Toggled({ group, open })),
  },
  view: (h) => {
    const { snapshot, shown, collapsed, focus } = h.props;
    const pending = snapshot !== null && shown !== null ? m.pendingLabel(m.staged(shown, snapshot.inbox)) : null;

    const row = (id: string) => {
      const i = snapshot?.incidents.find((x) => x.id === id);
      if (snapshot === null || i === undefined) return null;
      const unseen = i.lastSeq > (i.seenSeq ?? 0) && i.group !== "quiet";
      const group = (i.group ?? "") as m.Group;
      const left = !(snapshot.inbox.groups[group] ?? []).includes(id);
      const why = i.returned != null && i.way == null ? h.div.class("why", "back").children(i.returned.reason)
        : i.group === "working" ? h.div.class("why", "working").children(h.span.class("orbit").attr("aria-hidden", "true"), "Queued for an agent")
        : i.group === "quiet" ? h.div.class("why", "quiet").children("Quiet: nothing new for three checked intervals")
        : null;
      const element = h.div
        .key(id)
        .class("row", `sev-${i.severity}`, focus === id && "focused", unseen && "unseen", left && "left")
        .attrs({ "data-item-id": id, role: "option", "aria-selected": String(focus === id) })
        .on("click", InboxMessage.ClickedRow({ id }));
      return (focus === id ? element.onMount(RevealRow()) : element).children(
        h.span.class("sev").attr("title", i.severity).children(SeverityGlyph(h, i.severity)),
        h.div.class("row-body").children(
          h.div.class("title").children(i.title),
          h.div.class("meta").children(
            h.span.class("place").children(`${i.app} / ${i.environment}`),
            h.span.class("count", !i.exact && "bound").attr("title", i.exact ? "exact" : "at least: part of the time was not fully read").children(m.countText(i.count, i.exact)),
            h.span(m.ago(i.lastMs, snapshot.atMs)),
          ),
          why,
        ),
        Spark(h, i.spark),
      );
    };

    const groups = () => {
      if (snapshot === null || shown === null) {
        return [h.div.class("loading").children(h.span.class("bar"), h.span.class("bar"), h.span.class("bar"))];
      }
      if (m.GROUPS.every((g) => shown[g].length === 0)) {
        return [
          h.div.class("empty-inbox").children(
            ClearIcon(h),
            h.b("Nothing needs you"),
            h.span("New problems appear here as they are counted. The strip above says what was checked."),
          ),
        ];
      }
      return m.GROUPS.map((g) =>
        Collapsible(h, {
          key: g,
          props: { open: !collapsed[g], keepMounted: true },
          onEmit: {
            Toggled: ({ open }) => InboxMessage.ToggledGroup({ group: g, open }),
            Settled: () => undefined,
          },
          view: (collapsible) =>
            h.section.class("group", g).attr("data-group", g).children(
              collapsible.trigger(h.button.class("group-head").attr("data-toggle", g)).onMount(ShowPress()).children(
                h.span.class("caret").attr("aria-hidden", "true"),
                h.span.class("group-name").children(m.GROUP_LABEL[g]),
                h.span.class("group-count").children(String(shown[g].length)),
              ),
              collapsible.panel(h.div.class("group-rows"))?.children(
                ...(shown[g].length ? shown[g].map(row) : [h.div.class("group-empty").children(EMPTY[g])]),
              ),
            ),
        })
      );
    };

    return h.section.class("rail").attr("aria-label", "Inbox").children(
      h.div.class("rail-head").children(
        h.h1("Inbox"),
        h.button
          .class("pending", pending !== null && !pending.attention && "moves")
          .attrs({
            type: "button",
            "data-pending": "",
            "data-pending-count": String(pending?.count ?? 0),
            hidden: pending === null || pending.count === 0 ? "" : undefined,
          })
          .on("click", InboxMessage.ClickedPending())
          .children(...(pending === null ? [] : [`${pending.text} `, h.kbd("r")])),
      ),
      h.div.class("groups").attr("data-groups", "").children(...groups()),
    );
  },
});
