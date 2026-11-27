# Agent guide

Overwatch is one Node process and one SQLite file (`src/`), run by `bin/overwatch`. Read `README.md`, then the
specification in `docs/plans/simple-core.md`, its amendments and `docs/plans/simple-core-interfaces.md`: the
interfaces document is the public contract, and `accept/m1/` is the acceptance suite that pins it.

## Working on the code

- **Effect 4.1** throughout the service, and **Foldkit** (`foldkit`, built on Effect) for the page. The rule: do not
  hand-roll what Effect or Foldkit provides. Use its modules as they come: `Effect.gen` and `Effect.fn` (no async/await), `Context.Service` and
  `Layer` for every stateful part, `Schema.TaggedError` for expected failures, `Schema` for every value from outside
  (configuration, request bodies, provider replies), `Predicate` for checks, `effect/sql` (`SqlClient` on
  `@effect/sql-sqlite-node`) for the database, `effect/process` for programs, `effect/http` (`HttpRouter` on
  `NodeHttpServer`, and `HttpClient`) for HTTP, `effect/ai` `McpServer` for MCP, `effect/cli` for the command line,
  `Stream`, `PubSub`, `Schedule` and `Redacted`. Pure domain logic (adjudication, forecasts, parsers of known text,
  redaction) stays plain functions. `docs/plans/effect-migration.md` maps each old piece to its Effect module.
- Effect's own guides ship in the package: `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/`, and
  `node_modules/foldkit/` (its README and `dist/**/*.d.ts`) for the page. Check APIs there: Effect 4 renamed much of
  Effect 3.
- **Node 24, or 22.16 and newer.** Node runs the TypeScript by stripping its types: no enums, namespaces or parameter
  properties (`erasableSyntaxOnly`). Effect's SQLite client rolls a transaction back only where `node:sqlite` reports
  `isTransaction`, which Node 22.16+ and 24+ do; 23.x does not. Never Bun.
- **Dependencies are Effect's.** Runtime dependencies are `effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`
  and, for the page, `@effect/platform-browser` and `foldkit` (pinned exactly; `pnpm-workspace.yaml` holds new releases
  back 72 hours).
  Development dependencies are `typescript`, `fast-check`, `@types/node` and `rolldown` (the page's bundler). Add
  nothing else without the owner.
- `pnpm run check` (typecheck and `test/`) before every commit; `pnpm run accept` for the acceptance suite. Never
  edit `accept/`: if a test there looks wrong, say so with evidence. Tests run Effect programs through `test/effect.ts`.
- Size budget: at most 5,500 lines of service code (nonblank, noncomment lines of `src/`). It was 5,000 until
  milestone 4: acting on Git (deriving, checking, verifying and publishing a fix) and looking ahead could not fit
  inside the old number without dropping a safety check, so the owner raised it once, and no further.

## Rules that hold because of how the data is shaped

- **One owner.** `Store.own` sets exclusive locking, enters WAL and commits a write before reading the schema or
  listening, on the one connection of an `SqliteClient` opened with `disableWAL` and a zero busy timeout (so the order
  is ours). No lock files, no pid checks. A second owner of any version fails with "database is locked" (`Busy`).
- **One way to change anything.** `Store.tx` runs one `BEGIN IMMEDIATE` transaction (`SqlClient.withTransaction`); a
  change appends to `events` in the same transaction. Its body is database work only: an Effect that waits on the
  network or a program inside a transaction holds the only connection. SQL errors are defects with SQLite's words. `events` is append-only (triggers), except inside an explicit maintenance transaction
  (compaction, restore). `events.seq` is the only clock that decides order.
- **Text is clean or not stored.** The writer accepts `Clean` text (made only by `clean` in `src/redact.ts`), generated
  identifiers and JSON; at run time it cleans every string and every JSON value again, so a cast cannot bypass it.
  An error's message goes through `errorText`. Identifiers from outside are hashed into keys, never stored as given.
- **Counting is a key.** An occurrence's key is made from the source's own data; the slice inserts keys "if absent"
  and counts only what was inserted, in the same transaction as the checkpoint. Never derive a count from a list.
  Only a record whose key is not yet stored is charged against the slice limit. A log read counts only if the
  container's identity is the same in the pod list after it as before; a read that shows loss (a stored key in its
  window it no longer returns) is a `gap`, never a recount, and the occurrence's recorded incident becomes a lower
  bound in the same transaction.
