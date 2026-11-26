/** ?: every key the page answers to. */
import { UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Dialog } from "@effect/ui-kit";
import { Schema } from "effect";

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["j / ↓", "Next row"], ["k / ↑", "Previous row"], ["d", "Done: back if it happens again"], ["l", "Later: until something changes, a time, or worse"],
  ["w", "Later, until it gets worse"], ["n", "Never: back only if much worse or more severe"], ["u", "Undo the last way out"], ["r", "Show what waits behind “N new”"],
  ["p / Enter", "Ask about what is in focus"], ["i", "Investigate: independent readings and a challenger"], ["o", "Open in OpenCode, with this in focus"],
  ["f", "Fix: ask for a verified candidate"], ["Shift+P", "Open the verified candidate's draft pull request"], ["y", "Was this right? A line for the app's playbook"],
  ["b", "Brief: what changed, to edit and copy"], ["Shift+Enter", "Ask in a new request"], ["/ or ⌘K", "Find anything, even put away"], ["t", "Light or dark"],
  ["Esc", "Close, or leave the bar"],
];

const KeysSheetMessage = UiSchema.TaggedEnum({ RequestedCloseDialog: {} });
export const KeysSheetEvents = UiSchema.TaggedEnum({ RequestedClose: {} });

export const KeysSheet = Html.component({
  name: "KeysSheet",
  model: Schema.Struct({}),
  message: KeysSheetMessage,
  events: KeysSheetEvents,
}).make({
  init: () => ({}),
  update: { RequestedCloseDialog: ($) => $.emit(KeysSheetEvents.RequestedClose()) },
  view: (h) =>
    Dialog(h, {
      props: { open: true },
      onEmit: { RequestedOpen: () => undefined, RequestedClose: () => KeysSheetMessage.RequestedCloseDialog(), Settled: () => undefined },
      view: (dialog) =>
        dialog.portal(h.dialog)?.children(
          dialog.backdrop(h.div.class("backdrop").attr("data-close", "")),
          dialog.popup(h.div.class("sheet", "keys-sheet").attrs({ role: "dialog", "aria-modal": "true", "aria-label": "Keyboard" })).children(
            h.h2("Keyboard"),
            h.dl(
              ...KEYS.map(([keys, text]) =>
                h.div(h.dt(...keys.split(" / ").flatMap((k, n) => [n > 0 ? " " : null, h.kbd(k)])), h.dd(text))
              ),
            ),
          ),
        ) ?? h.text(""),
    }),
});
