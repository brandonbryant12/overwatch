/**
 * OpenCode 2.4.1 over its HTTP API, through Effect's `HttpClient`: the whole of Overwatch's dependence on OpenCode is
 * this file. Sessions and messages are created with identifiers Overwatch chose and recorded first, so repeating a
 * request repeats the same idempotent action. Every reply is decoded by a Schema.
 */
import { Context, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { AppConfig } from "./config.ts";
import { PeerError, Unavailable } from "./errors.ts";
import { secret } from "./exec.ts";
import type { Permit } from "./store.ts";

export { Unavailable };

export interface Message {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly outcome: string | null;
}

/** After our message `id`: whether the session has gone idle, and what the model said. */
export function after(history: ReadonlyArray<Message>, id: string): { idle: boolean; outcome: string | null; said: string } {
  const i = history.findIndex((m) => m.id === id);
  const later = i < 0 ? [] : history.slice(i + 1);
  const idle = later.find((m) => m.type === "idle");
  return { idle: Boolean(idle), outcome: idle?.outcome ?? null, said: later.filter((m) => m.type === "assistant").map((m) => m.text).join("\n") };
}

// ---- the replies, as OpenCode 2.4.1 sends them

const Registered = Schema.Struct({ url: Schema.String, password: Schema.optionalKey(Schema.String) });
const Info = Schema.Struct({ version: Schema.optionalKey(Schema.String) });
/** A catalog (agents, MCP servers, skills): its entries as given, for the doctor to judge. */
const Catalog = Schema.Struct({ data: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))) });
const Part = Schema.Struct({ text: Schema.optionalKey(Schema.NullOr(Schema.String)) });
const MessageRow = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Part)),
  outcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Messages = Schema.Struct({ data: Schema.optionalKey(Schema.Array(MessageRow)) });
const Session = Schema.Struct({ data: Schema.optionalKey(Schema.Struct({ url: Schema.optionalKey(Schema.String) })) });
const Anything = Schema.Unknown;

/** The empty, read-only folder sessions work in. */
export const emptyFolder = (dataDir: string): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(dataDir, "empty");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.chmod(dir, 0o555);
    return dir;
  }).pipe(Effect.orDie);

export interface Registration {
  readonly url: string;
  readonly password: Redacted.Redacted<string> | null;
}

/**
 * Where OpenCode answers and the password it requires. OpenCode always requires Basic `opencode:<password>`; its
 * service mode registers both in `$XDG_STATE_HOME/opencode/service.json` (mode 0600). A configured URL and password
 * reference win; under plain `opencode serve` set `opencode.password` to the OPENCODE_PASSWORD it runs with.
 */
export const registration: Effect.Effect<Registration | null, never, FileSystem.FileSystem | Path.Path> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { homedir } = yield* Effect.sync(() => process.getBuiltinModule("node:os"));
  const file = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "opencode", "service.json");
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Registered))(yield* fs.readFileString(file));
  return { url: value.url.replace(/\/+$/, ""), password: value.password === undefined ? null : Redacted.make(value.password) };
}).pipe(Effect.orElseSucceed(() => null));

/** One OpenCode peer, configured or registered. Writes (a session, a message, an interrupt) each spend a permit first. */
export interface OpenCode {
  readonly url: string;
  readonly info: Effect.Effect<{ readonly version?: string }, Unavailable | PeerError>;
  /** Catalogs are per location: ask about the folder Overwatch's sessions work in. */
  readonly agents: (directory: string) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, Unavailable | PeerError>;
  readonly mcp: (directory: string) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, Unavailable | PeerError>;
  readonly skills: (directory: string) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, Unavailable | PeerError>;
  /** The session's URL when OpenCode gives one. */
  readonly createSession: (
    permit: Permit,
    input: { readonly id: string; readonly title: string; readonly agent: string | null; readonly model: string | null; readonly directory: string },
  ) => Effect.Effect<{ readonly url: string | null }, Unavailable | PeerError>;
  readonly prompt: (permit: Permit, session: string, input: { readonly id: string; readonly text: string }) => Effect.Effect<void, Unavailable | PeerError>;
  /** The session's history, oldest first. */
  readonly messages: (session: string) => Effect.Effect<Message[], Unavailable | PeerError>;
  /** Whether the peer knows this session. */
  readonly exists: (session: string) => Effect.Effect<boolean>;
  /** Asks the peer to stop a session; whatever it answers. */
  readonly interrupt: (permit: Permit, session: string) => Effect.Effect<void>;
}

