# Overwatch

**Local-first autonomous operations command center built on OpenCode 2, Alchemy Domain (`@alchemy.run/domain`), and Anomaly Rune (`anomalyco/rune`).**

Overwatch runs locally on your Mac (or headless on a remote server via Effect `Layer` swaps) and closes the full loop between observability, AI investigation, human judgment, and locally verified engineering changes:

```text
collect ──▶ detect ──▶ correlate & triage ──▶ investigate ──▶ verify & act ──▶ watch recovery ──▶ learn
 (code)     (code)      (code + agent)          (agent)      (agent + saga)       (code)       (judge + you)
```

## What runs today

| Stage | State | Where |
| --- | --- | --- |
| Collect | **Real.** Kubernetes pods and events, Datadog latency, error rate and throughput, Jenkins builds. Demo mode uses a simulator. | `packages/server/src/collector.ts` |
| Detect | **Real.** Watch rules are evaluated on every sweep with hysteresis. Pure functions, property-tested. | `packages/domain/src/detection.ts` |
| Open, correlate, recover, resolve | **Real.** The monitor opens one incident per breach, attaches concurrent breaches, and resolves only after K clean windows of fresh telemetry. | `packages/server/src/monitor.ts` |
| Notify | **Real.** macOS notification and dashboard toast when an incident opens or recovers. | `packages/connectors/src/notifier.ts` |
| Approvals and GitHub actions | **Real.** Crash-safe saga with reconciliation. Demo mode uses a fake GitHub. | `packages/domain/src/sagas.ts` |
| Triage, investigation, fixes, briefs, judge | **Scripted in demo mode only.** Live mode refuses these intents (HTTP 501) instead of inventing output. Wiring them to OpenCode sessions is the next milestone. | `packages/server/src/intents.ts` |

Known gaps: the OpenCode worktree call does not yet match the 2.4.1 contract, agents have no MCP tool surface yet, and the Datadog metric queries follow APM naming conventions that have only been tested against a fake (override them per environment with `datadog.metricQueries` if your service differs).

## How monitoring works

```text
every cadenceSeconds, per environment
  collect ─▶ fresh sample? ─▶ evaluate each watch rule ─▶ plan ─▶ domain commands
              │ no / coverage degraded                      │
              └─▶ detectors frozen, nothing judged          ├─ breach, no incident   ▶ OpenIncident (+ correlated signals)
                                                            ├─ breach, other rule    ▶ AttachSignal
                                                            ├─ all clear             ▶ EnterWatching, then RecordCleanWindow x K ▶ resolved
                                                            └─ relapse while watching ▶ ResetRecoveryWindow
```

- **Hysteresis both ways.** `hysteresisCount` consecutive samples over the limit open an incident, and the same number under it start recovery. One noisy sample does neither.
- **Unknown is never green.** Degraded coverage freezes detection. A metric that was not measured in this sweep gets no verdict, and a missing latency number is reported as lost coverage rather than zero.
- **One breach, one incident.** Incident ids derive from the environment, rule and breach start, so retries and stale views cannot open a duplicate. A dismissed incident does not reopen for the same breach.
- **Faster when it matters.** An open incident or an active rollout halves the cadence.
- **Samples are not events.** Metric samples live in a ring buffer. The event log records coverage changes and incident transitions only.

Try it in demo mode: open **Environments**, pick a healthy environment, press **Simulate regression**, and watch an incident open after two samples. **Simulate recovery** resolves it after three clean windows.

## Key Architectural Highlights

- **Zero-Postgres Event-Sourced Domain (`packages/domain` + `packages/sqlite-platform`):** Models `Incident`, `Run`, `Ask`, `Action`, `Brief`, and `Catalog` aggregates, multi-source `View`s, `Policy` reactions, and crash-safe `ExecuteAction` Sagas directly on a single local `overwatch.sqlite` (WAL) file via `@alchemy.run/domain/DurableObjects`. Swapping to `@alchemy.run/domain/EffectCluster` for remote headless deployment is a 1-`Layer` change.
- **Formally Verified Concurrency & Invariants:** Verified with `Domain.verify(OverwatchModel)`, exhaustive concurrent `Domain.Story` interleaving specs (tab ask races, mid-write crash reconciliation, OpenCode external reply races, premature recovery rejection, overnight laptop sleep), and `fast-check` property-based state machine fuzzing.
- **Credential-Blind, Sandbox-Free Security (`packages/connectors`):** Raw API keys and PATs never enter `overwatch.config.ts`, SQLite, UI state, or LLM prompts (`keychain:` / `env:` `SecretRef` resolution + two-pass deterministic redaction). The per-role OpenCode permission rules (`compileSessionPermissions`) deny `shell`/`edit`/`webfetch` to investigation roles so untrusted logs and spans cannot trigger edits or exfiltration; they take effect once agent runs are connected.
- **Sleep-Native Local Operation (`packages/server`):** `WakeCoordinator` monitors wall-clock vs monotonic uptime to detect laptop naps and overnight sleep, coalesces missed schedules, resets `watching` recovery windows so stale pre-sleep samples never resolve incidents, and tracks `Run` budgets in awake monotonic time.
- **Dual Zero-Business-Logic Clients (`crates/overwatch-app` + `packages/web`):**
  - **Anomaly Rune Native GPU App (`crates/overwatch-app`):** Rust + `wgpu` desktop cockpit using auto-generated `overwatch-protocol` types from `/openapi.json`, custom GPU sparklines & `usage/request/limit` bars (`overwatch-viz`), and built-in headless PNG/runtime testing.
  - **Web Cockpit (`packages/web`):** Served directly by the Bun daemon at `GET /`, staying gap-free across multiple tabs via resumable SSE (`/api/stream?after=<cursor>`).

