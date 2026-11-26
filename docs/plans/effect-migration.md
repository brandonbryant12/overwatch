# Migration to Effect 4 and Effect UI

Overwatch moves from plain Node (no runtime dependencies) to Effect 4.1 for the service and Effect UI (`@effect/ui`)
for the page. The rule from the owner: **do not hand-roll what Effect or Effect UI already provides; use the built-in
modules as they come.** The public contract does not change: the CLI (commands, flags, exit codes, `--json` output),
the HTTP and SSE API, MCP, the SQLite schema and file, the page's DOM, and everything `accept/` pins. `accept/` is
never edited.

## Packages

| Need | Built-in used | Replaces |
| --- | --- | --- |
| Effects, errors, services | `effect` (`Effect.gen`, `Effect.fn`, `Context.Service`, `Layer`, `Schema.TaggedError`) | classes, `throw`, `async` |
| Entry point, signals | `@effect/platform-node` `NodeRuntime.runMain`, `NodeServices.layer` | `process.on("SIGTERM")`, manual drain |
| Command line | `effect/cli` (`Command`, `Flag`) | `argv.indexOf` parsing |
| SQLite | `@effect/sql-sqlite-node` `SqliteClient` and `effect/sql` `SqlClient` (`withTransaction`, `afterCommit`, `unsafe`) | `node:sqlite` `DatabaseSync` |
| Child processes | `effect/process` `ChildProcess` and `ChildProcessSpawner` | `node:child_process` `spawn` |
| HTTP server | `effect/http` `HttpRouter`, `HttpServerRequest`, `HttpServerResponse`, `HttpStaticServer`, `NodeHttpServer` | `node:http` `createServer` and a regex router |
| Server-sent events | `Stream` and `PubSub` into `HttpServerResponse.stream` | `res.write` and a `Set` of responses |
| MCP | `effect/ai` `McpServer.layerHttp`, `Tool`, `Toolkit` | hand-written JSON-RPC |
| HTTP clients (OpenCode, Datadog) | `effect/http` `HttpClient`, `HttpClientRequest`, `HttpClientResponse.schemaBodyJson`, `FetchHttpClient.layer` | `fetch` helpers |
| Values from outside | `Schema` (`decodeUnknown`, `Schema.Class`, `Schema.Struct`) and `Predicate` | `rec`, `list`, `str` and manual checks |
| Scheduling, retries, timeouts | `Schedule`, `Effect.repeat`, `Effect.retry`, `Effect.timeout`, `Effect.forkScoped` | `setInterval`, `setTimeout` loops |
| Secrets | `Redacted` | strings |
| Logging | `Effect.log*` with the logger writing `[overwatch] …` to stderr | `process.stderr.write` |
| The page | `@effect/ui` (`Html.component`, `Command`, `Subscription`, `Query`, `BrowserHost`) and `@effect/ui-kit` | the hand-written `web/app.mjs` |

## Conventions for the service

- **Services.** Each stateful part is a `Context.Service` with a static `layer`: `AppConfig` (the parsed `Config`),
  `Store` (the database), `Exec` (programs), `OpenCodeClient`, `Datadog`, `Collector`, `Agents`, `Fixes`, `Tools`,
  `Trial`. Domain functions read services with `yield*` instead of taking `store` and `config` parameters.
- **Effects, not promises.** A function that does I/O returns an `Effect`, written with `Effect.fn("name")` (or
  `Effect.fnUntraced` on hot paths). There are no `async` functions, `await` or `new Promise` in `src/`. Pure,
  synchronous domain logic (parsers, `adjudicate`, `forecast`, `problem`, `hysteresis`, redaction) stays as plain
  functions. Effect is not wrapped around arithmetic.
- **Errors.** Expected failures are `Schema.TaggedError` classes in `src/errors.ts` (`ApiError` with an HTTP status,
  `Full`, `Busy`, `Incompatible`, `Refusal`, `Unavailable`, `SourceFailure`, `Expired`, `CliExit`), handled with
  `Effect.catchTag` and `Effect.catchTags`. SQL errors are defects (`Effect.orDie`): a constraint violation is a bug,
  and the transaction still rolls back. Never use `try`/`catch` around a `yield*`, because it does not catch an Effect's
  failure.
- **The store.** `Store` wraps `SqliteClient` with one connection (`disableWAL: true`, `busyTimeout: 0`), so it can
  set exclusive locking and WAL itself, in the original order. Reads are `store.all`, `store.get`, `store.seq` and
  `store.meta`, all Effects. A change is `store.tx((w) => Effect.gen(function* () { yield* w.run(...); ... }))`, which
  is one `BEGIN IMMEDIATE` transaction through `SqlClient.withTransaction`. `Writer` methods (`run`, `event`,
  `permit`, `next`) are Effects. Permits go live and listeners are told through `SqlClient.afterCommit`. A
  transaction body does only database work: it never calls OpenCode, a program or the network.
- **The clock.** `clock` (in `src/clock.ts`) stays the single source of wall and monotonic time, because the test
  descriptor sets it. `ServiceClock` provides Effect's `Clock` from it. Deadlines on the monotonic clock use `bounded`.
- **Outbound effects.** `Exec.effect(permit, …)` stays the only way to run `gh`, `git push` or the notifier. `exec.ts`
  stays the only module that starts a program (`test/boundaries.test.ts` checks this).
- **Text.** `clean` in `src/redact.ts` stays the only way to make `Clean` text. The writer cleans every value again.

## Ownership during the migration

| Area | Files |
| --- | --- |
| Foundation | `src/errors.ts`, `src/store.ts`, `src/exec.ts`, `src/clock.ts`, `src/parse.ts`, `src/redact.ts`, `src/config.ts`, `src/inbox.ts`, `src/snapshot.ts`, `src/brief.ts` |
| Collection | `src/collect.ts`, `src/kube.ts`, `src/datadog.ts`, `src/failures.ts`, `src/outlook.ts` |
| Agents | `src/opencode.ts`, `src/agents.ts`, `src/tools.ts`, `src/mcp.ts`, `src/trial.ts` |
| Fixes and operations | `src/fixes.ts`, `src/doctor.ts`, `src/launchd.ts` |
| Service and command line | `src/server.ts`, `src/main.ts`, `src/demo.ts`, `bin/overwatch` |
| Page | `web/`, `scripts/build-web.ts` |

## Verification

`pnpm run check` (typecheck and `test/`), then every acceptance suite: `accept/m1` to `accept/m4` and the top-level
`accept/*.test.mjs`. Everything that passed before the migration still passes.
