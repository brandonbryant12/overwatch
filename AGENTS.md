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
  source's own output under that source's name, `git_history` output as `git:<operation>`, other context-pack parts
  as `brief:<kind>`. A quote attributed to a source verifies only against that source's rows; a file quote only
  against the file in the thread's worktree; any other label is never verified. A real verdict with an observed cause
  needs a matched quote, or it is recorded as inferred and the reply says so (`claimable`). The finding records which
  code it read. The page shows how many quotes matched and labels them "Exact quote matched", never the model's own
  confidence. `query_telemetry` and `file_finding` refuse calls without the session id from
  `_meta`, with another session's token, or for a finished run. (`mcp.test.ts`)
- **The plugin has no Effect and no domain client at run time**; its imports from OpenCode's packages are types only.
  It holds no state and schedules nothing. Its `API_VERSION` equals the service's. (`plugin.test.ts`)
- **The investigator is denied by default.** Add narrow rules through the plugin's `permissions` option, not by
  widening `investigatorPermissions`.
- **No session picker.** The prompt bar previews where a prompt goes; Shift+Enter is the one override (a new session).
- **The page holds no logic of its own.** State and pure selectors live in `web/src/app.ts` (tested in
  `page.test.ts`), HTML builders in `web/src/views.ts`, glyphs in `web/src/icons.ts`, styling only in
  `web/src/style.css`, following `docs/design.md`. It reads through the typed client and `watch`; `/status` is decoded
  with `src/domain/status.ts`, the schema the service encodes with. Drafts belong to their incident and stay until a
  send is acknowledged. `test/browser.test.ts` drives the built page in headless Chrome.
- **Loopback only.** The service binds `127.0.0.1` and refuses other host names and other origins. (`service.test.ts`)
- **One writer per database.** The host takes `src/host/lock.ts`'s lock (`<db>.writer`; an earlier version's `<db>.lock`
  is only consulted) before opening or repairing; restore and
  search rebuild take it too, and restore validates a staged copy (exactly the columns, indexes and no triggers the service writes with) before an
  atomic rename. (`regressions.test.ts` A4, A5)
- **Reports are an outbox.** The collector saves its reports with the checkpoint in one transaction and sends them
  after; never report before the checkpoint is saved. (`regressions.test.ts` A2)
- **Runs are strict.** requested → sent → completed | failed; only the run's own session completes it; time limits
  count from `sentAt`. (`domain.test.ts`, `regressions.test.ts` A6)
- **Unknown is never healthy.** A metric not sampled by the last poll is `unknown`, and a missing sample breaks a run
  of samples; an environment not fully checked within three intervals is stale; a suspended one says since when. The
  page says so in words and with the unknown pattern. "Quiet" comes only from `notQuietBecause` / `allQuiet` in
  `web/src/app.ts`; do not write another. It needs a status under 30 seconds old by the page's clock, every expected
  reading from every source sampled within the stale window, and a skipped poll changes nothing that is known. (`regressions.test.ts` B1, B4; `defects3.test.ts` 6; `daily.test.ts`, over
  generated states)
- **Three ways out, each meaning one thing.** Done: back if it happens again after one polling interval. Later: back at
  a time, on a change (finding, deploy), or when it gets worse; any Later comes back when worse. Never: back only on a
  severity rise or ten times the rate. `decide` decides it, with thresholds sent as data (`comeBack`); every way out,
  undo and return is an event naming who issued it, and a return carries one line saying why. Do not add a way out.
  (`domain.test.ts`, `daily.test.ts`)
- **Rows never move while the owner looks.** `arrangedInbox` keeps the shown layout; arrivals and regrouped rows wait
  behind a group's line until `r`, a click on it, or coming back to the page. Grouping is only `groupInbox`.
  (`daily.test.ts` C, `browser.test.ts`)
- **Failures are classified, not retried blindly** (`src/collect/failures.ts`). Sign-in suspends after one confirming
  attempt; others back off to `failures.ceiling`; a suspended connection is probed at that pace and on wake or network
  change. The `connections` table is polling state; suspension and resumption are Watcher events. One cause, one item
  (`causesOf`); everything unreachable at once is one cause. Agent work is retried once in a fresh session, then
  parked (`RunFailed.retryAs`). (`daily.test.ts` D, `domain.test.ts`)
- **No spend tracking or caps**; only timeouts and concurrency limits.
- **Counts come from what happened, never from what is kept to show.** A source lists every occurrence in its
  window; a signal's count is what it lists (one per poll for an ongoing condition). Do not cap occurrences or carry a
  separate total. (`durability.test.ts`)
- **Identifiers from outside are input.** A caller's prompt id or command id is accepted only in the shape of an id
  and only if redaction leaves it unchanged (`src/domain/safe.ts`, and the `/api` check in `service.ts`); incident,
  thread, run and session ids must have the shape Overwatch derives. An id from OpenCode is mapped to one Overwatch
  issues. Every error message written anywhere goes through `errorText`; every log line is redacted. (`fields.test.ts`,
  `recovery.test.ts`)
- **An incident decides from its own history.** A deploy is told to every incident in its environment with when it
  was recorded; the incident alone decides whether it was deferred before. Never decide from a view. (`ordering.test.ts`)
- **Free text is redacted where it enters** (`src/domain/redact.ts`, by name and by how random it looks): the
  aggregates redact prompts, signal titles, samples and queries, findings, handoffs and reasons in `decide`, before
  their events exist; the collector redacts signals before de-duplication and the report outbox; what sessions are
  shown, coverage notes and watcher errors are redacted on write. A new path for text must do the same, with a test
  in `test/regressions.test.ts`. (`regressions.test.ts`, A1)
- Tests use fakes for `kubectl`, `gh`, Datadog and the model. Never call a real cluster, Datadog or repository host.
