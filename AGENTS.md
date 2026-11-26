# Agent guide

Overwatch is one Node process and one SQLite file (`src/`), run by `bin/overwatch`. Read `README.md`, then the
specification in `docs/plans/simple-core.md`, its amendments and `docs/plans/simple-core-interfaces.md`: the
interfaces document is the public contract, and `accept/m1/` is the acceptance suite that pins it.

## Working on the code

- Node 22.13 or newer. TypeScript that Node runs by stripping types: no enums, namespaces or parameter properties
  (`erasableSyntaxOnly`). No build step. Never Bun.
- **No runtime dependencies.** `"dependencies": {}` stays empty: Node's standard library only (`node:sqlite`,
  `node:http`, `fetch`, `node:child_process`). Dev dependencies are `typescript`, `fast-check`, `@types/node`.
- `pnpm run check` (typecheck and `test/`) before every commit; `pnpm run accept` for the acceptance suite. Never
  edit `accept/`: if a test there looks wrong, say so with evidence.
- Size budget: at most 5,500 lines of service code (nonblank, noncomment lines of `src/`). It was 5,000 until
  milestone 4: acting on Git (deriving, checking, verifying and publishing a fix) and looking ahead could not fit
  inside the old number without dropping a safety check, so the owner raised it once, and no further.

## Rules that hold because of how the data is shaped

- **One owner.** `Store.own` sets exclusive locking, enters WAL and commits a write before reading the schema or
  listening. No lock files, no pid checks. A second owner of any version fails with "database is locked".
- **One way to change anything.** `Store.tx` runs one `BEGIN IMMEDIATE` transaction; a change appends to `events`
  in the same transaction. `events` is append-only (triggers), except inside an explicit maintenance transaction
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
  connection. A `Writer` lives for one transaction; one kept past it throws. Foreign keys are deferred to commit.
- **The schema is declared once.** Every table in `TABLES` (`src/store.ts`) lists every column, and in `refs` each one
  that refers to a named parent ("table.key"). Restore checks every declared reference whatever the column is called;
  a build test fails when a created table has a column the list does not declare, and the class property fails until a
  row of a new referencing table is seeded. Whether a column is data or a reference is still the author's call.
- **One receipt per keyed owner write, from the router.** Keyed routes are declared only in the router's `KEYED` table
  (`src/server.ts`); a handler returns a `Plan` (operation, subject, body, change, optional outbound step) and
  `keyed()` wraps the change in its receipt. `receipt()` is private to `src/inbox.ts`, and a build test fails when the
  request key is read anywhere else.
- **Nothing leaves without an intent.** `src/exec.ts` is the only module that starts a program (a build test checks
  it); `run()` refuses outbound commands (`gh`, `git push`, the notifier) and `effect()` runs them only with a
  `Permit` that a `Writer` made in the transaction recording the intent, live once that commits and spent by its use.
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
- **Publication is gated effects.** Every attempt transition is compare-and-set on its `version`, so the owner's
  decline (or any newer decision) wins over a worker. Each host step and the push get their permit only from
  `gate()`, which checks right then: the owner has not stopped or decided, both trial gates stand, the deployment is
  the one the finding is about, the base tip is the candidate's, and protection is positively known to allow a push.
  After each effect the host is read back for the exact object (branch head, base, marker, draft); anything else is
  `unresolved` with a reason and a bounded retry. Only the verified commit is pushed, to `ow/fix/<attempt>`, never
  forced; nothing merges. Draft text passes `outbound()` (secrets and private paths) as a final document.
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
  are gaps. Consumers are given the time to compare against: passing the wall clock where a provider time belongs is
  still a convention.

## The page

- `web/` is served as it is: plain ES modules, one stylesheet on `tokens.css`, no bundler, no framework, no build.
- The service decides; the page shows. Groups, health, why something came back and where a prompt goes are computed
  in `src/inbox.ts` and `src/snapshot.ts`. The page generates no identifiers (request keys come from `/v2/focus`).
- Page decisions that are not the service's (which rows are shown, what waits behind "N new", focus movement, the
  keyboard map, Later's words, staleness) live in pure modules (`web/model.mjs`, `web/freshness.mjs`) tested by
  `test/page.test.ts`; `web/app.mjs` is the thin DOM around them.
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
