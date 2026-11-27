# Migration to Effect 4 (service) and Foldkit (page)

Overwatch moves from plain Node (no runtime dependencies) to Effect 4.1 for the service and Effect UI (`@effect/ui`)
for the page, since moved to Foldkit (see [The page on Foldkit](#the-page-on-foldkit)). The rule from the owner: **do not hand-roll what Effect or Effect UI already provides; use the built-in
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
| The page | `foldkit` (`Runtime`, `Command`, `Subscription`, `Mount`, Submodels, `Story`), formerly `@effect/ui` and `@effect/ui-kit`; see [The page on Foldkit](#the-page-on-foldkit) | the hand-written `web/app.mjs` |

## Conventions for the service

- **Services.** Each stateful part is a `Context.Service` with a static `layer`: `AppConfig` (the parsed `Config`),
  `Store` (the database), `OpenCodeClient`, `Collector`, `Agents`, `Fixes`, `Tools`, `Trial`. Domain functions read
  services with `yield*` (or `Service.use`, as `sql.all`/`sql.get`/`sql.seq` do for reads) instead of taking `store`
  and `config` parameters. Programs run through `exec.ts` functions that need Effect's `ChildProcessSpawner`.
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
- **The clock.** `clock` (in `src/clock.ts`) stays the single source of wall and monotonic time for domain decisions,
  because the test descriptor sets it. Deadlines on the monotonic clock use `bounded`, a race against that clock.
- **Outbound effects.** `effect(permit, …)` in `src/exec.ts` stays the only way to run `gh`, `git push` or the notifier. `exec.ts`
  stays the only module that starts a program (`test/boundaries.test.ts` checks this).
- **Text.** `clean` in `src/redact.ts` stays the only way to make `Clean` text. The writer cleans every value again.

## Status

Done. The service runs on Effect 4.1 and the page on Foldkit 0.171 (it ran on Effect UI, `@effect/ui` and
`@effect/ui-kit` snapshot `fab0fba`, until the move described below). Node 22.16+ or 24 is required: Effect's SQLite client rolls a failed transaction back only where
`node:sqlite` reports `isTransaction`.

Kept deliberately: `clock.ts` (the test descriptor drives it), the redaction and parsing rules in `redact.ts` and
`parse.ts` (domain rules, not plumbing), and the domain arithmetic (adjudication, forecasts, hysteresis).

Changed on the wire: MCP sessions follow the specification strictly (`McpServer` requires `mcp-session-id` after
`initialize`; an unknown session is 404, so OpenCode reconnects `ow` after a restart), tool listings carry read-only and
destructive hints, and a tool's malformed arguments are refused in Schema's words.

## The page on Foldkit

Effect UI was a pkg.pr.new snapshot pinned by commit, with no npm release to hold to the 72-hour release age the
workspace requires. Foldkit is the published framework Effect UI descends from: the same architecture (a Schema
Model, tagged Messages, a pure `update` returning Commands, Subscriptions, Mounts, stories) on Effect 4.1, released on
npm. The page moved to `foldkit@0.171.0` with `effect` 4.1.5; the DOM, keys, timing and text the suites pin did not
change.

How it is laid out, so that moving back to Effect UI when it reaches npm is mechanical:

- **Framework-free:** `web/src/domain/` (Schemas), `web/src/services/` (`Overwatch` over `HttpClient`, the
  `ServiceEvents` Stream, `PageWindow`) and `web/src/model.ts` (pure page decisions) import nothing from a view layer.
  The old `web/src/queries/` are gone: reads are plain Effect programs on `Overwatch`, run by Commands.
- **One door:** components reach Foldkit only through `web/src/ui.ts` (the builder type, `TaggedEnum`, `Command`,
  `Mount`, `Update`, `Dom`, `defineView`, and the `el` helper the views are written with). The runtime is used only in
  `App.ts` (Subscriptions, the root view) and `entry.ts` (`Runtime.makeApplication`, `Runtime.run`, Flags).
- **Same shapes:** each component keeps its file, its Schema Model, its Message union (same names), its events (as an
  `Events` union, Foldkit's OutMessage) and a pure `update`; Commands keep their names. `App.ts` opens with a table of
  every Foldkit piece and its Effect UI counterpart.

| Effect UI | Foldkit | Back again |
| --- | --- | --- |
| `Html.component({ props, model, message, events })` + `make({ init, update, view })` | module with `Props`, `Model`, `Message`, `Events`, `init`, `update(model, message, props)`, `view = defineView(...)` | wrap the module's parts in `Html.component` |
| `onEmit` in the parent | `Update.foldChild` with `foldOutMessage`, each event mapped to the page Message that says the same | `onEmit: { Event: () => AppMessage.X() }` |
| `Command.Service` / `Command.make`, `success` | `Command.define(name, { args, messages, execute })` | rename; `execute` bodies are unchanged |
| `mode: "switch"` (`WaitBeforeSeen`, `WaitBeforeDismissal`) | a token (`n`) in args, stale results ignored | drop the token |
| `Query.Service` (`GetItem`, `GetFocus`, `GetBrief`, `SearchItems`) and tags | Commands `ReadItem`, `LoadTarget`, `LoadBrief`, `Search`, re-run where the query args or invalidations changed (`App.update`, `readAgain`) | restore the queries; delete the re-runs |
| `Subscription.make`, `HtmlSubscription.onDocument` | `Subscription.make` / `persistentEntry`, `Dom.streamFromEventFilterMapPreventDefault` | as before |
| `head`: `Head.title`, `HtmlHead.bodyData`, `HtmlHead.htmlData` | `Document.title`; the `document` Subscription writes `data-link` and `data-theme` | `head` again |
| `Mount.make` / `makeStream` | `Mount.define` / `defineStream` (`ShowSheet`, `KeepBar`, `ShowPress`); `RevealRow` became a Command (a Foldkit Mount runs only on insert) | `Mount.make` again |
| `@effect/ui-kit` `Dialog` | native modal `<dialog>` (`components/Sheet.ts`): `showModal` on mount, focus trap, inert page and focus return by the browser, `Dom.lockScroll` | `Dialog` |
| `@effect/ui-kit` `Collapsible` | the same button and panel markup in `components/Inbox.ts` | `Collapsible` |
| `@effect/ui/testing` `Story` | `foldkit` `Story` (`web/test/app.test.ts`) | port the steps back |
| `BrowserHost.mount(App, props)` | `Runtime.makeApplication({ Flags, resources })` + `Runtime.run(app, { flags })` | `BrowserHost.mount` |

Two Foldkit behaviours needed a narrow fix, both in `entry.ts`. Foldkit paints on the next animation frame, where
Effect UI painted in the same task (a microtask); the suites read the page straight after a key press, so the page runs
its frame callbacks as microtasks. And Effect's `FetchHttpClient` keeps the `fetch` it first sees; the page gives it one
that calls the window's current `fetch`, so a script that wraps `fetch` later sees the requests after it. The Effect UI
`$r` workaround (Chrome DevTools serialising an element's handler record) is gone: Foldkit stores no handler record on
elements, and the suites read elements by value without it.

## Verification

`pnpm run check` (typecheck and `test/`), then every acceptance suite: `accept/m1` to `accept/m4` and the top-level
`accept/*.test.mjs`. Everything that passed before the migration still passes.
