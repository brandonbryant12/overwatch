# Forking Overwatch for a Corporate Environment

Overwatch is built to be forked once into your company's internal Git host, configured for your clusters, Datadog site, read-only databases, and local OpenCode model (such as GLM 5.3 on local GPUs), and kept up to date with upstream through low-conflict merges.

The goal is simple: **90% of corporate customization lives in configuration, skills, and playbooks — zero edits to `src/`.**

---

## 1. Upstream vs. Downstream Ownership Boundary

Keep your fork's diff small so `git fetch upstream && git merge upstream/main` stays mechanical.

| Layer | Files | Upstream / Fork Strategy |
| --- | --- | --- |
| **Core kernel** | `src/store.ts`, `src/inbox.ts`, `src/server.ts`, `src/exec.ts`, `src/agents.ts`, `src/fixes.ts`, `src/tools.ts`, `src/db.ts`, `src/parse.ts` | **Keep upstream-pure.** These enforce Overwatch's "true by construction" invariants (single writer, `Permit`-gated outbound effects, `ProviderTime`, handle-bound evidence, read-only SQL guards, `WRITES` route guards) and stay within the 5,500-line service budget. |
| **Shared corporate config** | `examples/corp-base.json` (or `config/corp-base.json` in your fork) | **Fork-owned.** Committed in your internal fork: Datadog `baseUrl`, `redactPatterns`, `apps.<app>` sources, `policy` defaults and per-env overrides, read-only `databases`, `spans`, `commitWatch`, `problemPatterns`, `fixes`, `promotion`, and local GPU `opencode` tuning. |
| **Personal overrides** | `~/.config/overwatch/config.json` (outside Git) | **Engineer-owned.** Uses `"extends"` (relative or `~/`) to inherit the fork's base config and overrides only local `checkout` paths, `dataDir`, `mcpToken`, `keychain:` secret refs, personal `policy` tweaks, and `watchers`. |
| **OpenCode owner skill** | `skills/overwatch/SKILL.md` | **Fork-extensible.** Append internal runbook links, cluster login commands, or QA environment conventions while keeping the core MCP tool instructions (`ow_inbox`, `ow_get`, `ow_search`, `ow_act`, `undo`, `ow_brief`, `ow_outlook`, `ow_db`). |
| **App playbooks** | `<dataDir>/playbooks/<app>.jsonl` | **Database-owned per laptop.** Written through "Was this right?" (`y`); never hand-edited. |
| **Custom adapters & integrations** | `src/config.ts`, `src/collect.ts`, `src/failures.ts`, `src/<adapter>.ts` | **Only if adding a new telemetry provider, webhook, or internal RPC tool.** See Section 7 ("What's Intentionally Left for Corporate Forks") below. |
| **UI & Declarative GenUI** | `web/src/` (`web/dist/`) | **Upstream-preferred.** `web/` is outside the 5,500-line `src/` budget; see [genui.md](genui.md) for adding custom declarative lens blocks if needed. |

**Recommended Git workflow:**

```sh
git remote add upstream <upstream-overwatch-url>
git fetch upstream
git checkout -b corp-main
# Keep corporate config templates in config/ (or examples/) and skill additions at the end of skills/overwatch/SKILL.md
git merge upstream/main
pnpm run check && pnpm run build:web
```

---

## 2. Config Layering with `extends` & `launchd` Secret Scanning

Overwatch validates configuration strictly (`onExcessProperty: "error"`), offline, before starting. To avoid duplicating cluster contexts, Datadog queries, redaction patterns, per-env policies, and DB templates across every engineer's laptop, use `"extends"`:

- `"extends": "./corp-base.json"`, `"extends": "~/src/corp-overwatch/examples/corp-base.json"`, or `"extends": ["./corp-base.json", "./team-payments.json"]` (left-to-right chain).
- Both relative paths (resolved from the config file that names them) and **`~/` home-relative paths** are expanded automatically; circular `extends` chains are refused by `overwatch check`.
- Plain objects deep-merge (child keys override parent keys, so you can override a single `policy.readings` field or a single `databases.primary.dsn` reference without repeating the rest); arrays and primitives replace.
- The merged result is validated as one `version: 2` configuration, so typos or invalid SQL templates in either base or override fail immediately with the exact path to fix.
- **`launchd` merged secret check**: `overwatch install` scans the **merged** configuration (base layers plus personal overrides) for `env:` secret references — including database `dsn` values inherited from `corp-base.json` — and refuses installation if any remain, because `launchd` does not inherit your interactive shell environment. Override inherited `env:` refs with `keychain:` in `~/.config/overwatch/config.json`.

