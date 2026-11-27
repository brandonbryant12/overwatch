# Customizing Overwatch

## The configuration grammar

Keys outside this grammar are refused by `check`.

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | required | `2`. |
| `extends` | none | Optional string or array of JSON config paths (resolved relative to this file, merged left-to-right before strict schema validation; circular chains refused). Enables a shared corporate base plus personal laptop overrides (see [forking.md](forking.md)). |
| `dataDir` | `$XDG_DATA_HOME/overwatch` | Where `overwatch.db` and `service.json` live (mode 0700). Relative paths resolve from the configuration file. |
| `port` | `7331` | Loopback port; `0` picks a free one. |
| `mcpToken` | none | Secret reference for the bearer credential OpenCode sends to `/mcp`. Without it MCP refuses every call. |
| `redactPatterns` | none | Optional list of regex strings validated offline by `check` and applied alongside built-in redaction rules in `clean()` and `outbound()`, so corporate secret formats are scrubbed without editing `src/redact.ts`. |
| `opencode.url`, `opencode.model`, `opencode.password` | registration file; none; none | Where OpenCode answers, the model sessions use, and its password reference. |
| `opencode.concurrency` | `2` | Integer `1–6`: maximum concurrent OpenCode sessions across investigations, challengers, answers, fixers, and trials. Raise (e.g. `4`) for local GPU models like GLM 5.3. |
| `opencode.toolCalls` | `8` | Integer `8–24`: maximum MCP tool calls per agent run (paging and filing combined). Raise (e.g. `16`) when tokens are free for deeper log/span/code traversal. |
| `opencode.genUi` | `false` | Boolean: enables AI-synthesized declarative visual lenses (`POST /v2/items/:id/lens`, `g` key) grounded strictly in stored evidence handles. See [genui.md](genui.md). |
| `readings` | `3` | Independent readings per investigation: `1`, `2`, `3`, or `5`. Each starts from a distinct angle: (1) telemetry, (2) deployed change, (3) harmless explanation, (4) latency and resource saturation, (5) recent commits and config drift. A real verdict needs strictly more than half of all planned slots; fixes require unanimous real readings with `readings >= 3`. |
| `apps.<app>.checkout` | required | The app's git checkout, read only through git objects. |
| `apps.<app>.problemPatterns` | `{error: [error, fatal, panic, exception, critical], warn: [warn, warning]}` | Literal whole words (any case) that make a log line an error or a warning, per class; a list replaces that class's defaults for this app, an empty list turns the class off, a missing class keeps its defaults. Error wins a tie. A provider's own severity (Datadog's status, a Kubernetes Warning event, a gauge rule) is not affected. |
| `apps.<app>.commitWatch` | none | Optional `{branch?, paths?, limit?}`: read-only git inspection of new commits landing in `checkout`, computing deterministic risk flags (`config`, `database`, `auth`, `timeout`, `large_diff`, `unreleased` vs `deployed`) surfaced in `/v2/outlook`, `ow_outlook`, the Overview board, and `commit_risk` lenses. |
| `apps.<app>.environments.<env>.sources.<name>` | at least one | A source, below. |
| `apps.<app>.fixes` | none (no proposals) | Opt in to fix proposals: `{remote, base, paths, verify, mode?}`. `remote` and `base` are Git names in the checkout (`origin`, `main`). `paths` are 1–10 exact repository-relative files a fix may change; build, dependency, lock, CI, hook and credential files are refused. `verify` is 1–4 argv lists run in an isolated checkout (`[["npm", "test"]]`); a file they name cannot also be in `paths`. `mode` is `"propose"` (default, human-in-the-loop: stops at `verified` for your `Shift-P`) or `"draft_pr"` (opt-in human-on-the-loop: runs the same permit-gated `--draft` PR publication once `verified` and all gates pass; never merges). |
| `apps.<app>.promotion` | none | `{staging, production}`: two watched environments of this app, polled at the same interval, compared after each staging release. |
| `watchers[]` | required | `{app, environment, every}`; `every` defaults to `2m` for `prod`/`production`, else `10m`. |

A Kubernetes source: `type: "kubernetes"`, `context`, `namespace`, `selector`, `readings` (any of `logs`,
`events`, `workloads`, `usage`; all by default). A Datadog source: `type: "datadog"`, `baseUrl` (https), `apiKey`,
`appKey` (secret references), `query`, `metric` (when `metrics` is read), `readings` (any of `logs`, `monitors`,
`metrics`, plus opt-in `spans`; default when omitted remains `logs`, `monitors`, `metrics`), `spans` (opt-in
`{slowMs, warnMs?, query?}` for slow-span / latency regression collection via `/api/v2/spans/events/search`,
deduplicated by span ID and normalized by `span:<service>:<resource>`), and `capacity` on a source that reads
`metrics`: `{resource: "disk"|"memory"|"quota", unit: "bytes"|"units", limit}` when the metric measures used capacity
against a fixed ceiling (for time left). A reading you leave out is disabled and shown as not measured; it never counts
for or against health.

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
| Agent run | `opencode.toolCalls` (default 8, range 8–24; paging and filing together), 5 minutes on the service's clock; `opencode.concurrency` (default 2, range 1–6) sessions at once across the trial, readings, challengers, answers and fixers | Refused; the session is interrupted and its slot released; retried once, then a missing vote (or a parked answer) |
| Queue | Owner questions first, then investigations by age; one turn at a time per conversation | A question waits at most for the rest of one running session |
| Investigation inputs | The problem's latest 200 lines, the deployed revision, the app's latest 20 playbook lines, frozen when queued | Older lines are not read |
| Notifications | On moving into Needs you; terminal-notifier; retries after 60 s and 300 s, three attempts | Parked with the reason in `/v2/notifications` |
| Evidence | 16 KiB per piece; 50 per telemetry call, so at most 7 pages before filing; 400 pieces per session as a storage ceiling | Truncated with a marker |
| Freshness | 3 polling intervals | `stale` |
| Disk | 1 GiB in use; 256 MiB free; both checked before every write, by every path | Old events go, then what age allows (never a finding or its cited evidence); if not enough, every write waits (`paused: "disk"`, with `pausedFix`) and the checkpoint stays |
| Giving space back | 16 MiB per scheduler pass, any page size | Free pages are reused meanwhile |
| A fix's change | One commit of the deployment reverted (against its first parent), or one top-level JSON scalar restored; existing regular files of `paths` only, same mode; at most 3 files, 80 changed lines, 16 KiB | Refused with the reason; nothing is pushed |
| A fix's verification | At most 4 commands, 60 s each, 180 s in all, 64 KiB of output; no network; writes only in its checkout and temporary folder | Fails closed (`verify_failed`), and the fix gate is revoked until a new `trial --fixes` passes |
| Fix eligibility | Unanimous real readings with `readings >= 3` (3 of 3 or 5 of 5), challenger upheld, observed in telemetry, exact count, first line strictly after the rollout, a clean interval before it, fresh telemetry, both trials passed | No proposal; the first rule that fails is the one line shown |
| Opening a draft | Default `mode: "propose"` only on your `Shift-P`; opt-in `mode: "draft_pr"` automatically once `verified` and calibrated; one at a time per attempt; each host step recorded first and read back; protection read before every push; never merges | It stops at that step and says what exists on the host; `Shift-P` again continues |
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
