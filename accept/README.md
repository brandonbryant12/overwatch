# Milestone 1 acceptance

These tests belong to the independent assessor. The builder makes them pass without editing them. Report a test believed to be wrong with its seed, trace and the contract clause in dispute. Run from the repository root with Node 22.13+ and the pinned development dependency `fast-check`. The program under test is `bin/overwatch`. [Binding interfaces](../docs/plans/simple-core-interfaces.md) · [Amendments](../docs/plans/simple-core-amendments.md)

```sh
# One file
node --no-warnings --test accept/m1/storage.test.mjs

# Routine suite, bounded file-level concurrency
node --no-warnings --test --test-concurrency=2 accept/m1/*.test.mjs

# Release run: both storm sizes, the byte cap, and SIGKILL after every measured write
M1_LONG=1 node --no-warnings --test --test-concurrency=2 accept/m1/*.test.mjs

# Also exercise a separately installed compatible predecessor when one exists
M1_OTHER_BIN=/absolute/path/to/older/bin/overwatch node --test accept/m1/storage.test.mjs
```

On the shared iMac, prefix the Node suite command with `/Users/brandon/.local/bin/codex-heavy --` and put environment assignments before that prefix. No registry access, account credentials, running service, launchd changes or model downloads are needed. The repository's legacy test glob excludes these files. The fast suite samples the first, middle and last SQL write. The release sweep derives its cuts from an actual successful poll on the same input. OS process kills exercise SQLite recovery, not a mock rollback.

| File under m1 | What it pins |
|---|---|
| commands.test.mjs | Offline validation at and beyond watcher/source/interval limits, independent doctor results and concrete repairs, isolated demo data |
| storage.test.mjs | Two services and an independently implemented SQLite contender, frozen-wall event order, deployment revision, actual SIGKILL across Kubernetes and Datadog commits, backup equality, rejected restore preserving existing rows |
| counts.test.mjs | Generated multisets, nanoseconds, duplicates, late data, pod/container identity, replay after restart, event deltas, Datadog pagination/monitors/metrics, observable rotation, overflow, 14-day catch-up, storm and byte caps |
| health.test.mjs | Missing or hanging measurements, sign-in and permission scope, rate limit, persistent back-off, cause grouping and recovery, disk pressure, live stream and independent heartbeat |
| redaction.test.mjs | Generated secret forms across logs, IDs, errors, evidence requests, finding fields, model replies, CLI/API/peer output, durable rows, raw SQLite bytes and row import |
| trial.test.mjs | Five calibration cases, incorrect verdict, malformed/empty/foreign citations, benign planted instruction, rambling and successful models, nudge/retry accounting, provenance, pinned git objects, concurrency, evidence and elapsed-time budgets, reconciling an active snapshot |
| fixtures.test.mjs | Independent green checks for the fake executable, pagination, peer message deduplication, MCP initialization, credential and tool-session metadata |
| rig.mjs | Temporary home, real git checkout, executable entry point, service readiness, test descriptor, real process lifecycle and offline read-only inspection |
| fake-cli.mjs | PATH-isolated kubectl, launchctl, native version and gh commands; counted calls, identity-aware log bytes, simulated sign-in and permission failures |
| peers.mjs | Loopback Datadog API, OpenCode 2 session/message API and scripted model that actually calls the product's MCP endpoint |

A fixture never imports the application, old tests or plugin. The normal startup preflight checks configuration revision 2. A red result there on the pre-rewrite branch means the downstream assertion has yet to run. Tests open the live data file only **after** stopping the service and only read-only for inspection. The competing SQLite executable attempts writer ownership, without inspecting business data. Malformed database inputs are separate disposable copies. The writable temporary directory is removed at teardown.

## Decisions the builder should know

The test descriptor replaces clocks, space readings and scheduling, and exposes statement/commit cut points. It cannot manufacture an incident, a filing, a successful read or a transaction. An explicit poll awaits the real due-work path. If the implementation changes its statement count, the crash oracle adjusts. Source/field names, CLI exit codes, readiness line, trial scores, fixtures, and effective tool/session identities are fixed in the interfaces document.

Every successful citation must resolve to the redacted bytes returned in that attempt. The trial uses local, labeled cases and a harmless compliance marker. It must pass through the configured OpenCode boundary. The fake's ledger counts actual sessions and messages independently of the program's report. The single-writer stand-in tests OS-level exclusion today. A distinct release, owner's GLM endpoint, corporate proxy/launchd, two-day laptop run and M2 browser disconnect remain separate acceptance gates. A finite generated suite cannot establish correctness for every history or recover an upstream event that left no distinct observation.