## Workspace Layout

```text
overwatch/
  overwatch.config.ts            # Schema-validated, credential-blind fleet & budget config
  Cargo.toml                     # Rust workspace pinned to anomalyco/rune
  packages/
    domain/                      # Pure @alchemy.run/domain aggregates, views, policies, sagas, stories
    sqlite-platform/             # Local DurableObjects.Host + WorkflowEngine on bun:sqlite (WAL)
    connectors/                  # Kubernetes, Datadog (paired trace diffs), Jenkins, GitHub, Notifier, Redactor
    emulator/                    # Stateful local K8s, Datadog, Jenkins & GitHub emulators (vercel-labs/emulate)
    server/                      # Bun daemon: collector, monitor loop, intents, request guard, telemetry store,
                                 #   WakeCoordinator, OpenCode 2 bridge, HTTP/OpenAPI/SSE
    web/                         # Zero-business-logic web cockpit served at GET /
  examples/
    checkout-api/                # Sample app with N+1 regression & perf test for closed-loop agent runs
  crates/
    overwatch-protocol/          # Auto-generated Rust serde types from /openapi.json
    overwatch-client/            # HTTP/SSE transport (native + wasm32 seam)
    overwatch-viz/               # Custom Rune GPU sparklines & resource utilization bars
    overwatch-app/               # Native Anomaly Rune desktop cockpit + headless tests
  agents/                        # OpenCode 2 role prompts (triage, investigator, explorer, fixer, scribe, judge), skills & playbooks
  evals/                         # Frozen incident replay cases & cross-model judge rubrics
  scripts/                       # OpenAPI -> Rust protocol codegen & eval replay runner
```

## Quick Start

### 1. Install & Run the Daemon + Web Cockpit (Demo Mode)

Demo mode boots out-of-the-box with zero external credentials, seeding a realistic multi-environment fleet (`checkout-api`, `billing-worker`, `identity-edge`, `ledger-ingest`), an active Rollout Watch regression (`INC-42`), degraded staging EKS SSO coverage, a pending `Needs me` Draft PR approval, overnight trace-walk insights, and team briefs:

```bash
bun install
bun run start
# Open http://127.0.0.1:4720
```

To connect live local `kubectl`, Datadog, Jenkins and GitHub (`gh`), configure `overwatch.config.ts` and run:

```bash
OVERWATCH_MODE=live bun run start
```

Live mode starts empty: no demo telemetry, no demo incidents, and every environment shows unknown coverage until its first collection. Demo and live state are kept in separate databases.

| Variable | Effect |
| --- | --- |
| `OVERWATCH_MODE` | `live` or `demo` (default). |
| `OVERWATCH_PORT`, `OVERWATCH_HOST` | Listen address. Default `127.0.0.1:4720`. |
| `OVERWATCH_DB` | Database file. Default `~/.local/share/overwatch/overwatch-<mode>.sqlite`. |
| `OVERWATCH_CADENCE_SECONDS` | Overrides every environment's collection cadence. Demo defaults to 10. |
| `OVERWATCH_SILENT_NOTIFY=1` | Suppresses macOS notifications. |
| `OVERWATCH_ALLOWED_HOSTS` | Comma-separated extra hostnames the daemon may be reached under. |
| `OPENCODE_TOKEN` | Bearer token for the OpenCode service. |

### Local API security

The daemon carries the operator's authority, so being bound to loopback is not treated as access control. Every request must name an allowed `Host` (which stops DNS rebinding), and any request with an `Origin` must come from the daemon's own origin. Writes must be `application/json` POSTs. No CORS headers are sent, so other sites can neither drive the daemon nor read its state. Native clients send no `Origin` and are unaffected.

### 2. Run the Native Anomaly Rune Desktop App

Requires Rust `1.85+` (`rustup` stable):

```bash
bun run rune:run
# Or render headless PNG snapshots of any scene:
cargo run -p overwatch-app -- --snap preview-now.png --scene now
```

### 3. Run Verification Suites

```bash
# Typecheck + Domain.verify + concurrent Domain.Story specs + fast-check invariants (incidents, detection)
# + SQLite + connectors + the end-to-end monitor loop and request guard
bun run typecheck
bun test

# Replay frozen eval cases
bun run evals:replay

# Run the stateful local K8s/Datadog/Jenkins/GitHub emulator stack (vercel-labs/emulate)
bun run emulator:start

# Run the closed-loop verification harness (reproduce -> patch -> verify -> GitHub issue -> deploy #483 -> verify recovery)
bun run loop:emulated
# Or drive the fix using an OpenCode free-tier model (e.g., opencode/big-pickle, opencode/deepseek-v4.1-flash-free):
OVERWATCH_USE_OPENCODE=1 OVERWATCH_FREE_MODEL=opencode/big-pickle bun run loop:emulated

# Regenerate Rust protocol types from DomainHttp /openapi.json
bun run codegen:protocol

# Run Rust workspace + headless Anomaly Rune UI runtime tests
bun run rune:test
```