/** The OpenCode to use: the configured one, or the one that registered itself; null when there is neither. */
export class OpenCodeClient extends Context.Service<OpenCodeClient, { readonly connect: Effect.Effect<OpenCode | null> }>()("overwatch/OpenCodeClient") {
  static readonly layer = Layer.effect(
    OpenCodeClient,
    Effect.gen(function* () {
      const config = (yield* AppConfig).opencode;
      const http = yield* HttpClient.HttpClient;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const registered = registration.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));

      /** `password` is a secret reference, read on each call; `fallback` a password from OpenCode's own registration. */
      const peer = (url: string, password: string | null, fallback: Redacted.Redacted<string> | null): OpenCode => {
        const auth = password ? secret(password).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)) : Effect.succeed(fallback);
        const call = <A, I>(schema: Schema.ConstraintCodec<A, I, never, never>, path: string, body?: unknown): Effect.Effect<A, Unavailable | PeerError> =>
          Effect.gen(function* () {
            let request = (body === undefined ? HttpClientRequest.get(url + path) : HttpClientRequest.post(url + path).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(HttpClientRequest.acceptJson);
            const value = yield* auth;
            if (value) request = HttpClientRequest.basicAuth(request, "opencode", value);
            const response = yield* http.execute(request).pipe(
              Effect.mapError((e) => new Unavailable({ message: `OpenCode is not answering at ${url} (${e.message})` })),
            );
            if (response.status >= 500 || response.status < 200 || response.status >= 300) {
              yield* response.text.pipe(Effect.ignore);
              return yield* response.status >= 500
                ? new Unavailable({ message: `OpenCode answered ${response.status}` })
                : new PeerError({ message: `OpenCode answered ${response.status} for ${path.replace(/\/session\/[^/?]+/, "/session/…")}` });
            }
            return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
              Effect.mapError((e) => new PeerError({ message: `OpenCode's reply to ${path.replace(/\/session\/[^/?]+/, "/session/…")} could not be read (${e.message})` })),
            );
          }).pipe(
            Effect.timeoutOption("30 seconds"),
            Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Unavailable({ message: `OpenCode is not answering at ${url} (timed out after 30 s)` })), onSome: Effect.succeed })),
          );
      const at = (route: string) => (directory: string) => call(Catalog, `${route}?location[directory]=${encodeURIComponent(directory)}`).pipe(Effect.map((c) => c.data ?? []));
      const session = (id: string) => `/api/session/${encodeURIComponent(id)}`;
      const spend = (permit: Permit) => Effect.sync(() => permit.spend("peer"));
      return {
        url,
        info: call(Info, "/api/info"),
        agents: at("/api/agent"),
        mcp: at("/api/mcp"),
        skills: at("/api/skill"),
        createSession: (permit, input) =>
          Effect.gen(function* () {
            yield* spend(permit);
            const slash = input.model?.indexOf("/") ?? -1;
            const model = input.model && slash > 0 ? { providerID: input.model.slice(0, slash), id: input.model.slice(slash + 1) } : null;
            const made = yield* call(Session, "/api/session", {
              id: input.id, title: input.title, location: { directory: input.directory }, ...(input.agent ? { agent: input.agent } : {}), ...(model ? { model } : {}),
            });
            return { url: made.data?.url ?? null };
          }),
        prompt: (permit, id, input) => spend(permit).pipe(Effect.andThen(call(Anything, `${session(id)}/prompt`, { id: input.id, text: input.text })), Effect.asVoid),
        messages: (id) =>
          call(Messages, `${session(id)}/message?order=desc&limit=200`).pipe(
            Effect.map((m) =>
              (m.data ?? [])
                .map((row) => ({ id: row.id ?? "", type: row.type ?? "", text: (row.content ?? []).map((c) => c.text ?? "").join(""), outcome: row.outcome ?? null }))
                .reverse(),
            ),
          ),
        exists: (id) => call(Anything, session(id)).pipe(Effect.as(true), Effect.orElseSucceed(() => false)),
        interrupt: (permit, id) => spend(permit).pipe(Effect.andThen(call(Anything, `${session(id)}/interrupt`, {})), Effect.ignore),
      };
    };

      const connect = Effect.gen(function* () {
        const found = yield* registered;
        if (config.url) return peer(config.url, config.password, config.password ? null : found?.url === config.url ? found.password : null);
        return found ? peer(found.url, config.password, found.password) : null;
      });
      return OpenCodeClient.of({ connect });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
