/**
 * The service, as the page talks to it: the JSON routes over `HttpClient`, every answer decoded by its Schema, and the
 * server-sent changes as a Stream. A refusal keeps the service's own words (`error.message`), or `HTTP <status>`.
 */
import { Context, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest, type HttpClientResponse } from "effect/http";
import {
  Asked,
  Brief,
  Decided,
  Focus,
  Heartbeat,
  ItemDetail,
  Opened,
  Published,
  RequestFailed,
  SearchPage,
  Snapshot,
  type Audience,
  type WayOutBody,
} from "../domain/Overwatch.ts";

const ErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

/** What a decision on an item carries besides the way out: the position the owner was shown, or the undo it names. */
export type ActionBody =
  | (WayOutBody & { readonly basisSeq?: number | null | undefined })
  | { readonly action: "undo"; readonly actionSeq: number }
  | { readonly action: "seen"; readonly throughSeq: number };

export class Overwatch extends Context.Service<Overwatch, {
  readonly status: Effect.Effect<Snapshot, RequestFailed>;
  readonly item: (id: string) => Effect.Effect<ItemDetail, RequestFailed>;
  readonly focus: (subject: string) => Effect.Effect<Focus, RequestFailed>;
  readonly search: (q: string, cursor: Option.Option<string>) => Effect.Effect<SearchPage, RequestFailed>;
  readonly brief: (audience: Audience) => Effect.Effect<Brief, RequestFailed>;
  readonly act: (id: string, body: ActionBody) => Effect.Effect<Decided, RequestFailed>;
  readonly ask: (body: { subject: string; text: string; mode: "new" | "auto" }, key: string) => Effect.Effect<Asked, RequestFailed>;
  readonly open: (subject: string, key: string) => Effect.Effect<string, RequestFailed>;
  readonly investigate: (id: string, key: string) => Effect.Effect<void, RequestFailed>;
  readonly fix: (id: string, jobId: string, key: string) => Effect.Effect<void, RequestFailed>;
  readonly publish: (fixId: string, basisSeq: number | null, key: string) => Effect.Effect<Published, RequestFailed>;
  readonly correct: (id: string, jobId: string, text: string, key: string) => Effect.Effect<void, RequestFailed>;
}>()("overwatch/Overwatch") {
  static readonly layer = Layer.effect(
    Overwatch,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const refused = (response: HttpClientResponse.HttpClientResponse) =>
        response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
          Effect.map((body) => body.error.message),
          Effect.orElseSucceed(() => `HTTP ${response.status}`),
          Effect.flatMap((message) => Effect.fail(new RequestFailed({ status: response.status, message }))),
        );
      const send = <S extends Schema.Top & { readonly DecodingServices: never }>(
        schema: S,
        request: HttpClientRequest.HttpClientRequest,
      ): Effect.Effect<S["Type"], RequestFailed> =>
        client.execute(HttpClientRequest.setHeader(request, "content-type", "application/json")).pipe(
          Effect.flatMap((response): Effect.Effect<unknown, HttpClientError.HttpClientError | RequestFailed> =>
            response.status >= 200 && response.status < 300 ? response.json : refused(response)),
          Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
          Effect.mapError((error) => (Schema.is(RequestFailed)(error) ? error : new RequestFailed({ status: 0, message: error.message }))),
        );
      const get = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, path: string, urlParams?: Record<string, string>) =>
        send(schema, HttpClientRequest.get(`/v2/${path}`, urlParams ? { urlParams } : {}));
      const post = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, path: string, body: unknown, key?: string) =>
        send(
          schema,
          HttpClientRequest.post(`/v2/${path}`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
            key === undefined ? (request) => request : HttpClientRequest.setHeader("idempotency-key", key),
          ),
        );
      const item = (id: string) => `items/${encodeURIComponent(id)}`;
      return Overwatch.of({
        status: get(Snapshot, "status"),
        item: (id) => get(ItemDetail, item(id)),
        focus: (subject) => get(Focus, "focus", { subject }),
        search: (q, cursor) => get(SearchPage, "search", Option.match(cursor, { onNone: () => ({ q }), onSome: (cursor) => ({ q, cursor }) })),
        brief: (audience) => get(Brief, "brief", { audience }),
        act: (id, body) => post(Decided, `${item(id)}/action`, body),
        ask: (body, key) => post(Asked, "ask", body, key),
        open: (subject, key) => post(Opened, "open", { subject }, key).pipe(Effect.map((r) => r.url)),
        investigate: (id, key) => post(Schema.Unknown, `${item(id)}/investigate`, {}, key).pipe(Effect.asVoid),
        fix: (id, jobId, key) => post(Schema.Unknown, `${item(id)}/fix`, { jobId }, key).pipe(Effect.asVoid),
        publish: (fixId, basisSeq, key) => post(Published, `fixes/${encodeURIComponent(fixId)}/publish`, { basisSeq }, key),
        correct: (id, jobId, text, key) => post(Schema.Unknown, `${item(id)}/corrections`, { jobId, text }, key).pipe(Effect.asVoid),
      });
    }),
  );
}

