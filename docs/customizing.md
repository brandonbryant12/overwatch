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
| `readings` | `3` | Independent readings per investigation, 1–3. Each starts from a different place (the telemetry, the change, a harmless explanation); a real verdict needs more than half of them, so 1 trusts one reading (still challenged), 3 is the most robust and costs three sessions per problem. |
| `apps.<app>.checkout` | required | The app's git checkout, read only through git objects. |
| `apps.<app>.problemPatterns` | `{error: [error, fatal, panic, exception, critical], warn: [warn, warning]}` | Literal whole words (any case) that make a log line an error or a warning, per class; a list replaces that class's defaults for this app, an empty list turns the class off, a missing class keeps its defaults. Error wins a tie. A provider's own severity (Datadog's status, a Kubernetes Warning event, a gauge rule) is not affected. |
| `apps.<app>.environments.<env>.sources.<name>` | at least one | A source, below. |
| `apps.<app>.fixes` | none (no proposals) | Opt in to draft fixes: `{remote, base, paths, verify}`. `remote` and `base` are Git names in the checkout (`origin`, `main`). `paths` are 1–10 exact repository-relative files a fix may change; build, dependency, lock, CI, hook and credential files are refused. `verify` is 1–4 argv lists run in an isolated checkout (`[["npm", "test"]]`); a file they name cannot also be in `paths`. |
| `apps.<app>.promotion` | none | `{staging, production}`: two watched environments of this app, polled at the same interval, compared after each staging release. |
| `watchers[]` | required | `{app, environment, every}`; `every` defaults to `2m` for `prod`/`production`, else `10m`. |

A Kubernetes source: `type: "kubernetes"`, `context`, `namespace`, `selector`, `readings` (any of `logs`,
`events`, `workloads`, `usage`; all by default). A Datadog source: `type: "datadog"`, `baseUrl` (https), `apiKey`,
`appKey` (secret references), `query`, `metric` (when `metrics` is read), `readings` (any of `logs`, `monitors`,
`metrics`), and `capacity` on a source that reads `metrics`: `{resource: "disk"|"memory"|"quota", unit:
"bytes"|"units", limit}` when the metric measures used capacity against a fixed ceiling (for time left). A reading
you leave out is disabled and shown as not measured; it never counts for or against health.

## Operating limits

Inside these, and where every reading was fully measured, counts are exact; otherwise they are marked as lower
bounds (see [using.md](using.md)). They are `LIMITS` in `src/config.ts`.

| Limit | Value | Beyond it |
| --- | --- | --- |
| Watchers; sources per watcher; polling interval | 50; 4; at least 60 s | `check` refuses |
| New occurrences per source per slice | 50,000 (replays are not charged) | The count becomes a lower bound, coverage `capped`, the checkpoint moves, and a replay of that interval adds nothing |
| Distinct problems per source per slice | 500 | The rest fold into one "many other errors" incident |
| Log output per pod per call; pods per source | 4 MiB; 20 (in UID order) | Coverage `capped` |
| Overlap for late data | 2 min Kubernetes, 5 min Datadog, never below the 14-day floor | Older records are not counted |
| Catch-up after sleep | 14 days, in half-open 6-hour slices, each committed with its checkpoint | Older time is a recorded `gap`; active totals become lower bounds |
| Gauge problems | memory > 90 % of limit, pods not ready > 0; 2 measured samples to open, 2 to close | `METRIC_RULES` in `src/collect.ts`; an unmeasured sample breaks both runs |
| Quiet | 3 consecutive new, ordinary (at most two polling intervals), fully measured intervals with nothing new; a failed pass, replay or catch-up resets the count | The problem stops holding health in `attention` and moves to Quiet; its total stays |
| Done's grace | One polling interval of its environment, on the service's own admission | Admissions inside it are counted but do not bring it back |
| Rates for Later and Never | 5 new occurrences, and a trailing day 2× (Later) or 10× (Never) the day before the action (at least 1), only when that baseline was exact | Hourly counts per problem by event time (a day rounded to the hour), kept 30 days |
| Age | Trial messages and uncited evidence 7 days; real 14 days; coverage and hourly counts 30 days | Removed on every pass; findings and the evidence they cite are kept for good |
| Search | 50 results per page, with a cursor | Every match reachable |
| Datadog rate limit | Retry-After up to 30 s, twice | Backs off; the checkpoint does not move |
| Agent run | 8 tool calls (paging and filing together), 5 minutes on the service's clock; 2 sessions at once across the trial, readings, challengers and answers | Refused; the session is interrupted and its slot released; retried once, then a missing vote (or a parked answer) |
| Queue | Owner questions first, then investigations by age; one turn at a time per conversation | A question waits at most for the rest of one running session |
| Investigation inputs | The problem's latest 200 lines, the deployed revision, the app's latest 20 playbook lines, frozen when queued | Older lines are not read |
| Notifications | On moving into Needs you; terminal-notifier; retries after 60 s and 300 s, three attempts | Parked with the reason in `/v2/notifications` |
| Evidence | 16 KiB per piece; 50 per telemetry call, so at most 7 pages before filing; 400 pieces per session as a storage ceiling | Truncated with a marker |
| Freshness | 3 polling intervals | `stale` |
| Disk | 1 GiB in use; 256 MiB free; both checked before every write, by every path | Old events go, then what age allows (never a finding or its cited evidence); if not enough, every write waits (`paused: "disk"`, with `pausedFix`) and the checkpoint stays |
| Giving space back | 16 MiB per scheduler pass, any page size | Free pages are reused meanwhile |
| A fix's change | One commit of the deployment reverted (against its first parent), or one top-level JSON scalar restored; existing regular files of `paths` only, same mode; at most 3 files, 80 changed lines, 16 KiB | Refused with the reason; nothing is pushed |
| A fix's verification | At most 4 commands, 60 s each, 180 s in all, 64 KiB of output; no network; writes only in its checkout and temporary folder | Fails closed (`verify_failed`), and the fix gate is revoked until a new `trial --fixes` passes |
| Fix eligibility | 3 of 3 readings real, challenger upheld, observed in telemetry, exact count, first line strictly after the rollout, a clean interval before it, fresh telemetry, both trials passed | No proposal; the first rule that fails is the one line shown |
| Following a draft | The host is asked at most once a minute per draft | Merged → waiting for a release containing it → 3 quiet intervals → ready to close (you close it with Done) |
| Time left | 6 distinct provider samples since the last gap, ceiling change or decrease, at least 5 intervals end to end, each step positive and at most 2 intervals, the newest at most 1 interval old, every step within 25 % of the median slope; shown only within 24 hours | No estimate, with the reason |
| Staging against production | Two aligned, ordinary, fully measured intervals after a staging release; a staging-only problem new since the release, seen in both, at least 3 times, none in production | `no_signal` or `unknown` (with the side and interval) |

## Playbooks

A playbook is what the owner wants every later investigation of an app to know. It is written from the page, never
by hand and never by an agent: focus a problem that has a finished investigation, press `y` ("Was this right?"),
and write one line, for example *The regional maintenance window runs 02:00–03:00 UTC; check it before calling a
timeout real* or *Payments timeouts under 10 a minute are the provider's own; check its status page first*. Each
line is stored with its date, its problem and the investigation it corrects, and the file
`<dataDir>/playbooks/<app>.jsonl` (one JSON object per line: `date`, `seq`, `app`, `subject`, `jobId`, `text`) is
rebuilt whole from the database after every correction and at start. Editing the file changes nothing; the database
is authoritative.

Each new investigation snapshots the app's latest 20 lines when it is queued and gives them to every reader as owner
guidance (data to weigh, not instructions). The challenger does not get them: its job is to test the readers'
conclusion against the evidence alone, and a playbook line it shared with them would be a common cause, not an
independent check. A correction never changes the verdict it corrects
and is never a vote. Write lines that are true for the app in general, short and checkable; one line per lesson.

## Where things are

| What | File |
| --- | --- |
| Configuration and limits | `src/config.ts` |
| Storage, writer, backup, restore and its invariants, retention, reclaim | `src/store.ts` |
| Reading outside values (numbers, counts, times) | `src/parse.ts` |
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
| Agents: queue, investigations, adjudication, answers, open, playbooks, notifications | `src/agents.ts` |
| Briefs | `src/brief.ts` |
| The owner skill | `skills/overwatch/SKILL.md` |
