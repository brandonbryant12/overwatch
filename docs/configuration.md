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
| `timeouts.source` | `60s` | Wall-clock limit for one call to a source: one `kubectl` command, one HTTP request, one program. |
| `timeouts.slice` | `10m` | Wall-clock limit for one source collecting one slice, however many calls that takes. |
| `timeouts.investigation` | `20m` | Wall-clock limit for one investigation session. |
| `timeouts.fix` | `30m` | Wall-clock limit for one fix session. |
| `timeouts.verify` | `10m` | Wall-clock limit for each verify command. |
| `concurrency.investigations` | `2` | Investigations (and their fixes) running at once. |
| `concurrency.watchers` | `2` | Watcher runs at once. |
| `concurrency.sourceCalls` | `4` | Calls one source makes at once within a slice, such as `kubectl logs` across pods. |
| `redaction.entropy` | `true` | Also redact values that look generated, whatever they are called. See [Redaction](#redaction). |
| `redaction.allow` | `[]` | Regular expressions for values the entropy check must leave alone, such as a request ID format. |
| `redaction.patterns` | `[]` | Extra regular expressions to redact. |
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
    "verify": ["pnpm test"],         // all must pass before a draft PR; empty means never open one
    "skills": ["<skill-id>"],        // your skills, loaded into every investigation of this app
    "environments": { "<env>": { ... } }
  }
}
```

Investigations never read the checkout as it is, under any circumstances. Each one reads its own detached worktree at
the deployed commit, created under `dataDir/worktrees/<app>/` and removed when the investigation finishes, fails or
times out. A worktree holds only what is committed, so the env files, credentials and unfinished work in your checkout
are never in front of the agent. If the worktree cannot be created (the commit cannot be resolved, `git worktree add`
fails, the disk is full), the investigation runs in an empty directory instead, works from telemetry alone, and its
report lists "code not read" with the reason. It does not fall back to the checkout. A fix
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
found, the investigation reads `origin/<baseBranch>` in a worktree and the report says so.

Every investigation's brief starts with the deploy context, read when the investigation starts: which revisions are
running and on how many pods, when the current rollout began, the revision it replaced, the commits it brought in
(`git log <previous>..<deployed>`, newest 15), container restarts, and where the rollout sits against the
investigation window. The rollout time comes from the Deployment's ReplicaSets (or from pod start times for a
rollback, a StatefulSet or a DaemonSet), so the kubernetes source's account needs to read `replicasets`; without that
the brief has the running revisions only. The report's header carries the rollout time.

### `kubernetes`

```jsonc
{ "type": "kubernetes", "context": "<kube context>", "namespace": "<ns>", "selector": "app=<app>",
  "workload": "<deployment name>", "errorPattern": "<regex>", "logs": true }
