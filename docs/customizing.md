# Customizing Overwatch

## If you have just forked this

Overwatch is meant to be forked and grown. Nothing in the code is specific to one person or company: apps,
environments, sources, schedules and thresholds come from your configuration file, and agent prompts, permissions,
skills and the page's look live in clearly named files.

**What is yours** (change freely; upstream will not touch it or rarely does):

| Path | What it is |
| --- | --- |
| `~/.config/overwatch/config.json` (outside the repository) | Apps, environments, sources, watchers, thresholds, schedules, `extensions`. |
| `~/.config/opencode/opencode.json` (outside the repository) | The plugin entry, its `url`, extra `permissions`, and `investigatorPrompt`. |
| `local/` | Your extension modules (new source types), your prompt file, notes. Upstream never writes here. |
| `web/src/style.css` | How the page looks: `:root` (Night Watch dark) and `[data-theme="light"]` (Daylight Chart) CSS custom properties, typography, spacing, and component rules. See [design.md](design.md) for the full token reference. After editing, run `pnpm run build:web`. |
| `web/src/favicon.svg`, `web/src/icons.ts` | The SVG Sentinel Reticle mark, wordmark, favicon, and inline UI icons. |

**What is upstream's** (change it if you must, but expect merge work): `src/host` (the SQLite host; its tests are
the safety net), `src/domain` (the model), `src/service`, `src/plugin`, `src/collect`, `web/src/app.ts`, `web/src/views.ts`, `test/`.
`src/plugin/investigator.md` and `skills/overwatch/SKILL.md` are upstream's defaults: rather than editing the prompt,
point the plugin's `investigatorPrompt` option at a copy in `local/`.

**What to change first**

