# Forking Overwatch for a Corporate Environment

Overwatch is built to be forked once into your company's internal Git host, configured for your clusters, Datadog site, and local OpenCode model (such as GLM 5.3 on local GPUs), and kept up to date with upstream through low-conflict merges.

The goal is simple: **90% of corporate customization lives in configuration, skills, and playbooks — zero edits to `src/`.**

---

## 1. Upstream vs. Downstream Ownership Boundary

Keep your fork's diff small so `git fetch upstream && git merge upstream/main` stays mechanical.

| Layer | Files | Upstream / Fork Strategy |
| --- | --- | --- |
| **Core kernel** | `src/store.ts`, `src/inbox.ts`, `src/server.ts`, `src/exec.ts`, `src/agents.ts`, `src/fixes.ts`, `src/tools.ts`, `src/parse.ts` | **Keep upstream-pure.** These enforce Overwatch's "true by construction" invariants (single writer, `Permit`-gated outbound effects, `ProviderTime`, handle-bound evidence, `WRITES` route guards) and stay within the 5,500-line service budget. |
| **Shared corporate config** | `examples/corp-base.json` (or `config/corp-base.json` in your fork) | **Fork-owned.** Committed in your internal fork: Datadog `baseUrl`, `redactPatterns`, `apps.<app>` sources, `spans`, `commitWatch`, `problemPatterns`, `fixes`, `promotion`, and local GPU `opencode` tuning. |
| **Personal overrides** | `~/.config/overwatch/config.json` (outside Git) | **Engineer-owned.** Uses `"extends"` to inherit the fork's base config and overrides only local `checkout` paths, `dataDir`, `mcpToken`, and personal `watchers`. |
| **OpenCode owner skill** | `skills/overwatch/SKILL.md` | **Fork-extensible.** Append internal runbook links, cluster login commands, or QA environment conventions while keeping the core MCP tool instructions (`ow_inbox`, `ow_get`, `ow_search`, `ow_act`, `undo`, `ow_brief`, `ow_outlook`). |
| **App playbooks** | `<dataDir>/playbooks/<app>.jsonl` | **Database-owned per laptop.** Written through "Was this right?" (`y`); never hand-edited. |
| **Custom source adapters** | `src/config.ts`, `src/collect.ts`, `src/failures.ts`, `src/<adapter>.ts` | **Only if adding a new telemetry provider** (e.g., internal Prometheus/Loki/PagerDuty). See section 5 below. |
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

## 2. Config Layering with `extends`

Overwatch validates configuration strictly (`onExcessProperty: "error"`), offline, before starting. To avoid duplicating cluster contexts, Datadog queries, redaction patterns, and fix policies across every engineer's laptop, use `"extends"`:

- `"extends": "./corp-base.json"` (single parent) or `"extends": ["./corp-base.json", "./team-payments.json"]` (left-to-right chain).
- Relative paths resolve from the config file that names them; circular `extends` chains are refused by `overwatch check`.
- Plain objects deep-merge (child keys override parent keys); arrays and primitives replace.
- The merged result is validated as one `version: 2` configuration, so typos in either base or override fail immediately with the exact path to fix.

**Three-layer pattern:**

