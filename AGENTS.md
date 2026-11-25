# Agent guide

Overwatch is two programs: a Node service (`src/service`, `src/host`, `src/domain`, `src/collect`, the page in `web/`)
and a thin OpenCode 2 plugin (`src/plugin`). Read `README.md`, then `docs/` (setup, using, customizing, design
philosophy). The plan, and what is not built yet, is `docs/plans/command-center.md`.

## Setting Overwatch up for someone

Configuration lives only in the user's own files, never in this repository: the service's `~/.config/overwatch/config.json`
and the global OpenCode config. Do not commit names, paths, contexts, queries or credentials from anyone's environment.

1. Follow `docs/setup.md`. Show the user every change to their OpenCode config before writing it, and keep the rest
   of the file as it is.
2. Ask which apps to watch and where their checkouts are (`git -C <path> remote -v` confirms one).
3. Find Kubernetes sources read-only: `kubectl config get-contexts`, `kubectl --context <c> get deploy -n <ns>
   --show-labels`. Never apply, delete, scale, exec or read secrets.
4. Secrets are references (`env:NAME`, `keychain:service/account`). Ask the user to store keychain values themselves;
   never ask for, print or write a secret.
5. `bin/overwatch check`, start the service, `bin/overwatch status`.

## Working on the code

- Node 22.13 or newer and pnpm. `pnpm install`, then `pnpm run check` (typecheck of the service and the page, and every
  test) before every commit. Both must pass. Never Bun: no `bun:` imports, no `Bun.*`, no `bun.lock`, no script that
  needs it.
- TypeScript that Node runs by stripping types: no enums, namespaces or parameter properties (`erasableSyntaxOnly`).
  Tests run on Node's runner; `test/harness.ts` supplies `describe`, `test` and `expect`.
- `@alchemy.run/domain` and `alchemy` are pinned to exactly `2.0.0-beta.87`, `effect` to `4.1.5`. Upgrade one beta at
  a time, with `test/conformance.test.ts` and `pnpm run test:crash` as the gate. Never import the Rivet or Effect
  Cluster hosts (they load `alchemy/Runtime/Bootstrap`, a `.ts` file Node refuses under `node_modules`). Do not use
  Alchemy sagas: this single-process host has no durable workflow engine; use policies, scheduled commands and the
  run outbox.
- After changing anything in `src/plugin`, `src/service/worker.ts`, `src/service/opencode.ts`, `src/service/mcp.ts`
  or how the service uses the OpenCode API, run `OPENCODE_BIN=<opencode 2 binary> pnpm run e2e`. The npm package
  `@opencode/cli-<platform>` carries the binary. It runs OpenCode with its own temporary HOME, config and data; never
  point it at a real OpenCode data directory, and never install or load the launchd agent from a test.

## Rules that must hold, with tests that pin them

- **The host.** Every read and write on the one SQLite connection goes through `src/host/connection.ts`; a
  transaction is owned by one object and nested ones are savepoints. Alarms are claimed, fired, then cleared only if
  not re-armed, driven by the ticker. The journal row is written in the aggregate's commit transaction. Do not add a
  second connection or a timer per alarm. (`host.test.ts`, `crash.test.ts`)
- **Only things that happened are events.** Polling bookkeeping goes in plain tables (`src/service/tables.ts`). A poll
  that finds nothing writes no event. (`service.test.ts`)
- **Events are additive only.** New fields are optional; a change of meaning is a new event. Bump a view's `version`
  when you change what it computes.
- **`decide` and `evolve` are pure**: no I/O, no `Date.now()`, time from `ctx.now`. Keep `Domain.verify(Overwatch)`
  empty and every behaviour covered by a story. (`domain.test.ts`)
- **Views lag their aggregates.** Act on an aggregate's state (`runs.get`), or read a view with `atLeast`; never assume
  a view already shows a write you just made.
- **Ids before actions.** Session, message and run ids are chosen by the model and recorded before anything is sent to
  OpenCode; every OpenCode call the service makes is idempotent by id. (`worker.test.ts`, e2e)
- **Read-only is an allowlist, never a denylist.** `checkKubectlArgs` accepts only each verb's listed resources, flags
  and value shapes. Agents get structured operations (`agentKubectl`, `src/service/history.ts`) whose fields are
  checked before any argv is built; never pass an agent's string through as an argument. The investigator has no
  shell. (`regressions.test.ts` A9, `mcp.test.ts`)
- **Citations are checked by code, with provenance.** Everything a session is shown is recorded with what it is: a
  source's own output under that source's name, other context-pack parts as `brief:<kind>`. A quote attributed to a
  source verifies only against that source's rows; a file quote only against the file in the thread's worktree. The
  finding records which code it read. `query_telemetry` and `file_finding` refuse calls without the session id from
  `_meta`, with another session's token, or for a finished run. (`mcp.test.ts`)
- **The plugin has no Effect and no domain client at run time**; its imports from OpenCode's packages are types only.
  It holds no state and schedules nothing. Its `API_VERSION` equals the service's. (`plugin.test.ts`)
- **The investigator is denied by default.** Add narrow rules through the plugin's `permissions` option, not by
  widening `investigatorPermissions`.
- **The page holds no logic of its own.** State and pure selectors live in `web/src/app.ts` (tested in
  `page.test.ts`), HTML builders in `web/src/views.ts`, glyphs in `web/src/icons.ts`, styling only in
  `web/src/style.css`, following `docs/design.md`. It reads through the typed client and `watch`; `/status` is decoded
  with `src/domain/status.ts`, the schema the service encodes with. Drafts belong to their incident and stay until a
  send is acknowledged. `test/browser.test.ts` drives the built page in headless Chrome.
- **Loopback only.** The service binds `127.0.0.1` and refuses other host names and other origins. (`service.test.ts`)
- **One writer per database.** The host takes `src/host/lock.ts`'s lock before opening or repairing; restore and
  search rebuild take it too, and restore validates a staged copy before an atomic rename. (`regressions.test.ts` A4, A5)
- **Reports are an outbox.** The collector saves its reports with the checkpoint in one transaction and sends them
  after; never report before the checkpoint is saved. (`regressions.test.ts` A2)
- **Runs are strict.** requested → sent → completed | failed; only the run's own session completes it; time limits
  count from `sentAt`. (`domain.test.ts`, `regressions.test.ts` A6)
- **Unknown is never healthy.** A metric not sampled by the last poll is `unknown`; an environment not fully checked
  within three intervals is stale; the page says so in words and with the unknown pattern. (`regressions.test.ts` B1, B4)
- **No spend tracking or caps**; only timeouts and concurrency limits.
- **Free text is redacted where it enters** (`src/domain/redact.ts`, by name and by how random it looks): the
  aggregates redact prompts, signal titles, samples and queries, findings, handoffs and reasons in `decide`, before
  their events exist; the collector redacts signals before de-duplication and the report outbox; what sessions are
  shown, coverage notes and watcher errors are redacted on write. A new path for text must do the same, with a test
  in `test/regressions.test.ts`. (`regressions.test.ts`, A1)
- Tests use fakes for `kubectl`, `gh`, Datadog and the model. Never call a real cluster, Datadog or repository host.