- **One window type.** Every window of event time is a half-open `Span` (`src/collect.ts`): slices, overlap, the
  14-day floor and saturated intervals. Never compare an end with `<=`.
- **Outside values go through `src/parse.ts`.** `num`, `count`, `time` return null for anything not clearly that
  kind (finiteness is checked on the value, for every shape). A measurement is a `Sample`, measured or not, built
  only by `sample()`; hysteresis, health and quiet streaks take that type.
- **One interval per pass.** `Collector.interval` is the only place gauges and quiet streaks move, for a committed
  pass and a failed one alike (a failure gives every gauge an unmeasured sample). An interval counts toward Quiet
  only when it is new, ordinary and fully measured (`quietStep`).
- **One identity per connection.** `endpoint()` includes every field in `IDENTITY` (context; site, API key and
  application key); refusals are shared only by equal identities. `IDENTITY`, `Collector.reader` and `fixFor` are
  exhaustive over source kinds by type and throw at run time for a kind they lack: a new kind borrows nothing.
- **A reading is an observation.** Each reading in a slice is one `Reading`: what was observed, whether it is
  complete, and (unless failed) when the provider observed it, required by type. An adapter returns complete only
  after recognising the reply's shape (`searchLogs`, `monitors`, `metric`); anything else is a gap. Both times stored
  for a reading are the provider's, so freshness everywhere (health, Quiet, the snapshot, the page) is the provider's
  observation time; nothing stores the time Overwatch asked. A monitor's count is its transitions into alerting.
- **Evidence has an origin.** `origins` records what each piece is (telemetry, code, history, generated), apart from
  what its source is called; a piece without one is not telemetry. "Observed" is decided only from it.
- **One write path.** `Store.tx` runs `Store.guard` before every transaction (the collector installs the disk check),
  so slices, failure records, deadlines, page actions and tool writes are admitted by the same rule. Maintenance
  (`expire`, `retain`) is the only write without admission, and it is private to the store (`#maintain`), as is the
  connection. A `Writer` lives for one transaction; one kept past it dies. Foreign keys are deferred to commit.
- **The schema is declared once.** Every table in `TABLES` (`src/store.ts`) lists every column, and in `refs` each one
  that refers to a named parent ("table.key"). Restore checks every declared reference whatever the column is called;
  a build test fails when a created table has a column the list does not declare, and the class property fails until a
  row of a new referencing table is seeded. Whether a column is data or a reference is still the author's call.
- **Every POST is declared with its guard, in one table.** The router's `WRITES` table (`src/server.ts`) is the only
  place a POST is handled, and each entry is `keyed` (a handler returns a `Plan`; `keyed()` wraps its change in the
  receipt), `fenced` (the router hands over the `basisSeq` the owner was shown, read only by `basisOf()`; a decision
  made since refuses it) or a `command` that changes no item (backup, doctor, trial, the MCP transport). A guard of any
  other shape is refused before it runs. `receipt()` is private to `src/inbox.ts`; build tests fail when the request
  key or `basisSeq` is read elsewhere, or a POST is handled outside the table. A decision without a `basisSeq` is still
  accepted (scripts and the accept suites send none), so the fence is only as strong as the caller's use of it.
- **Nothing leaves without an intent.** `src/exec.ts` is the only module that starts a program (a build test checks
  it); `run()` refuses outbound commands (`gh`, `git push`, the notifier) and `effect()` runs them only with a
  `Permit` that a `Writer` made in the transaction recording the intent, live once that commits and spent by its use.
  A permit is bound to its exact effect: `spend()` refuses arguments that do not contain every bound token (the
  repository, the branch and commit for a push, the exact `gh` call for a host step).
  OpenCode writes (sessions, prompts, interrupts) take permits too. A permit constructed anywhere else is never live.
- **Age, then pressure.** `Store.expire` removes by age on every pass; `Store.retain` adds old events under
  pressure. Neither can remove a finding or its cited evidence.
  `Store.reclaim` frees at most `LIMITS.reclaimBytes` per pass for any page size and truncates the WAL. Never run a
  full `VACUUM` while serving: it copies the whole file and holds the only connection until done.
