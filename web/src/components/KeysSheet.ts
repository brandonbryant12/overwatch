/** ?: every key the page answers to. */
import { Schema } from "effect";
import { defineView, el, emit, type Step, TaggedEnum } from "../ui.ts";
import { Opening, sheet } from "./Sheet.ts";

const KEY_GROUPS: ReadonlyArray<{ readonly title: string; readonly keys: ReadonlyArray<readonly [string, string]> }> = [
  {
    title: "Navigate & Triage",
    keys: [
      ["j / ↓", "Next row"],
      ["k / ↑", "Previous row"],
      ["d", "Done: back if it happens again"],
      ["l", "Later: until something changes, a time, or worse"],
      ["w", "Later, until it gets worse"],
      ["n", "Never: back only if much worse or more severe"],
      ["u", "Undo the last way out"],
      ["r", "Show what waits behind “N new”"],
    ],
  },
  {
    title: "Inspect & Fix",
    keys: [
      ["p / Enter", "Ask about what is in focus"],
      ["Shift+Enter", "Ask in a new request"],
      ["i", "Investigate: independent readings and a challenger"],
      ["o", "Open in OpenCode, with this in focus"],
      ["c", "Copy structured OpenCode handoff prompt (handles + MCP)"],
      ["Shift+O", "OpenCode handoff sheet with presets"],
      ["g", "Generate or refresh AI visual lens for focused item"],
      ["f", "Fix: ask for a verified candidate"],
      ["Shift+P", "Open the verified candidate's draft pull request"],
      ["y", "Was this right? A line for the app's playbook"],
    ],
  },
  {
    title: "Tools & View",
    keys: [
      ["b", "Brief: what changed, to edit and copy"],
      ["/ or ⌘K", "Find anything, even put away"],
      ["t", "Light or dark"],
      ["Esc", "Close, or leave the bar"],
    ],
  },
];

export const Props = Schema.Struct(Opening);
export type Props = typeof Props.Type;

export const Model = Schema.Struct({});
export type Model = typeof Model.Type;
export const init: Model = {};

export const Message = TaggedEnum({ RequestedCloseDialog: {}, CompletedMount: { name: Schema.String } });
export type Message = typeof Message.Type;
export const Events = TaggedEnum({ RequestedClose: {} });
export type Events = typeof Events.Type;

export const update = (model: Model, message: Message): Step<Model, Message, Events> =>
  Message.match(message, {
    RequestedCloseDialog: () => emit(model, Events.RequestedClose()),
    CompletedMount: () => ({ model }),
  });

export const view = defineView<Model, Message, Props>((_model, { opened }, h) =>
  sheet(
    h,
    {
      opened,
      close: Message.RequestedCloseDialog(),
      mounted: (message) => message,
      popup: { class: ["sheet", "keys-sheet"], attrs: { "aria-label": "Keyboard" } },
    },
    el(h, "h2", {}, "Keyboard"),
    ...KEY_GROUPS.map((group) =>
      el(
        h,
        "section",
        { class: "keys-group" },
        el(h, "h3", {}, group.title),
        el(
          h,
          "dl",
          {},
          ...group.keys.map(([keys, text]) =>
            el(h, "div", {}, el(h, "dt", {}, ...keys.split(" / ").flatMap((k, n) => [n > 0 ? " " : null, el(h, "kbd", {}, k)])), el(h, "dd", {}, text))
          ),
        ),
      )
    ),
  )
);
