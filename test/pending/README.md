# Pending guarantees

These tests describe observable behavior on the command-center branch. The builder's job is to make each test pass without weakening it, then move it into `test/` as a `.test.ts` file. Adjust relative imports and promote shared fixtures into `test/fixtures/` as needed. Keep the same assertions, inputs, fault points and external checks. The normal `pnpm test` glob deliberately excludes this directory. Type checking includes it.

Run from the repository root with the project's Node and dependencies. The rendered tests require a built page (`pnpm run build:web`) and Chrome or Chromium, with `CHROME_BIN` available to specify its path. The trial requires an OpenCode 2.4.1 executable on PATH or at `OPENCODE_BIN`. Git must be available. Tests use temporary data, fake telemetry, loopback connections and isolated browser profiles. The desktop command exit-status check exercises the macOS adapter on Darwin. No login or live model key is needed.

```sh
node --experimental-strip-types --no-warnings --test test/pending/<file>.pending.ts
```

For example, `node --experimental-strip-types --no-warnings --test test/pending/durability.pending.ts` runs just the durability cases. To run all files together, use `node --experimental-strip-types --no-warnings --test --test-concurrency=2 test/pending/*.pending.ts`. Each entry below gives the filename for a single-file run.

## Existing behavior

| File | What it pins |
| --- | --- |
| `lock.pending.ts` | Two OS processes race for one DB, then release or die while holding it. Exactly one wins each round, including after stale holder metadata or an older installation's lock file. |
| `evidence.pending.ts` | Every non-elided part of a source quotation must match that source, including short words. A filename collision cannot validate telemetry. Query parameters must stay separate from real MCP output. Synthetic credentials pass through collection, page, adopted OpenCode messages, findings and owner decisions. |
| `fields.pending.ts` | Rotates eight synthetic credential formats across finding fields and checks the next real investigation prompt plus all database tables. Caller-provided prompt identifiers are also inputs. Rejecting an unsafe identifier or mapping it to an opaque one satisfies the storage contract. |
| `durability.pending.ts` | SQL aborts and OS-level process death before/after collector writes, upstream additions in a different order, duplicate polls and a log group over the 200-example cap. Backup at dispatch and backup of two offline jobs preserve inbox, search and work. Counts include observable occurrences exactly once. External starts are counted independently of the restored database. |
| `daily.pending.ts` | Generated sequences of owner actions, recurrence, deploy, finding and restart preserve membership, reasons and group priority. Includes three Done returns, rate and severity breakthrough and a two-occurrence batch with a determinate count across the grace boundary. |
| `ordering.pending.ts` | A blocked deploy reader must respect journal order in both directions. Two live tabs reading different rows in one browser must preserve both seen marks. |
| `health.pending.ts` | Quiet requires a recent successful status and all expected measurements across sources. Includes a sleeping tab with failed refreshes and a skipped command poll during back-off. Sign-in and connectivity failures recover after restart with one cause, one suspension and the original incidents. |
| `recovery.pending.ts` | Code files and their SHA agree with the deployed label after an interrupted checkout. Restore preserves the destination on an unwritable schema. Notification intents survive ordinary delivery failure without duplicate concurrent sends or sensitive diagnostics. |

The generated cases use fast-check with bounded run counts to keep the real processes practical. Most have seed 62188. A failing property prints a seed and shrink path. These are repeatable samples of inputs and interleavings. The tests check logical SQLite table contents and captured messages, without claiming forensic erasure or exhaustive recognition of arbitrary strings. The backup equivalence test permits projection catch-up and separately checks external side effects. It does not set a startup latency target.

## Ready for the real thing

| File | Entry point and acceptance contract |
| --- | --- |
| `doctor.pending.ts` | `overwatch doctor --json` emits `{checks:[{id,ok,detail,fix?}]}` and fails the process when any check fails. The IDs cover launchd, each configured cluster context, registry, native binding, binary discovery, OpenCode connectivity and an answering model. Each failure identifies an action and cluster remedies name the affected context. The same CLI handler is exported as `doctorCommand(args, ports, write)` by `src/service/doctor.ts`. Its fixture supplies raw observations such as a 407 proxy response, an empty model response and a non-running agent. Each check can be exercised independently of the other checks. |
| `trial.pending.ts` | `overwatch trial --cases <file> --json` uses the configured OpenCode model with blinded JSON seeds. Stdout carries ordered case records with ID, filing status, matched/total quote counts, verdict correctness and filing attempts. Stderr carries the human report. A completed trial exits zero even when the model gets a verdict wrong. Real loopback model requests independently confirm the scores. One filing try is one `file_finding` invocation, including rejected attempts. Known answers stay out of the prompt. |
| `brief.pending.ts` | `brief build --app APP --from ISO --to ISO --json` produces a stable `{id,text}` from journal events in the period. `local/glossaries/<app>.json` maps service names and routes to customer language. `brief edit ID --text TEXT` preserves the owner's version across later eligible events. `brief copy ID` and `brief export ID --out FILE` produce exactly the edited text. The fixture watches CLI and service fetches and captures clipboard bytes locally. |
| `feedback.pending.ts` | A filed finding on the page exposes “Correct this finding”, “What actually happened?” and “Save correction” as accessible control names. A repeated save appends one dated line to `local/playbooks/<app>.md`, preserving existing content. Local files default to `<dataDir>/local`; CLI configurations can set `localDir`. The next investigation receives the correct app's lesson. Its page displays the used line on the relevant session, identifiable by `data-playbook-session`. |
| `challenge.pending.ts` | A filed real finding displays “awaiting independent check”. A distinct OpenCode session receives its claim and a disproof task, can file a contrary `not_real` finding through the existing MCP boundary, and leaves both sessions and the reason in history. The page displays “disproved” and that reason. |

## Fixtures

`support.ts` wraps the repository service fixture, typed domain client and SQLite inspection. `outbox-child.ts` exits by SIGKILL at the selected SQL boundary. `cli.ts` runs the real CLI with temporary HOME, configuration and data. `page.ts` opens temporary Chrome targets over CDP, including two tabs with shared local storage. `scripted-provider.ts` uses the investigator script from `scripts/e2e.ts` and records its outputs. The current e2e script boots the service on import. When promoting the trial, extract the single provider fixture for both callers.