1. **`corp-base.json`** (committed in your fork): `redactPatterns`, shared `opencode` defaults, Datadog `baseUrl`, org-wide `problemPatterns`, and shared `apps` definitions.
2. **`team-<name>.json`** (optional, committed in your fork): team-specific `apps`, `spans` thresholds, `commitWatch`, `promotion`, and `fixes` allowlists.
3. **`~/.config/overwatch/config.json`** (on each engineer's laptop): `"extends"` pointing to your fork checkout, local `checkout` paths, `keychain:` secret references, and the `watchers` you care about today.

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
| `opencode.toolCalls` | `8` | `16` (up to `24`) | Allows each session to page deeper through `ow_telemetry` (including slow-span traces), run multiple `ow_code_search` / `ow_code_read` hops, and inspect `ow_history` before filing. |
| `opencode.genUi` | `false` | `true` | Enables on-demand AI synthesis (`POST /v2/items/:id/lens`, `g` key) of structured visual lenses grounded strictly in stored evidence handles. See [genui.md](genui.md). |

### Continuous Signal Coverage (Spans + Commits)

With free local inference, turn on the two proactive signals in your corporate base config:

- **Datadog Slow Spans (`spans`)**: Opt-in per Datadog source (`"spans": { "slowMs": 1500, "warnMs": 750, "query": "service:checkout env:prod" }`). Overwatch queries `/api/v2/spans/events/search`, deduplicates every slow span by its Datadog span ID in `occurrences`, normalizes fingerprints as `span:<service>:<resource>`, and stores structured lines (`SLOW <durationMs>ms <service> <resource> trace=<id>`) so investigators and the UI's `span_waterfall` lens work off exact stored timings.
- **Continuous Commit Watcher (`commitWatch`)**: Opt-in per app (`"commitWatch": { "branch": "main", "paths": ["config/", "db/migrations/"], "limit": 20 }`). Uses read-only `git rev-list` and `--numstat` against your local `checkout` to track new commits as they land, compute deterministic code risk flags (`config`, `database`, `auth`, `timeout`, `large_diff`, `unreleased` vs `deployed`), and surface them calmly in `GET /v2/outlook`, `ow_outlook`, the Overview board, and `commit_risk` lenses without spamming the inbox.

---

## 4. Autonomy Policy: Human-in-the-Loop vs. Human-on-the-Loop

Overwatch separates **investigation** (read-only), **fix derivation & verification** (isolated sandbox), **draft PR publication** (external write), and **merge** (always human, never Overwatch).

Per-app fix policy under `apps.<app>.fixes.mode`:

| Mode | Loop Model | Behavior | Recommended For |
| --- | --- | --- | --- |
| `"propose"` *(default)* | **Human-in-the-loop** | Worker derives the commit in a bare mirror, checks the whole tree against `paths` and `FORBIDDEN`, runs `verify` in `sandbox-exec`, and **stops at `verified`**. Nothing leaves your laptop until you press `Shift-P`. | Production apps, sensitive financial/auth services, initial rollout. |
| `"draft_pr"` *(opt-in)* | **Human-on-the-loop** | Once a candidate reaches `verified` and every eligibility rule and trial gate stands, Overwatch automatically runs the exact same permit-gated `publish()` pipeline to push `ow/fix/<id>` and open a **Draft PR** (`--draft`) on your Git host. You review, edit, close, or merge on GitHub. | Staging/QA apps, or trusted non-critical services after passing `trial --fixes` cleanly. |

**Hard safety boundaries that hold in BOTH modes:**
1. **Unanimous evidence-backed verdict**: Requires `planned >= 3` unanimous real readings (`3/3` or `5/5`), challenger upheld, observed in telemetry, exact count (no gaps), onset strictly after rollout, clean ordinary interval before rollout, and fresh telemetry.
2. **Model selects; code derives**: The fixer only picks from code-computed commits to revert or JSON scalars to restore; it never writes arbitrary patches.
3. **Permit-bound host steps**: Every `git push` and `gh` call spends a `Permit` committed in SQLite first and bound to exact arguments. Branch protection is positively verified before push, pushes are never forced, draft creation is read back from the host, and title/body pass `outbound()` secret + local-path scrubbing.
4. **Never merges, never marks ready**: Overwatch only opens `--draft` pull requests. Merging is always a human decision on the Git host.
5. **Policy-bound calibration (`trial --fixes`)**: `fixGateKey` hashes the model, OpenCode URL, and the app's exact `fixes` policy (including `mode`, `paths`, and `verify`). Changing `mode` from `"propose"` to `"draft_pr"` automatically revokes the gate until you run `bin/overwatch trial --fixes` and pass all 3 calibration exercises (`revert`, `setting`, `abstain`). A real `verify_failed` event also revokes the gate immediately.

---

## 5. Extending Overwatch in a Corporate Fork

### A. Corporate Secret Redaction (Zero `src/` Edits)

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

Each regex is validated offline by `overwatch check` and compiled into `src/redact.ts` so every write through `Store.tx` (`clean` / `cleanDeep`) and every outbound draft PR or notification (`outbound`) scrubs them automatically.

### B. Adding a New Corporate `Source` Kind (Compiler-Enforced Checklist)

If your company uses an internal observability source (e.g., Prometheus, Loki, Splunk, or an internal trace store), TypeScript's exhaustive checks ensure you cannot miss a seam:

1. **`src/config.ts`**: Add the new kind to `READINGS` (keep defaults explicit), add its `Schema.Struct` to `SourceConfig`, and normalize its fields in `parseConfig`.
2. **`src/collect.ts` (`IDENTITY`)**: Add the connection-identifying fields for the new kind (used by `endpoint()` so auth/unreachable refusals are shared only between equal endpoints).
3. **`src/collect.ts` (`Collector.reader`)**: Implement the reader returning `Reading`s with `ProviderTime` timestamps (create provider timestamps only via `time()` in `src/parse.ts`; reserve `answered()` strictly for live reads inside `src/collect.ts`). Deduplicate occurrences in `Slice` using keys made solely from the source's own data.
4. **`src/failures.ts` (`fixFor`)**: Add the human-actionable repair message for each `FailureKind` (`signin`, `permission`, `rate`, `unreachable`, `config`).
5. **Network & process invariants (`test/classes.test.ts`)**:
   - External CLIs must run only through `src/exec.ts` (`run`/`stream` for reads, `effect` with a `Permit` for writes).
   - Outbound HTTP adapters must be added to the adapter allowlist in `test/classes.test.ts` (currently `opencode.ts`, `datadog.ts`, `doctor.ts`, `main.ts`).
   - Keep `src/` strictly within the **5,500 nonblank/noncomment line budget** (`accept/m4/platform.test.mjs`).

### C. Corporate Proxy, Airgap, Keychain & `launchd` Notes

- **Prebuilt page (`web/dist`)**: The service runs TypeScript directly on Node 24 (or 22.16+) with no build step; only `web/` is bundled by `rolldown`. Behind a strict corporate registry proxy where `rolldown`'s native binary is blocked, `pnpm install` still succeeds (`prepare` uses `--optional`); build `web/dist` once on a permitted machine with `pnpm run build:web` and commit or distribute `web/dist/` internally.
- **NPM registry & proxies**: `overwatch doctor` pings `${npm_config_registry}/-/ping` using your `HTTPS_PROXY`/`HTTP_PROXY` settings and verifies that your `launchd` job captured the same `PATH` and proxy environment. Proxy credentials are never written to reports.
- **GitHub Enterprise (`gh`)**: `fixes.ts` resolves the remote host from `git remote get-url <remote>` and passes `--hostname <host>` to `gh api` and `--repo <host>/<org>/<repo>` to `gh pr` commands automatically. Sign in once with `gh auth login --hostname git.corp.example`.
- **Keychain secrets for `launchd`**: `overwatch install` refuses configs with `env:` secret references because `launchd` does not inherit your shell environment. Store every secret in your macOS login keychain:

```sh
security add-generic-password -s overwatch -a mcp-token -w
security add-generic-password -s overwatch -a opencode -w
security add-generic-password -s overwatch -a dd-api -w
security add-generic-password -s overwatch -a dd-app -w
```

---

## 6. Corporate Rollout Checklist

Run these steps once per laptop after cloning your corporate fork:

1. **Install dependencies**: `pnpm install` (Node 24 or >= 22.16).
2. **Create personal config**: Copy [examples/personal-override.json](../examples/personal-override.json) to `~/.config/overwatch/config.json`, point `"extends"` at your fork's `corp-base.json`, set local `checkout` paths, and store secrets in macOS Keychain.
3. **Validate offline**: `bin/overwatch check --config ~/.config/overwatch/config.json` (must exit `0`).
4. **Wire OpenCode + GLM 5.3**: Merge [examples/opencode-glm53.json](../examples/opencode-glm53.json) into `~/.config/opencode/opencode.json` and copy `skills/overwatch/` to `~/.config/opencode/skills/overwatch/`.
5. **Start & install service**: Run `bin/overwatch install --config ~/.config/overwatch/config.json` from a terminal where `kubectl`, `git`, `gh`, `opencode`, `terminal-notifier`, and `HTTPS_PROXY` are set.
6. **Diagnose everything**: `bin/overwatch doctor --config ~/.config/overwatch/config.json` (verify every check is `ok`, including `model`, `mcp`, `skill`, `agent:*`, `cluster:*`, `dd:*`, `checkout:*`, `launchd.*`).
7. **Calibrate your model**:
   - `bin/overwatch trial --config ~/.config/overwatch/config.json` (unlocks automatic investigations for your model).
   - `bin/overwatch trial --fixes --config ~/.config/overwatch/config.json` (unlocks fix proposals / opt-in `draft_pr` for each configured app policy).
8. **Verify live UI**: Open `http://127.0.0.1:7331` (or try `bin/overwatch demo` first with zero remote calls).