1. Copy `examples/config.json` to `~/.config/overwatch/config.json` and describe your apps. `bin/overwatch check`.
2. Install the plugin globally ([setup.md](setup.md#4-the-plugin)).
3. If you need a source type that does not exist, write it in `local/` and list it in `extensions` (see `local/README.md`).
4. If your investigator needs a narrow extra permission, add it in the plugin's `permissions` option.

**What to leave alone**: the host's locking and alarm code, the rule that events only gain optional fields, the
read-only `kubectl` check, and the citation check. Each has tests that explain why.

**Pulling in upstream changes**

```sh
git remote add upstream <the repository you forked from>   # once
git fetch upstream
git merge upstream/main          # or rebase your branch onto it
pnpm install && pnpm run check
OPENCODE_BIN=/path/to/opencode pnpm run e2e
```

Keep your changes in the "yours" places above and merges stay clean. If you changed upstream files, keep those
commits small and separate so conflicts are easy to read. Events are additive only, so a database written by an
older version keeps working after you pull; if a pull bumps a view's `version`, that view is rebuilt from the history
on the next start.

**After your changes**, run `pnpm run check`; if you touched the plugin, the worker, the MCP server or how the
service talks to OpenCode, also `pnpm run e2e`; if you touched `src/host`, also `pnpm run test:crash`.

**Your own changes as data.** Later phases will have the system propose changes to its own rules, thresholds and
prompts from how you use it. To keep that possible: what the owner does is recorded as an event with who issued it
(a prompt's `origin`, a way out's `actor`), and thresholds and prompts are configuration and files, not constants
in code. Keep new ones that way.

## The configuration file

One JSON file (comments allowed), default `~/.config/overwatch/config.json`, or `--config <file>`. Validate it with
`bin/overwatch check`. [examples/config.json](../examples/config.json) is a complete small example; its test keeps
it valid. Durations are written like `90s`, `10m`, `6h`, `14d`.

Some options are read and validated but not used by anything built yet. They are marked *not used yet*; they exist
because the collectors they come with were kept for phase 1B.

### `extensions`

A list of module paths (relative to the config file) loaded at start. Each module's default export receives
`{ registerSourceType }` and may add source types. Keep them in `local/`. Example in `local/README.md`.

### `service`

| Option | Default | Meaning |
| --- | --- | --- |
| `service.port` | `7450` | The loopback port for the page, the Api (`/api`), MCP (`/mcp`), `/health` and `/status`. |

### `opencode`

| Option | Default | Meaning |
| --- | --- | --- |
| `opencode.url` | none | A fixed OpenCode server URL. Without it the service finds the local managed OpenCode server the way the OpenCode client does (`discover`). |
| `opencode.username` | `opencode` | Basic-auth user for a fixed `url`. |
| `opencode.password` | none | A secret reference, `env:NAME` or `keychain:service/account`. |
| `opencode.autoInvestigate` | `true` | Start an investigation for every new incident. Off: the triage intent is recorded as `held` and waits for you. |
| `opencode.runTimeoutMinutes` | `20` | A run with no finding after this long is interrupted and fails. |

### `apps`

```jsonc
"apps": {
  "shop-api": {
    "checkout": "~/code/shop-api",          // the local checkout; investigations get a worktree of it
    "environments": {
      "production": {
        "sources": {
          "pods": { "type": "kubernetes", "context": "prod-cluster", "namespace": "shop", "selector": "app=shop-api" }
        }
      }
    }
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `apps.<app>.checkout` | required | Path to the app's checkout (`~` and relative paths allowed). If it is not a git repository, investigations get an empty directory and work from telemetry alone. |
| `apps.<app>.environments.<env>.sources.<name>` | at least one | A telemetry source (below). Its name is what agents pass to `query_telemetry` and cite. |
| `apps.<app>.environments.<env>.tier` | from the name | `production`, `staging` or `development`. Unset, names like `prod`, `production`, `*-prod` are production; `staging`, `stage`, `preprod`, `uat` are staging; anything else development. Orders the fleet strip and sets the default for `notify`. |
| `apps.<app>.environments.<env>.notify` | `true` for production, else `false` | Notify (macOS) once when an incident opens here and once when its finding arrives. |
| `apps.<app>.environments.<env>.deployedCommit` | none | `{ "source": "<kubernetes source>", "from": "image-tag" \| "label:<key>" \| "annotation:<key>", "command": [...] }`: how the running revision is read (from pod images by default, a label or annotation, or a command's output). Investigations read code at this commit; if it cannot be found in the checkout they say so. |
| `apps.<app>.environments.<env>.metrics` | the defaults below | Rules for measured values: `[{ "metric": "memory_pct_of_limit", "operator": "gt", "threshold": 90, "hysteresis": 2 }]`. `operator` is `gt`, `gte`, `lt` or `ratio_gt` (against the median of the older half of the series); `hysteresis` is how many samples in a row must breach (and clear); `*` in `metric` matches any part of a name. Setting it replaces the defaults for that environment. |
| `apps.<app>.baseBranch`, `verify`, `skills` | `main`, none, none | *Not used yet* (fixes and pull requests, phase 3; skills per watcher). |

#### Source types

`kubernetes` and the Datadog types are tested end to end through the service.

**`kubernetes`**:

| Option | Meaning |
| --- | --- |
| `context`, `namespace` | Always passed to `kubectl`; agents cannot change them. |
| `selector` | Label selector for the app's pods, as `kubectl -l` takes it. |
| `workload` | Optional workload name, when the selector matches more than one. |
| `errorPattern` | Regular expression for error log lines (a sensible default matches error, fatal, panic, exception, traceback). |
| `logs` | `false` to skip reading logs. |

Only `kubectl get`, `describe`, `logs` and `top` run, checked against an allowlist (`checkKubectlArgs`): each verb's
readable resources (never secrets or config maps), its permitted flags and the shape of each flag's value, and names
that cannot be read as flags. The context and namespace are always the configured ones. Agents never pass `kubectl`
arguments: they ask for a structured operation (`logs`, `get`, `describe`, `top`) and its fields are checked before
the command is built (`agentKubectl`).

Measured values the Kubernetes source reports, with the default rules (used unless the environment sets `metrics`):

| Metric | Default rule |
| --- | --- |
| `memory_pct_of_limit`, `cpu_pct_of_limit` | over 90, 2 and 3 samples in a row |
| `not_ready_pods`, `pending_pods` | over 0, 2 samples |
| `unavailable_replicas` | over 0, 3 samples |
| `hpa_pct_of_max_replicas` | at or over 100, 3 samples |
| `node_memory_pct_of_allocatable` | over 90, 3 samples |
| `quota_*_pct` | over 90, 2 samples |

**Datadog** (`datadog-logs`, `datadog-monitors`, `datadog-metrics`) needs the top-level `datadog` option:

```jsonc
"datadog": { "apiKey": "keychain:overwatch/datadog-api-key", "appKey": "keychain:overwatch/datadog-app-key", "site": "datadoghq.eu" }
```

| Option | Meaning |
| --- | --- |
| `datadog.apiKey`, `datadog.appKey` | Secret references, `env:NAME` or `keychain:service/account`. Resolved at run time, sent as request headers, never stored. |
| `datadog.site` / `datadog.apiUrl` | `datadoghq.com` by default; `apiUrl` overrides the whole base URL. |
| `datadog-logs`: `query`, `indexes` | A log search, as in the Datadog UI (`service:shop-api status:error`). Lines are grouped by normalized message. |
| `datadog-monitors`: `tags` or `name`, `states` | Monitors to follow; alerting ones (`Alert`, `Warn`, `No Data` by default) are incidents while they alert. |
| `datadog-metrics`: `queries` | `{ "<metric name>": "<metric query>" }`. Each becomes a series checked against `metrics` rules like any measured value. |

`github-ci` and `command` sources are in `src/collect/sources` with their tests but are not exercised through the
service yet.

### `watchers`

```json
"watchers": [{ "app": "shop-api", "environment": "production", "every": "10m" }]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `app`, `environment` | required | What to watch. One watcher per app and environment. |
| `every` | `10m` | How often to poll. |
| `sources` | every source of the environment | Which of its sources to read. |
| `minCount` | `1` | Occurrences of a log or event group in one run before it is reported. Ongoing conditions ignore it. |
| `skills`, `investigate`, `fix`, `resolveAfter` | | *Not used yet*. |

### `lookback`, `timeouts`, `concurrency`, `redaction`, `dataDir`

| Option | Default | Meaning |
| --- | --- | --- |
| `lookback.initial` | `24h` | How far back a new watcher reads the first time. |
| `lookback.max` | `14d` | The furthest back any catch-up reads; anything older is recorded as a gap. |
| `lookback.overlap` | `2m` | Each run re-reads this much before its checkpoint, so late data is not missed; de-duplication counts it once. |
| `lookback.slice` | `6h` | A long gap is read in slices of this size, oldest first. |
| `timeouts.source` | `60s` | One call to a source (one `kubectl` command). |
| `timeouts.slice` | `10m` | One source reading one slice. |
| `concurrency.sourceCalls` | `4` | Calls one source makes at once (`kubectl logs` across pods). |
| `redaction.entropy` | `true` | Redact values that look generated (tokens, keys), whatever they are called. |
| `redaction.allow`, `redaction.patterns` | none | Regular expressions to keep, and extra ones to redact. |
| `dataDir` | `~/.local/share/overwatch` | Database, worktrees and logs. |
| `notify` | `true` | The master switch for notifications; each environment's `notify` decides within it. Notifications are macOS only. |
| `comeBack.multiple`, `comeBack.atLeast` | `2`, `5` | A Later comes back when the rate (occurrences in the last day) reaches `multiple` times what it was, with at least `atLeast` more. |
| `comeBack.neverMultiple` | `10` | Never breaks through at this many times the rate it had when muted. |
| `comeBack.offerAfter`, `comeBack.offerWithin` | `3`, `14d` | A Done that came back this many times within this long offers Later until it gets worse, or Never. |
| `failures.backoff` | `1m` | The first wait after a failure that may pass (unreachable, rate limited); it doubles each time. |
| `failures.ceiling` | `30m` | The longest wait, and how often a suspended connection is tried again. |
| `failures.attempts` | `5` | Unreachable failures in a row before a connection is suspended. Sign-in always suspends after one confirming attempt. |
| `timeouts.investigation` / `fix` / `verify`, `concurrency.investigations` / `watchers`, `schedule`, `model`, `permissions` | | *Not used yet* by the service. |

## Adding an app, an environment, a watcher

1. Add the app with its `checkout` and the environment with its sources. Find the Kubernetes values read-only:
   `kubectl config get-contexts`, then `kubectl --context <c> get deploy -n <ns> --show-labels`.
2. Add a watcher for the app and environment.
3. `bin/overwatch check`, then restart the service (`launchctl kickstart -k gui/$(id -u)/dev.overwatch.service`, or
   stop and start it in the terminal). The watcher runs on the first tick and every `every` after.

## Adding a source

A source implements `SourceType` in `src/collect/sources/` (`collect` one window, `query` for agents, `validate` its
configuration) and is registered in `src/collect/sources/index.ts`. Rules a source must keep:

- Read-only. Parse every answer through `src/collect/tolerant.ts`, so a missing or mistyped field costs that field.
- Return signals with a stable `key` per kind of problem, and a redacted, bounded `sample`.
- Bound its calls and its time, and report what it left unread in `notes` rather than failing the slice.
- Tests with fakes only: a fake `exec` or `fetch`, never a real system.

The plan wraps each outside system in an Alchemy `ExternalSystem` with schemas for its arguments and results. Phase 1A
has not done this yet: the collectors are plain TypeScript called by the service, outside the model, and they never
write events directly (the service reports what they found with `ReportSignal`). That boundary is phase 1B work.

## Changing the model

The model is in `src/domain/` and imports only `@alchemy.run/domain` and `effect`, so the page can use it too.

- **A command**: a `Domain.Command` in the aggregate's file, added to the aggregate's `commands`, with a `decide`
  branch (pure: no I/O, no clock, time from `ctx.now`) and an `evolve` branch for each event it records.
- **An event**: a `Domain.Event`. Events are immutable and the store keeps them forever, so the rule is additive only:
  a new field is optional (`Schema.optionalKey`), and a change of meaning is a new event. Never rename or remove a
  field, and never change what one means.
- **An aggregate**: a `Domain.Aggregate` added to `Overwatch` in `model.ts`.
- **A view**: a `Domain.View`. When you change what a deployed view computes, add or bump its `version`; Alchemy
  rebuilds it from the history.
- **Exposing it**: list the command or read in `OverwatchApi` (`model.ts`). Bump `API_VERSION` there and in
  `src/plugin/index.ts` when an existing client would break (a test keeps the two equal).
- **Tests**: a story in `test/domain.test.ts` for the happy path, every rejection and every policy reaction, and keep
  `Domain.verify(Overwatch)` empty.

Polling bookkeeping is not an event. Checkpoints, coverage, de-duplication state, run tokens and what sessions were
shown are plain tables in `src/service/tables.ts`.

## Prompts, permissions and skills

- The investigator's instructions: `src/plugin/investigator.md`.
- Its permissions: `investigatorPermissions` in `src/plugin/index.ts`, deny by default. To allow a narrow extra rule
  (for example a shell command a skill needs), add it in the plugin's options, not in the code:
  `"options": { "permissions": [{ "action": "shell", "resource": "my-readonly-tool *", "effect": "allow" }] }`.
  OpenCode names an MCP tool's permission `<server>_<tool>`, for example `overwatch_query_telemetry`.
- The skill every session gets: `skills/overwatch/SKILL.md`.
- What a session is told about its incident (the context pack): `src/domain/brief.ts`.
- The finding's shape and limits: `src/domain/finding.ts` and `src/collect/report.ts`.

## Thresholds and limits

| What | Where |
| --- | --- |
| Finding limits (words, quotes, evidence count) | `src/domain/finding.ts`, `LIMITS` in `src/collect/report.ts` |
| Context pack size (8,000 characters) | `src/domain/brief.ts` |
| Inbox and timeline sizes | `src/domain/views.ts` (`TIMELINE = 50`) |
| How long a stalled turn waits before Overwatch asks it to continue (15 s) | `STALL_MS` in `src/service/worker.ts` |
| Alarm ticker (1 s) and batch (32) | `src/host/sqlite.ts` |
| How long de-duplication state is kept (14 days) | `SEEN_KEEP_MS` in `src/service/collector.ts` |
| Metric rules (defaults) and series length (120 points) | `DEFAULT_METRIC_RULES` in `src/collect/detection.ts` (or `metrics` per environment); `SERIES_POINTS` in `src/service/collector.ts` |
| When an environment counts as stale (3 polling intervals) | `STALE_INTERVALS` in `web/src/app.ts` |
| When the page may say quiet | `notQuietBecause` and `allQuiet` in `web/src/app.ts` (one rule; `test/daily.test.ts` checks it over generated states) |
| Which inbox group a row is in | `groupInbox` in `web/src/app.ts` |
| How a failure is classified, and the fix it suggests | `classifyFailure`, `fixFor` in `src/collect/failures.ts` |
| Done's grace after it is marked (one polling interval of the watcher) | `graceMs` in `src/service/service.ts` (`report`) |
| Which Kubernetes resources, flags and values agents and collection may use | `READABLE`, `FLAGS` in `src/collect/sources/kubernetes.ts` |
| Which git history operations investigators may use | `src/service/history.ts` |

## Tests

```sh
pnpm run check                                    # typecheck (service and page) and every test
node --experimental-strip-types --no-warnings --test test/domain.test.ts   # one file
OPENCODE_BIN=/path/to/opencode pnpm run e2e      # end to end against a real OpenCode 2 server
pnpm run test:crash                               # kill the host at every commit and write (about 10 minutes)
```

| File | What it covers |
| --- | --- |
| `test/host.test.ts` | The connection lock, the journal, alarms across a clock jump, an alarm a month away, catch-up at start. |
| `test/conformance.test.ts` | The same fixtures through the Api client on the in-memory host and the SQLite host. The gate for upgrading Alchemy Domain. |
| `test/crash.test.ts` | Kill the host at commits, writes, alarm claims and fires; restart; nothing lost or duplicated. |
| `test/domain.test.ts` | Stories for the model, and routing. |
| `test/service.test.ts` | Detect once, live page and never twice, loopback checks, restore. |
| `test/mcp.test.ts` | Session-bound tools and their refusals; the MCP server over HTTP. |
| `test/worker.test.ts` | The OpenCode outbox, nudges, stalls and time limits, with a fake OpenCode. |
| `test/plugin.test.ts`, `test/launchd.test.ts`, `test/page.test.ts` | The plugin (no Effect at run time), launchd, configuration, the page's logic. |
| `test/regressions.test.ts` | One test per defect found by review, each failing before its fix: redaction at entry, crash-safe counting, citation provenance, the writer lock, restore, run timeouts, extensions, drafts, read-only allowlists, the deployed code, metrics, notifications, the fleet strip, copying a summary. |
| `test/datadog.test.ts` | Datadog logs and monitors through the service, with a fake Datadog. |
| `test/browser.test.ts` | The real page in headless Chrome or Chromium (set `CHROME_BIN`; skipped, and says so, if none is found). |
| `test/core.test.ts`, `sources.test.ts`, `robustness.test.ts`, `report.test.ts` | The collectors and redaction kept from the earlier plugin. |

Tests use fakes for `kubectl`, Datadog, GitHub and the model, and never call a real cluster, Datadog or repository
host. Test helpers are in `test/fixtures/`: `cluster.ts` (a fake `kubectl`), `service.ts` (the service in process),
`ledger.model.ts` (a small model for the host tests).
