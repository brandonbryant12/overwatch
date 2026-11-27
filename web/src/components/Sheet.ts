/**
 * A sheet over the page, as a native modal `<dialog>`: shown when its element mounts and closed when it leaves, so its
 * lifetime is exactly the overlay's. The browser keeps focus inside, makes the page behind inert, focuses the
 * element marked autofocus (else the first focusable one) and gives focus back on close; Foldkit's scroll lock keeps the
 * page still. Escape and the cancel request ask to close (`close`), as does a press on the backdrop.
 */
import { Effect, Schema } from "effect";
import { CompletedMount, Dom, el, type H, type Html, Mount } from "../ui.ts";

/** Shows the dialog modally while its element lives; the page behind stops scrolling meanwhile. */
const ShowSheet = Mount.define("ShowSheet", {
  messages: [CompletedMount],
  execute: ({ element }) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const dialog = element as HTMLDialogElement;
          if (!dialog.open) dialog.showModal();
          return dialog;
        }),
        (dialog) => Effect.sync(() => dialog.open && dialog.close()),
      );
      yield* Effect.acquireRelease(Dom.lockScroll, () => Dom.unlockScroll);
      return CompletedMount({ name: "ShowSheet" });
    }),
});

/** What every sheet is given: which opening it is. */
export const Opening = { opened: Schema.String };

/** The dialog is a fixed, invisible frame; the backdrop and the popup inside it are drawn by the stylesheet. */
const FRAME = {
  position: "fixed",
  inset: "0",
  width: "0",
  height: "0",
  "max-width": "none",
  "max-height": "none",
  margin: "0",
  padding: "0",
  border: "0",
  overflow: "visible",
  background: "transparent",
  color: "inherit",
};

export const sheet = <M>(
  h: H<M>,
  options: {
    /** Which opening this is: each opening is a new dialog, shown and focused afresh. */
    readonly opened: string;
    readonly close: M;
    /** The sheet's own name for the Message a Mount sends once the dialog is shown (`CompletedMount`). */
    readonly mounted: (message: CompletedMount) => M;
    /** The id of the sheet's title, when it has one. */
    readonly labelledBy?: string;
    readonly popup: { readonly class: ReadonlyArray<string>; readonly attrs?: Readonly<Record<string, string>> };
  },
  ...children: ReadonlyArray<Html | false | null>
) =>
  el(
    h,
    "dialog",
    { attrs: { "aria-labelledby": options.labelledBy }, on: [h.Key(options.opened), h.Style(FRAME), h.OnMount(Mount.mapMessage(ShowSheet(), options.mounted)), h.OnCancel(options.close)] },
    el(h, "div", { class: "backdrop", attrs: { "data-close": "", "data-open": "", role: "presentation" }, on: [h.OnClick(options.close)] }),
    el(h, "div", { class: [...options.popup.class], attrs: { role: "dialog", "aria-modal": "true", "data-open": "", tabindex: "-1", ...options.popup.attrs } }, ...children),
  );
