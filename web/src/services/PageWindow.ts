/** The browser window around the page: a tab opened for the owner, the page's scroll, and evidence reveal jumps. */
import { Context, Effect, Layer } from "effect";

const flashTimers = new WeakMap<HTMLElement, number>();
const EVIDENCE_FLASH_MS = 1400;

export class PageWindow extends Context.Service<PageWindow, {
  /**
   * Opens a tab at once, while the key press still counts as the owner's, then sends it to the address `url` finds;
   * the tab closes again if none is found.
   */
  readonly openTab: <E>(url: Effect.Effect<string, E>) => Effect.Effect<void, E>;
  readonly scrollToTop: Effect.Effect<void>;
  /**
   * Finds the evidence card matching `handle` (`[data-handle="e_..."]`), auto-opens any collapsed ancestor
   * `<details>`, scrolls it smoothly into view, and applies a ~1.4s `.evidence-flash` highlight pulse.
   */
  readonly revealEvidence: (handle: string) => Effect.Effect<boolean>;
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
    revealEvidence: (handle) =>
      Effect.sync(() => {
        const cards = Array.from(document.querySelectorAll<HTMLElement>("figure.evidence[data-handle]"));
        const target = cards.find((el) => el.dataset.handle === handle)
          ?? Array.from(document.querySelectorAll<HTMLElement>("[data-handle]"))
            .find((el) => el.dataset.handle === handle && !el.classList.contains("lens-handle"))
            ?.closest<HTMLElement>("figure.evidence")
          ?? null;
        if (!target) return false;
        let cur: HTMLElement | null = target.parentElement;
        while (cur !== null) {
          if (cur instanceof HTMLDetailsElement) cur.open = true;
          cur = cur.parentElement;
        }
        const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
        const prior = flashTimers.get(target);
        if (prior !== undefined) window.clearTimeout(prior);
        target.classList.remove("evidence-flash");
        void target.offsetWidth;
        target.classList.add("evidence-flash");
        const timer = window.setTimeout(() => {
          target.classList.remove("evidence-flash");
          flashTimers.delete(target);
        }, EVIDENCE_FLASH_MS);
        flashTimers.set(target, timer);
        return true;
      }),
  });
}
