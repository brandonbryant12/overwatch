/**
 * MCP over Streamable HTTP at `POST /mcp`, served by Effect's `McpServer` (sessions, `initialize`, `tools/list`,
 * `tools/call`, notifications answered 202). What Overwatch adds around it: the bearer credential (compared in
 * constant time, 401 otherwise), POST only (405), and the OpenCode session ID from each call's
 * `_meta["ai.opencode/sessionID"]`, which alone decides which run (or owner) a call belongs to.
 *
 * Mounting: `McpRoutes` registers its routes on the `HttpRouter`; merge it into the app layer beside the other routes
 * (`HttpRouter.serve(Layer.mergeAll(Routes, McpRoutes, …))`). It needs `Store`, `AppConfig`, `Collector`, `Fixes` and
 * the platform services; it brings its own `Tools` (the same instance as the agents', since layers are shared).
 */
import { Cause, Effect, Layer, Option, Predicate, Redacted, Schema } from "effect";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { timingSafeEqual } from "node:crypto";
import { Collector } from "./collect.ts";
import { AppConfig } from "./config.ts";
import { secret } from "./exec.ts";
import { Fixes } from "./fixes.ts";
import { act, basisOf, detail, inbox, search } from "./inbox.ts";
import { OpenCodeClient } from "./opencode.ts";
import { comparisons } from "./outlook.ts";
import { errorText } from "./redact.ts";
import { snapshot } from "./snapshot.ts";
import { Store } from "./store.ts";
import { inputSchema, type Owner, TOOLS, Tools } from "./tools.ts";

/** A refused call, as the model reads it: one text block holding `{"error": …}`, with isError set. */
const Failure = Schema.Struct({ error: Schema.String });

/** Each tool as MCP lists it: its closed input schema from its parameters Schema. Arguments reach `Tools.call` as sent. */
const READS = new Set(["ow_telemetry", "ow_code_search", "ow_code_read", "ow_history", "ow_inbox", "ow_get", "ow_search"]);
const definitions = TOOLS.map((t) =>
  Tool.dynamic(t.name, { description: t.description, parameters: inputSchema(t.parameters), success: Schema.Unknown, failure: Failure }).annotate(Tool.Readonly, READS.has(t.name)));
const toolkit = Toolkit.make(...definitions);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => HttpServerResponse.jsonUnsafe(body, { status, headers });

/** The owner's tools call exactly what the page calls: the inbox, an item in full, search, and a decision. */
const owner = Effect.gen(function* () {
  const collector = yield* Collector;
  const fixes = yield* Fixes;
  const opencode = yield* OpenCodeClient;
  const services = yield* Effect.context<Store | AppConfig>();
  const local = <A, E>(e: Effect.Effect<A, E, Store | AppConfig>) => Effect.provide(e, services);
  return {
    exists: (sessionId) => Effect.flatMap(opencode.connect, (oc) => (oc ? oc.exists(sessionId) : Effect.succeed(false))),
    inbox: local(inbox),
    get: (id) => local(Effect.provideService(itemOf(id), Fixes, fixes)),
    search: (text) => local(search(text)),
    act: (id, body) =>
      local(Effect.gen(function* () {
          const action = yield* act(id, body, yield* basisOf(body));
          return { ...(yield* snapshot(collector.view, true)), action }; })),
  } satisfies Owner; });

/** An item in full, as the page and the owner tools see it: its fix attempts and, for a staging regression, its comparison. */
export const itemOf = Effect.fnUntraced(function* (id: string) {
  const d = yield* detail(id);
  return { ...d, fixable: Boolean((yield* AppConfig).apps[d.incident.app]?.fixes), fixes: yield* (yield* Fixes).forItem(id), comparison: (yield* comparisons).find((c) => c.incident === id) ?? null };
});

const handlers = toolkit.toLayer(Effect.gen(function* () {
    const tools = yield* Tools;
    const ownerTools = yield* owner;
    const handle = (name: string) => (params: unknown) => Effect.gen(function* () {
        const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
        const sessionId = Option.getOrUndefined(client)?.requestMetadata?.["ai.opencode/sessionID"];
        return yield* tools.call(sessionId, name, params, ownerTools);
      }).pipe(
        // A refusal goes back to the model as it is; anything else is logged and said as "the tool failed".
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
          const e = Cause.squash(cause);
          if (Predicate.isTagged(e, "Refusal") || Predicate.isTagged(e, "ApiError")) return Effect.fail({ error: errorText(e, 30_000) as string });
          return Effect.logError(`tool ${name}: ${errorText(e)}`).pipe(Effect.andThen(Effect.fail({ error: "the tool failed" }))); }));
    return Object.fromEntries(TOOLS.map((t) => [t.name, handle(t.name)])) as never; }));

/** The bearer credential and POST only, before MCP sees the request. */
const Guard = Effect.gen(function* () {
  const config = yield* AppConfig;
  const token = config.mcpToken ? yield* secret(config.mcpToken) : null;
  const expected = Buffer.from(token ? `Bearer ${Redacted.value(token)}` : "");
  return HttpRouter.middleware((app) => Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // No server-initiated stream: Streamable HTTP clients are told so with 405, and carry on.
      if (request.method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "POST only" } }, { allow: "POST" });
      const given = Buffer.from(request.headers.authorization ?? "");
      if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) return json(401, { error: { code: "unauthorized", message: "a valid bearer credential is required" } });
      return yield* app; }),
  ).layer; });

/** `POST /mcp` (and any other method there, answered 405) on the `HttpRouter`. */
export const McpRoutes = Layer.unwrap(Effect.gen(function* () {
    const config = yield* AppConfig;
    const origins = [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`];
    return McpServer.layerHttp({
      name: "ow",
      version: "2",
      path: "/mcp",
      protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
      allowedOrigins: origins,
      registrations: McpServer.toolkit(toolkit, {
        // One text block holding the result as JSON, as the interfaces document says.
        content: Object.fromEntries(TOOLS.map((t) => [t.name, (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }]])),
      }).pipe(Layer.provide(handlers)),
    }).pipe(Layer.provide(yield* Guard)); }),
).pipe(Layer.provide(Layer.mergeAll(Tools.layer, OpenCodeClient.layer)), Layer.orDie);
