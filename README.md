# Overwatch

**Local-first autonomous operations command center built on OpenCode 2, Alchemy Domain (`@alchemy.run/domain`), and Anomaly Rune (`anomalyco/rune`).**

Overwatch runs locally on your Mac (or headless on a remote server via Effect `Layer` swaps) and closes the full loop between observability, AI investigation, human judgment, and locally verified engineering changes:

```text
collect ──▶ detect ──▶ correlate & triage ──▶ investigate ──▶ verify & act ──▶ watch recovery ──▶ learn
 (code)     (code)      (code + agent)          (agent)      (agent + saga)       (code)       (judge + you)
```

## Key Architectural Highlights

- **Zero-Postgres Event-Sourced Domain (`packages/domain` + `packages/sqlite-platform`):** Models `Incident`, `Run`, `Ask`, `Action`, `Brief`, and `Catalog` aggregates, multi-source `View`s, `Policy` reactions, and crash-safe `ExecuteAction` Sagas directly on a single local `overwatch.sqlite` (WAL) file via `@alchemy.run/domain/DurableObjects`. Swapping to `@alchemy.run/domain/EffectCluster` for remote headless deployment is a 1-`Layer` change.
- **Formally Verified Concurrency & Invariants:** Verified with `Domain.verify(OverwatchModel)`, exhaustive concurrent `Domain.Story` interleaving specs (tab ask races, mid-write crash reconciliation, OpenCode external reply races, premature recovery rejection, overnight laptop sleep), and `fast-check` property-based state machine fuzzing.
- **Credential-Blind, Sandbox-Free Security (`packages/connectors`):** Raw API keys and PATs never enter `overwatch.config.ts`, SQLite, UI state, or LLM prompts (`keychain:` / `env:` `SecretRef` resolution + two-pass deterministic redaction). Untrusted production logs/spans cannot trigger code edits or exfiltration because investigation agents run with `shell`/`edit`/`webfetch` denied at the OpenCode 2 per-session permission layer.
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
    server/                      # Bun daemon: Plane-1 telemetry, WakeCoordinator, OpenCode 2 bridge, HTTP/OpenAPI/SSE
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

To connect live local `kubectl`, Datadog, Jenkins, GitHub (`gh`), and OpenCode `2.4.1+`, configure `overwatch.config.ts` and run:

```bash
OVERWATCH_MODE=live bun run start
```

### 2. Run the Native Anomaly Rune Desktop App

Requires Rust `1.85+` (`rustup` stable):

```bash
bun run rune:run
# Or render headless PNG snapshots of any scene:
cargo run -p overwatch-app -- --snap preview-now.png --scene now
```

### 3. Run Verification Suites

```bash
# Typecheck + Domain.verify + 5 Concurrent Domain.Story specs + fast-check invariants + SQLite + Connectors + Server
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
