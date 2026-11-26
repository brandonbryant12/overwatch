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
- **Limits are declared** in `LIMITS` (`src/config.ts`), mirrored in `docs/customizing.md`. Beyond one, behave as the
  specification says (capped coverage, a lower-bound count, an overflow row, a gap) and keep going.
- **Health is computed, never stored.** `src/snapshot.ts` derives it from readings, failures and open errors, by both
  clocks, at the moment it is asked.
- **Evidence by handle.** Tools store a piece before returning it; a filing cites handles delivered to the same
  attempt, or is refused whole. A model never supplies a quote, a source or a confidence.
- **Restore rebuilds rows** into the owned database in one transaction: no file is moved into place, no SQL from a
  backup runs, every value passes the writer and its constraints.
- **Kubernetes is read-only by allowlist** (`checkKubectl`): only listed verbs, resources, flags and value shapes.

## Tests

Use fakes for every outside system: the acceptance rig's fake `kubectl`, loopback Datadog and OpenCode. Never touch
a real cluster, Datadog account, OpenCode configuration or launchd agent from a test.
