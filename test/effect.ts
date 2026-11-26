/**
 * Running Effect programs in `node:test`: the Node platform services, a database owned for one test, and the
 * configuration as a service.
 */
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { AppConfig, type Config } from "../src/config.ts";
import { Store, type StoreShape } from "../src/store.ts";

/** The services every test program may use: file system, path, child processes and an HTTP client. */
export const Platform = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
type PlatformServices = Layer.Success<typeof Platform>;

/** Runs a program to its value (or its failure, thrown), with the platform services and a scope. */
export const run = <A, E>(program: Effect.Effect<A, E, PlatformServices | import("effect").Scope.Scope>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Platform)) as Effect.Effect<A, E>);

/** Owns the database in `dir` for the length of `body`, which reads it as the `Store` service. */
export const withStore = <A, E, R>(dir: string, body: (store: StoreShape) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(Store.own(dir), (store) => body(store).pipe(Effect.provideService(Store, store))));

/** Provides the configuration as `AppConfig`. */
export const withConfig = (config: Config) => Effect.provide(AppConfig.layer(config));