/** What the change stream says: a newer picture, that the service is there (and its clock), or that it went away. */
export type ServiceEvent =
  | { readonly _tag: "Snapshot"; readonly snapshot: Snapshot }
  | { readonly _tag: "Heartbeat"; readonly atMs: number | undefined }
  | { readonly _tag: "Lost" };

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot));
const decodeHeartbeat = Schema.decodeUnknownEffect(Schema.fromJsonString(Heartbeat));

/**
 * GET /v2/changes as a Stream: a snapshot, then a change per commit, and a heartbeat every five seconds. The browser
 * reconnects by itself while it can; once it gives up the stream says so and opens a new one three seconds later.
 */
export class ServiceEvents extends Context.Service<ServiceEvents, {
  readonly changes: Stream.Stream<ServiceEvent>;
}>()("overwatch/ServiceEvents") {
  static readonly layer = Layer.succeed(ServiceEvents, {
    changes: Stream.unwrap(
      Effect.map(
        Effect.acquireRelease(Effect.sync(() => new EventSource("/v2/changes")), (source) => Effect.sync(() => source.close())),
        (source) => {
          const data = (type: string) => Stream.fromEventListener<MessageEvent<string>>(source, type).pipe(Stream.map((event) => event.data));
          const snapshots: Stream.Stream<ServiceEvent> = Stream.merge(data("snapshot"), data("change")).pipe(
            // A message that is not a snapshot is not a picture of the service; the next one is.
            Stream.mapEffect((text) => decodeSnapshot(text).pipe(Effect.tapError((error) => Effect.logWarning("an unreadable snapshot", error.message)), Effect.option)),
            Stream.flatMap((snapshot) => Stream.fromIterable(Option.toArray(snapshot))),
            Stream.map((snapshot) => ({ _tag: "Snapshot", snapshot })),
          );
          const heartbeats: Stream.Stream<ServiceEvent> = data("heartbeat").pipe(
            // A heartbeat without a time still says the service is there.
            Stream.mapEffect((text) => decodeHeartbeat(text).pipe(Effect.option)),
            Stream.map((beat) => ({ _tag: "Heartbeat", atMs: Option.getOrUndefined(beat)?.atMs })),
          );
          const lost: Stream.Stream<ServiceEvent, "closed"> = Stream.fromEventListener(source, "error").pipe(
            Stream.flatMap(() => {
              const event = Stream.succeed<ServiceEvent>({ _tag: "Lost" });
              return source.readyState === EventSource.CLOSED ? Stream.concat(event, Stream.fail("closed" as const)) : event;
            }),
          );
          return Stream.mergeAll([snapshots, heartbeats, lost], { concurrency: "unbounded" });
        },
      ),
    ).pipe(Stream.retry(Schedule.spaced(Duration.seconds(3))), Stream.orDie),
  });
}
