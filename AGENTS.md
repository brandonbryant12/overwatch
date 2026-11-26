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
- Size budget: about 5,000 lines of service code. Count nonblank, noncomment lines of `src/`.

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
  application key); refusals are shared only by equal identities.
- **One write path.** `Store.tx` runs `Store.guard` before every transaction (the collector installs the disk check),
  so slices, failure records, deadlines, page actions and tool writes are admitted by the same rule; only maintenance
  (`expire`, `retain`) bypasses it. Foreign keys are deferred to commit in every transaction.
- **References are declared.** SQL `REFERENCES` where the database must enforce them (cited evidence: `citations`, kept
  by a trigger on findings, RESTRICTs deleting it); every reference is also listed once in `REFERENCES`
  (`src/store.ts`), which restore checks. A new table is covered by adding its line.
- **Age, then pressure.** `Store.expire` removes by age on every pass; `Store.retain` adds old events under
  pressure. Neither can remove a finding or its cited evidence.
  `Store.reclaim` frees at most `LIMITS.reclaimBytes` per pass for any page size and truncates the WAL. Never run a
  full `VACUUM` while serving: it copies the whole file and holds the only connection until done.
- **Schema changes within version 1 are additive.** A new column has a default and an entry in `ADDED`
  (`src/store.ts`), so an older file gains it on open and an older backup restores into it. Restore checks the
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
