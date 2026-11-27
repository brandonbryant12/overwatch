/**
 * Boots the page: reads what this browser remembers (the theme the head script applied, which groups are open), then
 * runs the page over the service's own origin for as long as the document lives.
 */
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { KeyValueStore } from "effect/persistence";
import { Runtime } from "foldkit";
import { AppLayer, AppModel, AppProps, init, subscriptions, Theme, update, view } from "./App.ts";

/** Which groups the owner opened or closed last time; Working and Quiet start closed. */
const Remembered = Schema.fromJsonString(Schema.Struct({
  needsYou: Schema.optionalKey(Schema.Boolean),
  new: Schema.optionalKey(Schema.Boolean),
  working: Schema.optionalKey(Schema.Boolean),
  quiet: Schema.optionalKey(Schema.Boolean),
}));

const RememberedCaughtUp = Schema.fromJsonString(Schema.Struct({
  seq: Schema.Number,
  atMs: Schema.Number,
}));

const flags = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const groups = yield* store.get("ow-groups").pipe(
    Effect.map((text) => Option.flatMap(Option.fromNullishOr(text), Schema.decodeUnknownOption(Remembered))),
    Effect.orElseSucceed(() => Option.none()),
  );
  const caughtUp = yield* store.get("ow-caught-up").pipe(
    Effect.map((text) => Option.flatMap(Option.fromNullishOr(text), Schema.decodeUnknownOption(RememberedCaughtUp))),
    Effect.orElseSucceed(() => Option.none()),
  );
  const remembered = Option.getOrElse(groups, () => ({}));
  return {
    initialTheme: Schema.decodeUnknownOption(Theme)(document.documentElement.dataset.theme).pipe(Option.getOrNull),
    initialCollapsed: { needsYou: false, new: false, working: true, quiet: true, ...remembered },
    initialCaughtUp: Option.getOrNull(caughtUp),
    now: { wallMs: yield* Clock.currentTimeMillis, monoMs: Number(yield* Clock.currentTimeNanos) / 1e6 },
  };
});

/**
 * Foldkit paints on the next animation frame; Effect UI, like the page's contract, paints in the same task as the
 * Message (a microtask). The acceptance suites read the page straight after a key press, and a key that moves focus
 * or opens a sheet must show it before the next key, so the frame callbacks this page asks for run as microtasks.
 * Nothing else here asks for frames.
 */
const frames = new Set<number>();
let frame = 0;
window.requestAnimationFrame = (callback) => {
  const id = ++frame;
  frames.add(id);
  queueMicrotask(() => frames.delete(id) && callback(performance.now()));
  return id;
};
window.cancelAnimationFrame = (id) => void frames.delete(id);

/**
 * Requests go through the window's `fetch` as it is when each one is sent, not as it was when the first one went out
 * (Effect's default keeps the first): a script that wraps `fetch` later sees every request after it.
 */
const HttpClient = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, (input, init) => globalThis.fetch(input, init))));

const application = Runtime.makeApplication({
  Model: AppModel,
  Flags: AppProps,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("app"),
  resources: AppLayer.pipe(Layer.provide(HttpClient)),
});

Runtime.run(application, { flags });
