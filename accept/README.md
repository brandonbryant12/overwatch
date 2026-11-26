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

## Independent kernel review and page acceptance

The release suite now includes three additional M1 files. `collection-edges.test.mjs` observes provider coverage, event-time admission, gauge problems and recovery through status. `storage-edges.test.mjs` exercises concurrent startup, clock rollback, logical restore invariants, pressure during maintenance and real file reclamation. `adapter-edges.test.mjs` covers both Basic credential sources, scoped catalogs, effective diagnostics, elapsed budgets, concurrent trial driving and the model gate. Set M1_OTHER_BIN to the executable of a compatible checkout to exercise both ownership directions. Expected outcomes on the assessed commit are in the milestone assessment.

Run the page contract independently:

```sh
node --no-warnings --test --test-concurrency=2 accept/m2/*.test.mjs
```

Use the shared heavy-command prefix on the iMac. M2 adds no packages. Server tests use the existing temporary rig. The pure module test imports the public page freshness function. Rendered tests start a separate temporary Chrome profile over a debugging pipe. They use the installed system Chrome or CHROME_BIN, and print a skip reason if neither exists. The clock fixture cuts the actual event stream and holds status open while Chrome advances its own timers. Two fixture tests can pass before there is a page. Product tests that first encounter a missing route or module fail there; their later assertions become reachable during implementation.

## Milestone 2 assessment and milestone 3 acceptance

The expanded M1 and M2 suites include the neighbouring cases from the independent page assessment. Run the same release commands above. For a single case use `node --no-warnings --test --test-name-pattern='N07' accept/m1/neighbours.test.mjs`, for example. N20 is the 65,536-byte page variant in storage-edges. The separate owner timing run drives system Chrome and prints elapsed time from keyboard input through visible completion for the demo and a 200-incident, six-environment service.

```sh
/Users/brandon/.local/bin/codex-heavy -- node --no-warnings --test --test-concurrency=1 accept/m2/owner-timing.mjs
/Users/brandon/.local/bin/codex-heavy -- node --no-warnings --test --test-concurrency=2 accept/m3/*.test.mjs
```

M3 is specified ahead of the implementation. The fixtures use the executable, temporary OpenCode and Datadog peers, scripted independent readings through actual MCP calls, a disposable notification executable with an exit-code ledger and system Chrome with an isolated clipboard substitute. Product cases may stop at a missing interface on M2. The fake notifier control can run today. A green control verifies the fixture alone. See the revision 4 interface contract and `docs/plans/m2-independent-assessment.md` for scope, measured results and outstanding owner checks.

## Milestone 3 assessment and prospective milestone 4

The M1 assessment neighbours use A01–A21 for the original kernel defects and B numbers for the eight M2 kernel probes that broke. A20 is in storage-edges. The M2 U cases exercise rendered measurement freshness, brief editing and a disposition that changes and then returns to the same visible state. The separate owner-timing driver now populates completed, running and queued investigations, a parked answer and 200 real fixture problems. B, edit, Tab and Enter must copy the exact edited bytes.

M3 adds tests of peer delivery, durable filing and request boundaries, evidence provenance, scoped model inputs, answering and brief language, and notification recovery. The transition suite kills the real service at ten externally observable investigation stages. Its oracle checks the contents and identity of a committed filing. The cadence test advances the service clock through one day; the provider and model remain local fixtures.

```sh
/Users/brandon/.local/bin/codex-heavy -- node --no-warnings --test --test-concurrency=2 accept/m3/*.test.mjs
/Users/brandon/.local/bin/codex-heavy -- node --no-warnings --test --test-concurrency=2 accept/m4/*.test.mjs
```

M4 implements the assessor side of revision 5 only. The disposable bare Git remote accepts candidate branches and logs attempted ref updates. The fake gh records draft status, head, base and body, and lets the fixture drive an external close or merge. The service sees these changes through its ordinary scheduler. Tests exercise an unearned gate, an investigation-only gate, a disallowed proposal, failed app verification, a planted change request, both draft lifecycles, a short and a noisy series, and staging compared with both complete and missing production data. On M3 the fixture control runs; prospective scenarios stop at the unsupported M4 configuration keys. See the assessment for observed pass/fail counts and focused reproduction commands.

## Independent milestone 4 review

The current M4 rules are in revision 6 of the interface contract. The draft fixture can install a selected multi-commit or merge rollout, different production sighting and replica-set clocks, a later base, and timed host-ledger barriers. Product Git operations target a disposable local bare remote. The fake host can independently fail, time out, report the wrong PR or retain a created draft across SIGKILL. Every acceptance assertion runs against the unchanged product. Deliberately failing regressions are part of the release ledger.

Run the four milestone globs as above. The optional native run takes a separately unpacked macOS arm64 OpenCode 2.4.1 executable. The provider, cluster, Git remote and PR host are local fixtures.

```sh
OPENCODE_BIN=/absolute/path/to/package/bin/opencode node --no-warnings --test accept/m4/native.mjs
node accept/m4/setup.mjs
/Users/brandon/.local/bin/codex-heavy -- node accept/m4/extensions.mjs
/Users/brandon/.local/bin/codex-heavy -- node --no-warnings --test --test-concurrency=1 accept/m2/owner-timing.mjs
```

The timed fleet has 200 real fixture problems across six watched namespaces. A Chrome response fixture adds display examples of every fix, forecast and comparison state. The write routes, search, focus, queue and clipboard checks still exercise the real page and service. The native and publication tests separately exercise the states a verifier or host actually produced. The installation exercise clones the assessed revision and runs the guide examples with an isolated home and launchctl ledger.

The release glob includes the explicit macOS isolation-unavailable and 5,500-line budget controls in `m4/platform.test.mjs`. To check the setup guide's role count and doctor exit-code promise separately, run `node --no-warnings --test --test-concurrency=1 accept/guide-contract.test.mjs`.