- **Schema changes within version 1 are additive.** A new column has a default and an entry in `ADDED`, a new table
  an entry in `ADDED_TABLES` (`src/store.ts`), so an older file gains it on open and an older backup restores into
  it. Prefer a new table to a new column on a table that backups are edited against. Restore checks the
  staged rows against `INVARIANTS` before it commits.
- **Limits are declared** in `LIMITS` (`src/config.ts`), mirrored in `docs/customizing.md`. Beyond one, behave as the
  specification says (capped coverage, a lower-bound count, an overflow row, a gap) and keep going.
- **Health is computed, never stored.** `src/snapshot.ts` derives it from readings, failures and active error
  problems, by both clocks, at the moment it is asked. Whether a problem is active is kept with it (`incidents.active`)
  and changed only in the transaction that measured it: a gauge by its breach, an occurrence problem by three
  ordinary fully measured intervals with nothing new.
- **Deadlines live on the service's clock.** A deadline is a number that every waiter shares (a trial run's, a
  source's next probe with its stored delay); nothing waits on a peer without one.
- **Evidence by handle.** Tools store a piece before returning it; a filing cites handles delivered to the same
  attempt, or is refused whole. A model never supplies a quote, a source or a confidence.
- **Restore rebuilds rows** into the owned database in one transaction: no file is moved into place, no SQL from a
  backup runs, every value passes the writer and its constraints.
- **Kubernetes is read-only by allowlist** (`checkKubectl`): only listed verbs, resources, flags and value shapes.

- **A model selects; code derives.** A fixer files one `ow_proposal` from options code computed (`Options` in
  `src/tools.ts`): a commit of the rollout to revert, a JSON scalar to restore, or abstain. Any other field, value,
  path or commit is refused and ends the attempt. `derive()` (`src/fixes.ts`) builds the commit from Git objects on the
  base tip in a private mirror and `check()` judges the whole tree (allowlisted existing regular files, same mode,
  not a verify input or a build, CI, lock or credential file, at most 3 files and 80 lines, 16 KiB).
- **Publication is one owner keypress.** The worker stops at a `verified` candidate; nothing is pushed, opened,
  followed or retried in the background. `POST /v2/fixes/:id/publish` (keyed and fenced by `basisSeq`) checks in its
  own transaction that the problem is not put away, both trial gates stand and the deployment is the finding's; then
  `publish()` runs the host steps while the owner waits, each with its intent and a permit bound to its exact
  arguments committed first (`intent()`), reconciling from the host before acting: base tip, branch, protection read
  positively, a push of the verified commit never forced, draft lookup, creation, read-back. A failure stops there with
  what exists on the host; the next keypress continues and never makes a second branch or pull request. Draft text
  passes `outbound()` (secrets and private paths) as a final document. Contract: revision 7 of
  `docs/plans/simple-core-interfaces.md`.
- **A green verify means something.** The verifier and every file it imports come from the base (a change touching
  one is refused); `sandbox-exec` runs it deny-by-default: no network, reads only of the system, the program's
  installation and the checkout, writes only in the checkout and its temporary folder; links are never followed. A
  real verify failure revokes the fix gate; each calibration credit is earned by its named operation.
- **Onset is the provider's.** A problem qualifies only if its first line's provider time is strictly after its
  deployment's rollout: the replica set's creation time when the cluster gives one, else the interval between the
  last observation of the previous revision and the first of the new one (never first-seen as an onset), with a
  clean, ordinary, fully measured interval before it.
- **Looking ahead never guesses.** A forecast needs six fresh, distinct, consistent provider samples in one provider
  unit (`forecast()` in `src/outlook.ts`); a staging comparison needs two aligned (same end, within a second), ordinary,
  fully measured intervals on both sides, and a production rollout invalidates it. Otherwise the answer is unknown,
  with the reason. An unknown monitor state, a reply that says it is partial and a point outside the queried window
  are gaps. A provider time is a type (`ProviderTime`, `src/parse.ts`), made from provider data by `time()`; the one
  cast, `answered()`, is for a live read that has no time of its own (pods, events, usage, logs read up to now,
  monitors) and a build test allows it only in the collector. Readings, samples and freshness reads take that type.

