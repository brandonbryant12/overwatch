# Customizing Overwatch

## The configuration grammar

Keys outside this grammar are refused by `check`.

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | required | `2`. |
| `dataDir` | `$XDG_DATA_HOME/overwatch` | Where `overwatch.db` and `service.json` live (mode 0700). Relative paths resolve from the configuration file. |
| `port` | `7331` | Loopback port; `0` picks a free one. |
| `mcpToken` | none | Secret reference for the bearer credential OpenCode sends to `/mcp`. Without it MCP refuses every call. |
| `opencode.url`, `opencode.model`, `opencode.password` | registration file; none; none | Where OpenCode answers, the model sessions use, and its password reference. |
| `readings` | `3` | Independent readings per investigation (1–3; used from milestone 3). |
| `apps.<app>.checkout` | required | The app's git checkout, read only through git objects. |
| `apps.<app>.environments.<env>.sources.<name>` | at least one | A source, below. |
| `watchers[]` | required | `{app, environment, every}`; `every` defaults to `2m` for `prod`/`production`, else `10m`. |

A Kubernetes source: `type: "kubernetes"`, `context`, `namespace`, `selector`, `readings` (any of `logs`,
`events`, `workloads`, `usage`; all by default). A Datadog source: `type: "datadog"`, `baseUrl` (https), `apiKey`,
`appKey` (secret references), `query`, `metric` (when `metrics` is read), `readings` (any of `logs`, `monitors`,
`metrics`). A reading you leave out is disabled and shown as not measured; it never counts for or against health.

## Operating limits

Inside these, behaviour is exact. They are `LIMITS` in `src/config.ts`.

| Limit | Value | Beyond it |
| --- | --- | --- |
| Watchers; sources per watcher; polling interval | 50; 4; at least 60 s | `check` refuses |
| Occurrences per source per slice | 50,000 | The count becomes a lower bound, coverage `capped`, the checkpoint moves, and a replay of that interval adds nothing |
| Distinct problems per source per slice | 500 | The rest fold into one "many other errors" incident |
| Log output per pod per call; pods per source | 4 MiB; 20 (in UID order) | Coverage `capped` |
| Overlap for late data | 2 min Kubernetes, 5 min Datadog | Older records are not counted |
| Catch-up after sleep | 14 days, in 6-hour slices | Older time is a recorded `gap` |
| Datadog rate limit | Retry-After up to 30 s, twice | Backs off; the checkpoint does not move |
| Agent run | 8 tool calls, 5 active minutes; 2 sessions at once | Refused; retried once, then parked |
| Evidence | 16 KiB per piece; 400 pieces per session; 50 per telemetry call | Truncated with a marker |
| Freshness | 3 polling intervals | `stale` |
| Disk | database 1 GiB; 256 MiB free | Old events compacted; below the floor collection pauses (`paused: "disk"`) |

## Where things are

| What | File |
| --- | --- |
| Configuration and limits | `src/config.ts` |
| Storage, writer, backup, restore, compaction | `src/store.ts` |
| Redaction rules | `src/redact.ts` |
| Collection, keys, slices | `src/collect.ts` |
| kubectl allowlist and parsers | `src/kube.ts` |
| Datadog requests | `src/datadog.ts` |
| Failure classification and back-off | `src/failures.ts` |
| Health and the snapshot | `src/snapshot.ts` |
| HTTP, server-sent events, MCP | `src/server.ts` |
| Investigation tools and evidence | `src/tools.ts` |
| The trial and reconciliation | `src/trial.ts` |
| OpenCode adapter | `src/opencode.ts` |
| Doctor | `src/doctor.ts` |
