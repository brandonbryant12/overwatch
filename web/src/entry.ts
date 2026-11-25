/** Boots the page: the typed client over the service's own origin, initial theme, and the Foldkit runtime. */
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Runtime } from "foldkit";
import { OverwatchApi } from "../../src/domain/model.ts";
import { Flags, init, Model, subscriptions, update, view, type Theme } from "./app.ts";

function initialTheme(): Theme {
  try {
    const saved = window.localStorage.getItem("overwatch.theme");
    if (saved === "dark" || saved === "light") return saved;
    if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  } catch {
    // Ignore storage access errors in private contexts.
  }
  return "dark";
}

const theme = initialTheme();
document.documentElement.dataset.theme = theme;

const Connection = OverwatchApi.layerClient.pipe(
  Layer.provide(Domain.protocolHttp(`${location.origin}/api`)),
  Layer.provide(FetchHttpClient.layer),
);

Runtime.run(
  Runtime.makeApplication({
    Model,
    Flags,
    init,
    update,
    view,
    subscriptions,
    resources: Connection as never,
    container: document.getElementById("root"),
  }),
  { flags: Effect.succeed({ session: crypto.randomUUID(), theme }) } as never,
);