## The page

- The page is a Foldkit application on Effect 4 (`web/src/`), bundled by rolldown into `web/dist/`
  (`pnpm run build:web`; `prepare` runs it), which is all the service serves. One stylesheet on `tokens.css`.
  Each part (strip, banners, inbox, stage, finder, bar, sheets) keeps one file with a Schema Model, a tagged Message
  union, an `Events` union for its parent, a pure `update` returning the Model and Commands, and a `view`; the root
  folds them in with `Update.foldChild` and draws them with `h.submodel`. Commands (`Command.define`) are named Effect
  programs over the services in `web/src/services/` (`Overwatch` over `HttpClient`, `ServiceEvents`, `PageWindow`);
  reads are Commands too (no query cache). The change stream, clock, keys and document attributes are
  Subscriptions. Sheets are native modal `<dialog>`s (`components/Sheet.ts`).
- Foldkit stays thin, so a move back to Effect UI is mechanical: components import it only through `web/src/ui.ts`,
  the runtime only in `App.ts` and `entry.ts`, and `App.ts` opens with the table of each Foldkit piece and its Effect
  UI counterpart. `domain/`, `services/` and `model.ts` import no view layer.
- Foldkit paints on an animation frame; `entry.ts` runs this page's frame callbacks as microtasks, so a key press shows
  its result in the same task, as the suites require.
- The service decides; the page shows. Groups, health, why something came back and where a prompt goes are computed
  in `src/inbox.ts` and `src/snapshot.ts`. The page generates no identifiers (request keys come from `/v2/focus`).
- Page decisions that are not the service's (which rows are shown, what waits behind "N new", focus movement, the
  keyboard map, Later's words, staleness) live in pure modules (`web/src/model.ts`, `web/freshness.mjs`) tested by
  `test/page.test.ts`; `web/test/` tells the root's transitions as Foldkit stories. `web/freshness.mjs` stays plain
  JavaScript: the acceptance suite imports it.
- The page is pinned by `accept/m2`, `accept/m3` and `accept/m4` in Chrome: selectors, data attributes, keys, timing
  and clipboard text. A key that moves the caret (p, Enter, Esc in the bar) acts in the key press itself, and a group
  button shows its new state on the press: scripts type and loop straight after them.
- A return is decided in the transaction that commits its cause, and only for causes with a later seq than the
  action. Every disposition has one position, `decided_seq` (the action's, undo's or return's event seq, named
  inside the event by `Writer.next()`); an action given `basisSeq` is refused unless it matches.
- Freshness the page can compute: environments carry `readings` (when each was measured) and `freshForMs`, and the
  page ages them against the service's clock as last stated (`serverNow`, `cellHealth`). A deadline is a wall time plus a stored delay, bounded on the monotonic clock (`passed` in `src/inbox.ts`).
- Look at it: `test/real/screenshots.ts` renders the demo in dark, light, narrow, stale and down.

## Agents

- **Code decides.** `adjudicate()` (`src/agents.ts`) is a pure function of stored filings: planned slots are the
  denominator, a real majority needs an upheld challenge, *observed* needs telemetry in a real reading's claim. Never
  let a model's text set a verdict, a count or a confidence.
- **One queue, two slots.** Every reading, challenge and answer is a `work` row; `nextWork()` takes owner questions
  first. The trial shares `slots`. A `runs` row is one session's role, slot, evidence namespace and deadline; tools
  refuse a call outside the run's role.
- **Readers are independent.** Their inputs are frozen at admission (`inputs()`); no reading or challenger sees
  another's reasoning, handles or votes.
- **Playbooks are the database's.** `corrections` rows are authoritative; `Agents.playbooks()` rewrites the files
  whole. No agent writes them.
- **Text from logs, code or a model is data.** Prompts frame it as data; the page escapes every string; the writer
  cleans everything an agent writes, through the one write path.
- **Owner tools** serve only sessions the peer confirms and Overwatch does not run (any role, retired too).

## Tests

Use fakes for every outside system: the acceptance rig's fake `kubectl`, loopback Datadog and OpenCode. Never touch
a real cluster, Datadog account, OpenCode configuration or launchd agent from a test.
