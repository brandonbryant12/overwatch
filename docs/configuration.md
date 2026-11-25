# Configuring Overwatch

Overwatch is configured entirely in your own OpenCode config, as the `options` of its plugin entry. Nothing about your
environment lives in this repository. Start from [`examples/opencode.jsonc`](../examples/opencode.jsonc).

Put the entry in your **global** config (`~/.config/opencode/opencode.jsonc`). Investigations run in sessions whose
directory is a worktree of each app, and the plugin must be loaded there too for its tools and agents to exist; a
project-level entry would only load in that project.

Use absolute or `~/` paths. After saving, OpenCode reloads the plugin; run `/overwatch` to see configuration errors.

## Top level

| Option | Default | Meaning |
| --- | --- | --- |
| `apps` | — | Apps by name. See below. |
| `watchers` | `[]` | What to watch on a schedule. See below. |
| `datadog` | — | `{ site, apiKey, appKey, apiUrl? }`. Keys are secret references, never values. |
| `lookback.initial` | `24h` | How far back a brand-new watcher's first run looks. |
| `lookback.max` | `14d` | The furthest back any run looks. Older gaps are reported as not checked. |
| `lookback.overlap` | `2m` | Each run re-reads this much before its checkpoint to catch late data; duplicates are dropped. |
| `lookback.slice` | `6h` | Long gaps are processed in slices of this size, oldest first. |
| `timeouts.source` | `60s` | Wall-clock limit for one source collecting one slice. |
| `timeouts.investigation` | `20m` | Wall-clock limit for one investigation session. |
| `timeouts.fix` | `30m` | Wall-clock limit for one fix session. |
| `timeouts.verify` | `10m` | Wall-clock limit for each verify command. |
| `concurrency.investigations` | `2` | Investigations (and their fixes) running at once. |
| `concurrency.watchers` | `2` | Watcher runs at once. |
| `schedule` | `true` | `false` runs watchers only through `/overwatch-run`. |
| `notify` | `true` on macOS | macOS notification for every finding. |
| `dataDir` | `$XDG_DATA_HOME/opencode-overwatch` | Where worktrees live. |
| `model` | server default | `provider/model` for investigation and fix sessions. |
| `permissions.investigator`, `permissions.fixer` | `[]` | Extra OpenCode permission rules appended to each agent. |

There are no spending settings. Overwatch does not track or cap spend; only the timeouts and concurrency limits above
bound a run.

Secret references are `env:NAME` (an environment variable of the OpenCode server) or `keychain:service/account` (the
macOS keychain, read with `security find-generic-password`). Store a key with
`security add-generic-password -s overwatch -a datadog-api-key -w` and reference it as
`keychain:overwatch/datadog-api-key`.

## Apps

```jsonc
"apps": {
  "<app>": {
    "checkout": "~/code/<app>",      // local clone; never modified
    "baseBranch": "main",            // draft pull requests target this
    "verify": ["bun test"],          // all must pass before a draft PR; empty means never open one
    "skills": ["<skill-id>"],        // your skills, loaded into every investigation of this app
    "environments": { "<env>": { ... } }
  }
}
```

Investigations never read the checkout as it is. Each one reads its own detached worktree at the deployed commit,
created under `dataDir/worktrees/<app>/` and removed when the investigation finishes, fails or times out. A fix
branches from `origin/<baseBranch>` in a separate worktree, which is removed with its local branch when the attempt
ends: a passing fix lives on as the pushed branch and its draft pull request, a failing one is discarded. Only a fix
that was committed but could not be pushed keeps its local branch. Worktrees left behind by a crash or restart are
removed the next time an investigation starts for that app.

## Environments

```jsonc
"<env>": {
  "sources": { "<name>": { "type": "<type>", ... } },
  "deployedCommit": { "source": "<kubernetes source>", "from": "image-tag" },
  "metrics": [{ "metric": "memory_pct_of_limit", "operator": "gt", "threshold": 90, "hysteresis": 2 }]
}
```

Sources are capabilities of an environment. A watcher reads all of them by default, and an investigation can query
any of them with `overwatch_query` to cross-reference.

`deployedCommit` says where the running commit comes from: a kubernetes source's pods (`from` is `image-tag`,
`label:<key>` or `annotation:<key>`), or `{ "command": ["program", "arg"] }` whose output is the commit or ref (run
without a shell in the checkout). Without it, the first kubernetes source's image tag is used. If the commit cannot be
found, the investigation reads `origin/<baseBranch>` and the report says so.

### `kubernetes`

```jsonc
{ "type": "kubernetes", "context": "<kube context>", "namespace": "<ns>", "selector": "app=<app>",
  "workload": "<deployment name>", "errorPattern": "<regex>", "logs": true }
```

Runs only `kubectl get`, `describe`, `logs` and `top`, always with this context and namespace. Flags that would change
cluster, namespace or identity, `--raw`, and reading secrets are refused. Each run collects:

- Warning events for the selected pods (or objects named after `workload`), since the checkpoint.
- Log lines matching `errorPattern` (default: error, fatal, panic, exception, traceback), grouped by normalized
  message. `kubectl logs` only reaches back as far as the kubelet keeps logs, and is capped at 4 MB per pod per slice.
