/**
 * Boots the page: reads what this browser remembers (the theme the head script applied, which groups are open), then
 * mounts the page over the service's own origin for as long as the document lives.
 */
import { BrowserKeyValueStore } from "@effect/platform-browser";
import { BrowserHost } from "@effect/ui/html";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { KeyValueStore } from "effect/persistence";
import { App, Theme } from "./App.ts";

/** Which groups the owner opened or closed last time; Working and Quiet start closed. */
const Remembered = Schema.fromJsonString(Schema.Struct({
  needsYou: Schema.optionalKey(Schema.Boolean),
  new: Schema.optionalKey(Schema.Boolean),
  working: Schema.optionalKey(Schema.Boolean),
  quiet: Schema.optionalKey(Schema.Boolean),
}));

const props = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const groups = yield* store.get("ow-groups").pipe(
    Effect.map((text) => Option.flatMap(Option.fromNullishOr(text), Schema.decodeUnknownOption(Remembered))),
    Effect.orElseSucceed(() => Option.none()),
  );
  const remembered = Option.getOrElse(groups, () => ({}));
  return {
    initialTheme: Schema.decodeUnknownOption(Theme)(document.documentElement.dataset.theme).pipe(Option.getOrNull),
    initialCollapsed: { needsYou: false, new: false, working: true, quiet: true, ...remembered },
    now: { wallMs: yield* Clock.currentTimeMillis, monoMs: Number(yield* Clock.currentTimeNanos) / 1e6 },
  };
}).pipe(Effect.provide(BrowserKeyValueStore.layerLocalStorage));

/**
 * Effect UI's browser host keeps each element's handler record on the element as `$r`. Kept enumerable, a tool that
 * reads an element by value (the DevTools protocol, as the acceptance suite does) walks from it into the whole
 * component tree and gives up. The record is kept where the host puts it, only out of enumeration.
 */
Object.defineProperty(Node.prototype, "$r", {
  configurable: true,
  get: () => undefined,
  set(this: Node, record: unknown) {
    Object.defineProperty(this, "$r", { value: record, writable: true, configurable: true, enumerable: false });
  },
});

const Main = BrowserHost.mount(App, props, document.getElementById("app")!).pipe(Layer.provide(FetchHttpClient.layer));

Layer.launch(Main).pipe(Effect.runFork);
