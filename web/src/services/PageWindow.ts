/** The browser window around the page: a tab opened for the owner, and the page's scroll. */
import { Context, Effect, Layer } from "effect";

export class PageWindow extends Context.Service<PageWindow, {
  /**
   * Opens a tab at once, while the key press still counts as the owner's, then sends it to the address `url` finds;
   * the tab closes again if none is found.
   */
  readonly openTab: <E>(url: Effect.Effect<string, E>) => Effect.Effect<void, E>;
  readonly scrollToTop: Effect.Effect<void>;
}>()("overwatch/PageWindow") {
  static readonly layer = Layer.succeed(PageWindow, {
    openTab: (url) =>
      Effect.acquireUseRelease(
        Effect.sync(() => window.open("about:blank", "_blank")),
        (tab) =>
          Effect.flatMap(url, (href) =>
            Effect.sync(() => {
              if (tab) tab.location.href = href;
              else window.location.href = href;
            })),
        (tab, exit) => (exit._tag === "Failure" ? Effect.sync(() => tab?.close()) : Effect.void),
      ),
    scrollToTop: Effect.sync(() => window.scrollTo({ top: 0 })),
  });
}