- Container terminations (OOMKilled, errors) since the checkpoint.
- Current state, once per run: waiting containers (CrashLoopBackOff, ImagePullBackOff), `not_ready_pods`, usage as a
  percentage of each container's own requests and limits (`cpu_pct_of_limit`, `memory_pct_of_limit`,
  `cpu_pct_of_request`, `memory_pct_of_request`, from `kubectl top`), node usage as a percentage of allocatable
  (`node_cpu_pct_of_allocatable`, `node_memory_pct_of_allocatable`), and namespace quota use (`quota_<resource>_pct`).

No limit or capacity is assumed: a container without a limit has no `_of_limit` metric, and the report says so.

### `datadog-logs`

```jsonc
{ "type": "datadog-logs", "query": "service:<svc> env:<env> status:(error OR critical)", "indexes": ["main"], "maxLogs": 5000 }
```

Searches exactly the window since the checkpoint, groups by normalized message, and says so when a window held more
than `maxLogs`.

### `datadog-monitors`

```jsonc
{ "type": "datadog-monitors", "tags": ["service:<svc>", "env:<env>"], "states": ["Alert", "Warn", "No Data"] }
```

Monitors in those states are ongoing conditions: each keeps its incident open until it recovers.

### `datadog-metrics`

```jsonc
{ "type": "datadog-metrics", "queries": { "p95_latency_s": "p95:trace.http.request{service:<svc>,env:<env>}" } }
```

Each named query becomes a metric series for the `metrics` rules.

### `github-ci`

```jsonc
{ "type": "github-ci", "branch": "main", "workflow": "deploy.yml" }
```

Failed runs since the checkpoint, read with `gh run list` in the app's checkout (the repository comes from its remote).

### `command`

```jsonc
{ "type": "command", "command": ["~/bin/queue-check", "--json"] }
```

Any program, for telemetry Overwatch has no type for. It runs without a shell in the checkout with `OVERWATCH_FROM`,
`OVERWATCH_TO` and `OVERWATCH_FINAL` set, and prints JSON lines:

```json
{"signal": {"key": "dead-letter", "title": "Messages in the dead-letter queue", "at": "2026-11-25T10:00:00Z", "id": "msg-1", "severity": "error"}}
{"metric": "queue_depth", "value": 42, "at": "2026-11-25T10:00:00Z"}
```

Add `"state": true` to a signal for an ongoing condition. For `overwatch_query` it runs with `OVERWATCH_QUERY` set to
the agent's JSON arguments.

## Metrics

`metrics` rules apply to metrics from any source in the environment. `metric` may contain `*`. Operators are `gt`,
`gte`, `lt` and `ratio_gt` (relative to the median of the older half of the series). A breach needs `hysteresis`
consecutive samples over the limit and clears after as many under it. A metric with no new sample in a run is unknown,
never healthy.

Without `metrics`, these defaults apply, all relative to what the cluster reports:

| Metric | Rule |
| --- | --- |
| `memory_pct_of_limit` | over 90 for 2 samples |
| `cpu_pct_of_limit` | over 90 for 3 samples |
| `not_ready_pods` | over 0 for 2 samples |
| `node_memory_pct_of_allocatable` | over 90 for 3 samples |
| `quota_*_pct` | over 90 for 2 samples |

## Watchers

```jsonc
"watchers": [
  { "app": "<app>", "environment": "<env>", "every": "15m", "sources": ["pods", "errors"],
    "skills": ["<skill-id>"], "investigate": true, "fix": false, "minCount": 1, "resolveAfter": 3 }
]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `every` | `15m` | How often it runs while OpenCode is up. Missed runs are skipped, not replayed. |
| `sources` | all | Which of the environment's sources to watch. |
| `skills` | `[]` | Skills for this watcher's investigations, after the app's. |
| `investigate` | `true` | Investigate new incidents. Otherwise only notify. |
| `fix` | `false` | Let an investigation that finds a fixable cause try a fix and open a draft PR. |
| `minCount` | `1` | Occurrences in one run before a log, event or CI group opens an incident. |
| `resolveAfter` | `3` | Consecutive clean runs before an incident resolves. |

Each source keeps its own checkpoint. A source that fails keeps its checkpoint, its incidents neither resolve nor
reopen, and the next run retries from the same place.

## Agents and permissions

Overwatch adds two agents. Their permissions are deny-by-default:

- `overwatch-investigator` may `read`, `glob`, `grep`, load skills, run read-only `git` commands, and call
  `overwatch_query` and `overwatch_report`. No edits, no other shell, no web, no paths outside its worktree.
- `overwatch-fixer` may read and edit inside its worktree and run the app's `verify` commands and read-only `git`.
  It cannot commit, push, call `gh` or `kubectl`. Overwatch itself commits, pushes the branch and runs
  `gh pr create --draft` after the verify commands pass. It never opens a ready pull request and never merges.

Add rules with `permissions.investigator` or `permissions.fixer`, for example to let a skill's helper script run:

```jsonc
"permissions": { "investigator": [{ "action": "shell", "resource": "~/bin/trace-lookup *", "effect": "allow" }] }
```

## Scheduling

Overwatch schedules its own runs with a timer inside the plugin rather than OpenCode automations. OpenCode loads a
plugin per directory it has open, and a lease in plugin storage lets only one of them run watchers. The timer runs
while the OpenCode server has at least one directory loaded; OpenCode unloads a directory after 60 idle minutes unless
something keeps it open. To keep watching while you are away, leave an OpenCode session open, or set
`"experimental": { "location_idle_timeout": false }` in the project config of a directory you keep open. When
OpenCode comes back, each watcher runs once and catches up from its checkpoints.