```

Runs only `kubectl get`, `describe`, `logs` and `top`, always with this context and namespace. Flags that would change
cluster, namespace or identity, `--raw`, and reading secrets are refused. `selector` is the pods' label selector;
`workload` names the Deployment, StatefulSet or DaemonSet when its pod template labels do not match the selector.
Each run collects:

- Warning events for the selected pods (or objects named after `workload`), since the checkpoint.
- Warning events for the workloads, ReplicaSets and autoscalers behind those pods too, such as a ReplicaSet that
  cannot create pods because a quota is exhausted.
- Log lines matching `errorPattern` (default: error, fatal, panic, exception, traceback), grouped by normalized
  message. `kubectl logs` only reaches back as far as the kubelet keeps logs, and is capped at 4 MB per pod per slice.
- Container terminations (OOMKilled, errors) since the checkpoint.
- Current state, once per run: waiting containers (CrashLoopBackOff, ImagePullBackOff), `not_ready_pods`, usage as a
  percentage of each container's own requests and limits (`cpu_pct_of_limit`, `memory_pct_of_limit`,
  `cpu_pct_of_request`, `memory_pct_of_request`, from `kubectl top`), node usage as a percentage of allocatable
  (`node_cpu_pct_of_allocatable`, `node_memory_pct_of_allocatable`), and namespace quota use (`quota_<resource>_pct`).
- Capacity that usage numbers do not show, also once per run:
  - `unavailable_replicas`: replicas each workload wants minus those available, and a rollout that has stopped
    progressing.
  - `hpa_pct_of_max_replicas`: how close the autoscaler is to its ceiling, and an autoscaler that cannot read the
    metrics it scales on.
  - `pending_pods`, and pods the scheduler cannot place, with its reason ("0/12 nodes are available: 12 Insufficient
    memory").
  - Nodes running the pods that report memory, disk or PID pressure or are not ready.

No limit or capacity is assumed: a container without a limit has no `_of_limit` metric, and the report says so. Each
of these needs its own read permission (`deployments`, `statefulsets`, `daemonsets`, `replicasets`,
`horizontalpodautoscalers`, `nodes`, `resourcequotas`, the metrics API). What the account cannot read costs that check
only, and the run says which check was skipped. Disk use of volumes is not visible to `kubectl` and is not checked;
use a Datadog metric for it.

A run with many pods reads their logs `concurrency.sourceCalls` at a time. Within a run, pods and events are listed
once and each pod's log is downloaded once, however many slices a long gap is walked in. If a slice still cannot
finish inside `timeouts.slice`, the pods that were read count, the rest are listed as not read, and the checkpoint
moves on; a pod whose log cannot be read is reported the same way. Only when no pod's log can be read at all is the
source treated as failed, which keeps its checkpoint for the next run.

### `datadog-logs`

```jsonc
{ "type": "datadog-logs", "query": "service:<svc> env:<env> status:(error OR critical)", "indexes": ["main"], "maxLogs": 5000 }
```

Searches exactly the window since the checkpoint, groups by normalized message, and says so when a window held more
than `maxLogs`.

All three Datadog sources retry a rate limit (HTTP 429), a gateway error (500, 502, 503, 504) and a dropped
connection, up to five times. They wait as long as the response asks (`Retry-After`, `X-RateLimit-Reset`), otherwise
1, 2, 4 and 8 seconds, and never past `timeouts.slice`. A bad key (401, 403) or a proxy or sign-in page answering in
Datadog's place is not retried. A source that still fails keeps its checkpoint and its incidents stay as they are.

### `datadog-monitors`

```jsonc
{ "type": "datadog-monitors", "tags": ["service:<svc>", "env:<env>"], "states": ["Alert", "Warn", "No Data"] }
```

Monitors in those states are ongoing conditions: each keeps its incident open until it recovers.

### `datadog-metrics`

```jsonc
{ "type": "datadog-metrics", "queries": { "p95_latency_s": "p95:trace.http.request{service:<svc>,env:<env>}" } }
```

Each named query becomes a metric series for the `metrics` rules. A query that returns several series (grouped by a
tag) uses the highest value at each time.

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
| `pending_pods` | over 0 for 2 samples |
| `unavailable_replicas` | over 0 for 3 samples |
| `hpa_pct_of_max_replicas` | at or over 100 for 3 samples |
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

## Queries from agents

`overwatch_query` takes `since` and `until` as an ISO 8601 time, an epoch, or a duration back from now such as `6h`.
What is left out defaults to the last hour. A value that is none of those, a window that is empty, or a `since` in the
future is refused with the reason, so an agent never gets an hour it did not ask for and reads it as the answer.
`/investigate --since` and `--until` follow the same rule.

## Citations

A finding's citations are checked by code before the finding is stored:

- `codeLocation` must be a file and line that exist in the investigation's worktree.
- A quote whose `source` is a file must be in that file.
- A quote whose `source` is one of the environment's sources must be in something that source returned to this
  investigation through `overwatch_query`, or in the brief.

A citation that fails one of these is sent back to the agent with what was wrong. A quote attributed to anything else
(a skill, a tool Overwatch cannot see) cannot be checked; it stays, and the report marks it `not verified`. Whitespace
differences are ignored and a long line may be shortened with `...`.

## Redaction

Everything read from telemetry is redacted before an agent or a report sees it, and a finding is redacted again
before it is stored. Two passes:

- By name: authorization headers, bearer and basic credentials, JWTs, cloud and source-host tokens, `api_key=`-style
  pairs, passwords in connection strings, cookies and private keys.
- By value: anything of 20 characters or more that looks generated rather than written, whatever it is called. It is
  replaced by `[REDACTED:high_entropy:<6 characters>]`; the suffix is a hash, so the same value can still be followed
  from line to line.

Hexadecimal values and UUIDs are left alone on purpose, because commit SHAs, image digests and trace IDs are
evidence. A hexadecimal secret is therefore only caught by its name. If the value check hides something you need,
such as request IDs, add their shape to `redaction.allow`:

```jsonc
"redaction": { "allow": ["^req_[A-Za-z0-9]+$"], "patterns": ["internal-ticket-\\d+"] }
```

## Stored records

Overwatch keeps its state (checkpoints, incidents, investigations) in OpenCode's plugin storage. Every record carries
the schema version that wrote it. A newer Overwatch reads older records and upgrades them as it saves. An older
Overwatch refuses to read or overwrite records written by a newer one and says so in `/overwatch`, so going back a
version cannot damage them.

## Scheduling

Overwatch schedules its own runs with a timer inside the plugin rather than OpenCode automations. OpenCode loads a
plugin per directory it has open, and a lease in plugin storage lets only one of them run watchers. The timer runs
while the OpenCode server has at least one directory loaded; OpenCode unloads a directory after 60 idle minutes unless
something keeps it open. To keep watching while you are away, leave an OpenCode session open, or set
`"experimental": { "location_idle_timeout": false }` in the project config of a directory you keep open. When
OpenCode comes back, each watcher runs once and catches up from its checkpoints.