**Three-layer pattern:**

1. **`corp-base.json`** (committed in your fork): `redactPatterns`, shared `opencode` defaults, Datadog `baseUrl`, org-wide `problemPatterns`, shared `apps`, per-environment `policy` tiers, and read-only `databases`.
2. **`team-<name>.json`** (optional, committed in your fork): team-specific `apps`, `spans` thresholds, `commitWatch`, `promotion`, `databases`, and `fixes` allowlists.
3. **`~/.config/overwatch/config.json`** (on each engineer's laptop): `"extends"` pointing to your fork checkout (`~/...`), local `checkout` paths, `keychain:` secret references, and the `watchers` you care about today.

See ready-to-copy templates in [examples/corp-base.json](../examples/corp-base.json) and [examples/personal-override.json](../examples/personal-override.json).

---

## 3. Tuning for Free, Unlimited Local GPU Inference (OpenCode + GLM 5.3)

Overwatch's defaults (`readings: 3`, `opencode.concurrency: 2`, `opencode.toolCalls: 8`, `opencode.genUi: false`) are conservative so metered APIs stay fast and cheap.

When your corporate workstation or local GPU box runs **OpenCode with GLM 5.3** (zero marginal token cost), free inference becomes an architectural advantage: instead of trusting one brittle pass, you spend free tokens on **broader parallelism, deeper evidence traversal, independent angles, and structured visual synthesis** — while code still adjudicates every verdict and verifies every handle.

```json
{
  "readings": 5,
  "opencode": {
    "url": "http://127.0.0.1:4096",
    "model": "local/glm-5.3",
    "password": "keychain:overwatch/opencode",
    "concurrency": 4,
    "toolCalls": 16,
    "genUi": true
  }
}
```

### What each knob unlocks

| Key | Default | Local GPU (GLM 5.3) | Effect |
| --- | --- | --- | --- |
| `readings` | `3` | `5` | Runs 5 independent investigator sessions per incident from 5 distinct starting angles: (1) telemetry, (2) deployed change, (3) harmless explanation, (4) **latency & resource saturation**, (5) **recent commits & config drift**. Strict majority requires > half of all planned slots (3 of 5), and a fix candidate requires unanimous real readings (5 of 5) plus an upheld challenger. |
| `opencode.concurrency` | `2` | `4` (up to `6`) | Shared semaphore across readings, challengers, owner answers, fixers, and trials. Lets all 5 readings + challenger finish in roughly two wall-clock waves while keeping owner questions (`priority 0`) instant. |
| `opencode.toolCalls` | `8` | `16` (up to `24`) | Allows each session to page deeper through `ow_telemetry` (including slow-span traces), run multiple `ow_code_search` / `ow_code_read` hops, inspect `ow_history`, and query read-only `ow_db` targets before filing. |
| `opencode.genUi` | `false` | `true` | Enables on-demand AI synthesis (`POST /v2/items/:id/lens`, `g` key) of structured visual lenses grounded strictly in stored evidence handles (also overridable per app/env via `policy.genUi`). See [genui.md](genui.md). |

### Continuous Signal Coverage (Spans + Commits) & Calm "What's New" Overview

With free local inference, turn on the two proactive signals in your corporate base config:

- **Datadog Slow Spans (`spans`)**: Opt-in per Datadog source (`"spans": { "slowMs": 1500, "warnMs": 750, "query": "service:checkout env:prod" }`). Overwatch queries `/api/v2/spans/events/search`, deduplicates every slow span by its Datadog span ID in `occurrences`, normalizes fingerprints as `span:<service>:<resource>`, and stores structured lines (`SLOW <durationMs>ms <service> <resource> trace=<id>`) so investigators and the UI's `span_waterfall` lens work off exact stored timings.
- **Continuous Commit Watcher (`commitWatch`)**: Opt-in per app (`"commitWatch": { "branch": "main", "paths": ["config/", "db/migrations/"], "limit": 20 }`). Uses read-only `git rev-list` and `--numstat` against your local `checkout` to track new commits as they land, compute deterministic code risk flags (`config`, `database`, `auth`, `timeout`, `large_diff`, `unreleased` vs `deployed`), and surface them calmly in `GET /v2/outlook`, `ow_outlook`, the Overview board, and `commit_risk` lenses without spamming the inbox.
- **Calm "What's New" Overview**: Opening the page (or clicking the topbar **`Overview`** button, which shows a subtle amber unseen badge only while you are focused on an item and new items exist) displays a bounded **What's new** card below Environment pulse. Items are grouped and capped (verified/draft fixes ready, returned problems, new problems, recent commits & deploys, and quieted recoveries). Clicking **`Mark caught up`** saves your sequence checkpoint (`ow-caught-up` in `localStorage`) and collapses the card to a single quiet line (`Caught up since <ago>`); first visits or sequence resets (fresh `demo` or restored DB) automatically fall back to a calm **24-hour window**, and the card links straight to `GET /v2/brief?afterSeq=<seq>` for an instant fence-bounded brief.

---

## 4. Per-App / Per-Environment Policy & Autonomy Boundaries

Overwatch separates **investigation** (read-only), **fix derivation & verification** (isolated sandbox), **draft PR publication** (external write), and **merge** (always human, never Overwatch).

Instead of splitting one service into multiple fake apps to get different behavior in prod, staging, and dev, configure `policy` on `apps.<app>.policy` and/or `apps.<app>.environments.<env>.policy`. Effective values resolve through a single pure cascade: **`env.policy -> app.policy -> global/default`**.

| Policy Key | Default | Meaning |
| --- | --- | --- |
| `investigate` | `true` | Whether new admissions automatically queue an investigation (still gated by `trial`). Set `false` for watch-only dev/sandbox environments. |
| `readings` | global `readings` (`3`) | Independent investigator readings per incident (`1`, `2`, `3`, or `5`). Use `3` or `5` for critical prod, `2` for fast staging triage. |
| `notify` | `true` | Whether moving into `Needs you` sends a desktop notification via `terminal-notifier`. Set `false` for noisy non-prod environments. |
| `critical` | `/^(prod\|production)$/i.test(env)` | Whether active error problems and undecided investigations route to `Needs you`. Set `true` explicitly for corporate names like `prod-us-east`, `prd`, or `canary`, or `false` to keep a staging/shadow env out of `Needs you`. |
| `fixMode` | `app.fixes ? (app.fixes.mode ?? "propose") : "off"` | `"off"` (no fix attempts), `"propose"` (human-in-the-loop: stops at `verified` until you press `Shift-P`), or `"draft_pr"` (opt-in human-on-the-loop: automatically opens a `--draft` PR once `verified` and all gates pass; never merges). Offline `check` refuses `"propose"` or `"draft_pr"` on any app that lacks `apps.<app>.fixes`. |
| `genUi` | `opencode.genUi` (`false`) | Whether `POST /v2/items/:id/lens` (`g` key) is permitted for incidents in this environment (returns `403` when `false`). |

**How policies appear in the UI:** Non-default behaviors render as at most 3 quiet pills (e.g. `watch only`, `draft PR`, `DB ro`, `critical`) with plain-English tooltips on Overview environment cards, Environment/Incident headers, and OpenCode handoff prompts — never crowding the top health strip.

**Hard safety boundaries that hold in BOTH `"propose"` and `"draft_pr"` modes:**
1. **Unanimous evidence-backed verdict**: Requires `planned >= 3` unanimous real readings (`3/3` or `5/5`), challenger upheld, observed in telemetry, exact count (no gaps), onset strictly after rollout, clean ordinary interval before rollout, and fresh telemetry.
2. **Model selects; code derives**: The fixer only picks from code-computed commits to revert or JSON scalars to restore; it never writes arbitrary patches.
3. **Permit-bound host steps**: Every `git push` and `gh` call spends a `Permit` committed in SQLite first and bound to exact arguments. Branch protection is positively verified before push, pushes are never forced, draft creation is read back from the host, and title/body pass `outbound()` secret + local-path scrubbing.
4. **Never merges, never marks ready**: Overwatch only opens `--draft` pull requests. Merging is always a human decision on the Git host.
5. **Policy-bound calibration (`trial --fixes`)**: `fixGateKey` hashes the model, OpenCode URL, the app's `fixes` policy (`mode`, `paths`, `verify`), and any effective per-env `fixMode` overrides. Flipping an environment from `"propose"` to `"draft_pr"` automatically revokes the gate until `bin/overwatch trial --fixes` passes all 3 calibration exercises (`revert`, `setting`, `abstain`). A real `verify_failed` event also revokes the gate immediately.

---

## 5. Read-Only Database Inspection (`ow_db`)

Agents and your interactive OpenCode sessions can inspect lock queues, pool waiters, migration state, or replication lag without shell access or write credentials by declaring read-only targets under `apps.<app>.environments.<env>.databases`:

```json
{
  "databases": {
    "primary": {
      "driver": "postgres",
      "dsn": "keychain:overwatch/checkout-ro-dsn",
      "allowSelect": false,
      "queries": {
        "active_locks": {
          "sql": "SELECT pid, relation, mode, granted FROM pg_locks WHERE NOT granted LIMIT :limit",
          "params": ["limit"]
        }
      }
    }
  }
}
```

Supported drivers are `"postgres"` (`psql`), `"mysql"` (`mysql`), and `"sqlite"` (`sqlite3`, using `file` instead of `dsn`).

### Defense-in-depth guarantees

1. **Named parameterized templates by default (`allowSelect: false`)**: Models pick a named query and pass typed parameters (`:name` placeholders). `renderQuery()` accepts only finite numbers, booleans, or strict safe identifier strings (`/^[A-Za-z0-9._:@/-]{1,120}$/`), eliminating SQL injection across all three CLIs.
2. **Strict offline & runtime `checkSql()` validation**: Even when a target opts into `allowSelect: true` (e.g. on staging or local dev), every query — and every named template in config at `overwatch check` time — must pass `checkSql()`: max 2,000 characters, single statement (no internal `;`), no SQL comments (`--`, `/*`), no `\` or leading `.` (blocking `psql \!` and `sqlite3 .shell`), must begin with `SELECT`, `WITH`, `EXPLAIN`, or `SHOW` (forbidding `EXPLAIN ANALYZE`), and blocks all mutating, DDL, admin, session, and file-I/O keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `COPY`, `SET`, `LOCK`, `PRAGMA`, `VACUUM`, `pg_read_file`, `pg_terminate_backend`, `INTO OUTFILE`, etc.).
3. **Engine-level read-only flags & no shell**: All three drivers run strictly through `src/exec.ts` (`timeoutMs: 10_000`, `maxBytes: 65_536`, no shell):
   - `sqlite`: `sqlite3 -bail -readonly -json <file> <sql>`
   - `postgres`: `psql -X -v ON_ERROR_STOP=1 -P pager=off -A -F \t -c <sql>` with `PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000"`
   - `mysql`: `mysql --batch --quick --init-command="SET SESSION TRANSACTION READ ONLY" -e <sql>`
4. **Env-only credentials**: DSNs are parsed in Node and passed only through child `env` (`PGPASSWORD`, `MYSQL_PWD`, `PGHOST`, etc.) — passwords never appear in `argv` or process listings. Use a dedicated read-only database role as well.
5. **Strict `(app, env)` isolation, redaction & `fixer` denial**:
   - `ow-investigator`, `ow-challenger`, and `ow-responder` can query **only** the targets declared for that incident's own `(app, env)`.
   - **`ow-fixer` is strictly refused `ow_db`** both by OpenCode permissions (`examples/opencode-glm53.json`) and in `src/tools.ts`.
   - Every result passes `clean()` redaction (including your `redactPatterns`), is capped at 16 KiB, stored as handle-bound telemetry evidence (`db:<name>`), counted against `opencode.toolCalls` and `piecesPerSession`, and rendered in the UI as a bounded, horizontally scrollable read-only table (`DB ro`).
   - Your own interactive OpenCode sessions can call `ow_db` by target ID (`app/env/name`) or unique target `name`.
6. **`overwatch doctor` checks**: Whenever at least one database target is configured, `doctor` automatically adds `db:<id>` checks (CLI binary on `PATH`, secret/file resolution) and verifies `ow_ow_db` permissions on `ow-investigator`, `ow-challenger`, `ow-responder`, and denial on `ow-fixer`.

---

## 6. Corporate Secret Redaction, Proxies, Airgap & `launchd`

### Corporate Secret Redaction (Zero `src/` Edits)

Add internal secret formats to `redactPatterns` in `corp-base.json`:

```json
{
  "redactPatterns": [
    "\\bcorp_(?:live|test)_[A-Za-z0-9]{24,}\\b",
    "\\bX-Internal-Auth:\\s*[^\\s\"']+",
    "\\bsvc_jwt_[A-Za-z0-9._-]{32,}\\b"
  ]
}
```

Each regex is validated offline by `overwatch check` and compiled into `src/redact.ts` so every write through `Store.tx` (`clean` / `cleanDeep`), every `ow_db` result, and every outbound draft PR or notification (`outbound`) scrubs them automatically.

### Corporate Proxy, Airgap, Keychain & `launchd` Notes

- **Prebuilt page (`web/dist`)**: The service runs TypeScript directly on Node 24 (or 22.16+) with no build step; only `web/` is bundled by `rolldown`. Behind a strict corporate registry proxy where `rolldown`'s native binary is blocked, `pnpm install` still succeeds (`prepare` uses `--optional`); build `web/dist` once on a permitted machine with `pnpm run build:web` and commit or distribute `web/dist/` internally.
- **NPM registry & proxies**: `overwatch doctor` pings `${npm_config_registry}/-/ping` using your `HTTPS_PROXY`/`HTTP_PROXY` settings and verifies that your `launchd` job captured the same `PATH` and proxy environment. Proxy credentials are never written to reports.
- **GitHub Enterprise (`gh`)**: `fixes.ts` resolves the remote host from `git remote get-url <remote>` and passes `--hostname <host>` to `gh api` and `--repo <host>/<org>/<repo>` to `gh pr` commands automatically. Sign in once with `gh auth login --hostname git.corp.example`.
- **Keychain secrets for `launchd`**: `overwatch install` refuses merged configs with any `env:` secret reference (including inherited base DB DSNs) because `launchd` does not inherit your shell environment. Store every secret in your macOS login keychain:

```sh
security add-generic-password -s overwatch -a mcp-token -w
security add-generic-password -s overwatch -a opencode -w
security add-generic-password -s overwatch -a dd-api -w
security add-generic-password -s overwatch -a dd-app -w
security add-generic-password -s overwatch -a checkout-ro-dsn -w
```

---

## 7. What's Intentionally Left for Corporate Forks (Recipes)

Overwatch core is intentionally capped at **`<= 5,500` nonblank, noncomment lines in `src/`** (enforced by `accept/m4/platform.test.mjs`) with zero extra npm dependencies (`AGENTS.md`). Keeping the kernel small means every invariant — single SQLite writer, `Permit`-gated outbound effects, handle-bound evidence, and `ProviderTime` freshness — stays auditable in one sitting and upstream merges stay clean.

Company-specific transports, internal telemetry backends, and bespoke RPC clients belong in your corporate fork rather than core:

### Recipe A: Slack, PagerDuty, or Internal Webhook Notifications
Overwatch ships local macOS notifications (`terminal-notifier`) because outbound webhook URLs, auth headers, and escalation payloads differ at every company.
1. Add a secret ref (`keychain:...`) for the webhook URL or token in `src/config.ts`.
2. Send it from `announce()` in `src/inbox.ts` (respecting `policyFor(config, app, env).notify`) **only after** recording an intent and minting a `Permit` in SQLite (`Store.permit`), scrubbing the payload through `outbound()` in `src/redact.ts`.
3. Add your notifier module to the outbound HTTP allowlist in `test/classes.test.ts` (or invoke a local CLI via `effect()` in `src/exec.ts` with a bound `Permit`).

### Recipe B: Prometheus, Loki, Splunk, or Custom Telemetry Source Adapters
TypeScript's exhaustive checks enforce every seam when adding a new `Source` kind:
1. **`src/config.ts`**: Add the new kind to `READINGS`, add its `Schema.Struct` to `SourceConfig`, and normalize its fields in `parseConfig`.
2. **`src/collect.ts` (`IDENTITY`)**: List every connection-identifying field so `endpoint()` shares auth/unreachable refusals only between identical endpoints.
3. **`src/collect.ts` (`Collector.reader`)**: Return `Reading`s carrying `ProviderTime` timestamps (created via `time()` in `src/parse.ts`; reserve `answered()` strictly for live reads inside `src/collect.ts`) and deduplicate occurrences by keys made solely from the source's own data.
4. **`src/failures.ts` (`fixFor`)**: Provide the human-actionable repair message for every `FailureKind` (`signin`, `permission`, `rate`, `unreachable`, `config`).
5. **Invariants (`test/classes.test.ts`)**: Run external CLIs only through `src/exec.ts`, add any new HTTP adapter file to the allowlist in `test/classes.test.ts`, and keep `src/` within `5,500` lines.

### Recipe C: Custom DB Drivers (ClickHouse, BigQuery, Oracle) & Internal Read-Only RPC Tools
Overwatch avoids third-party JS driver packages (`pg`, `mysql2`, SQL parsers) so the core stays dependency-free and enforces read-only mode at the database engine boundary.
- **Additional DB driver**: Add the driver literal to `DbTargetConfig` in `src/config.ts` and a branch in `src/db.ts` invoking its official CLI through `src/exec.ts` (`timeoutMs: 10_000`, `maxBytes: 65_536`) with engine-level read-only flags and credentials passed strictly via `options.env` (never `argv`), keeping `checkSql()` and `renderQuery()` in front of it.
- **Internal read-only RPC / catalog tool** (e.g. feature flags, service ownership, deploy metadata): Declare a closed `Schema.Struct` input in `src/tools.ts`, register it in `TOOLS` and `READS` (`src/mcp.ts`), deliver its cleaned output through `deliver(run, "rpc:<name>", [out], "telemetry")` so it gets a handle and counts against session budgets, allow it only on read roles (`ow-investigator`, `ow-challenger`, `ow-responder`, never `ow-fixer`), and add its action to your OpenCode agent permissions.

---

## 8. Corporate Rollout Checklist

Run these steps once per laptop after cloning your corporate fork:

1. **Install dependencies**: `pnpm install` (Node 24 or >= 22.16).
2. **Create personal config**: Copy [examples/personal-override.json](../examples/personal-override.json) to `~/.config/overwatch/config.json`, point `"extends"` at your fork's `corp-base.json` (relative or `~/`), set local `checkout` paths, and store every secret (including DB DSNs) in macOS Keychain.
3. **Validate offline**: `bin/overwatch check --config ~/.config/overwatch/config.json` (must exit `0`; also validates every SQL template in `databases`).
4. **Wire OpenCode + GLM 5.3**: Merge [examples/opencode-glm53.json](../examples/opencode-glm53.json) into `~/.config/opencode/opencode.json` and copy `skills/overwatch/` to `~/.config/opencode/skills/overwatch/`.
5. **Start & install service**: Run `bin/overwatch install --config ~/.config/overwatch/config.json` from a terminal where `kubectl`, `git`, `gh`, `opencode`, `terminal-notifier`, any DB CLIs (`psql`/`mysql`/`sqlite3`), and `HTTPS_PROXY` are set.
6. **Diagnose everything**: `bin/overwatch doctor --config ~/.config/overwatch/config.json` (verify every check is `ok`, including `model`, `mcp`, `skill`, `agent:*`, `cluster:*`, `dd:*`, `db:*`, `checkout:*`, `launchd.*`).
7. **Calibrate your model**:
   - `bin/overwatch trial --config ~/.config/overwatch/config.json` (unlocks automatic investigations for your model).
   - `bin/overwatch trial --fixes --config ~/.config/overwatch/config.json` (unlocks fix proposals / opt-in per-env `draft_pr` for each configured app policy).
8. **Verify live UI**: Open `http://127.0.0.1:7331` (or try `bin/overwatch demo` first with zero remote calls).
