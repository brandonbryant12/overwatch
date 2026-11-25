/** Boots the page: the typed client over the service's own origin, and the Foldkit runtime. */
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Runtime } from "foldkit";
import { OverwatchApi } from "../../src/domain/model.ts";
import { Flags, init, Model, subscriptions, update, view } from "./app.ts";

const Connection = OverwatchApi.layerClient.pipe(Layer.provide(Domain.protocolHttp(`${location.origin}/api`)), Layer.provide(FetchHttpClient.layer));

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
  { flags: Effect.succeed({ session: crypto.randomUUID() }) } as never,
);
