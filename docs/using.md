# Using Overwatch

What exists in phase 1A, and what does not yet. Anything marked *planned* is described in
[plans/command-center.md](plans/command-center.md) and is not built.

## What the service does on its own

- **Polls each watcher on its schedule** (`every`, 10 minutes by default), whether or not OpenCode is open. A run
  reads each source from where it last succeeded, minus a two-minute overlap, in slices, oldest first. After a sleep
  it runs once and covers the whole gap; it does not run once per missed interval. A stretch older than
  `lookback.max` is not read: it is recorded as a gap, both in the coverage table and as an event on the watcher.
- **Opens one incident per breach.** A signal (for Kubernetes: a normalized error log line, a failing pod, a warning
  event; for Datadog: a group of error logs, an alerting monitor) is identified by its fingerprint in its app and
  environment. More of the same signal counts quietly against the existing incident. A poll that finds nothing new
  writes nothing to the event log. A run saves what it found together with its checkpoint before reporting it, so a
  crash part way through never counts an occurrence twice.
- **Watches measured values, not only logs.** Memory and CPU against the pods' own limits, pods not ready or pending,
  replicas unavailable, an autoscaler at its maximum, node memory and namespace quotas (and any Datadog metric you
  configure) are kept as series and checked against rules with hysteresis: a value must breach on several polls in
  a row to open an incident, and clear on several to stop counting. A metric the last poll could not read is shown as
  not measured, never as fine.
- **Tells you about production.** A new incident in a production-tier environment, and a finding for one, each raise
  one macOS notification per incident (the finding's notification is its plain product summary). Other tiers are
  quiet unless you turn them on (see [customizing.md](customizing.md)).
- **Records one triage intent per new incident**: a prompt on the incident's thread, asked by Overwatch. With
  `opencode.autoInvestigate` on (the default) it becomes an investigation; off, it waits as `held` until you prompt.
- **Drives investigations into OpenCode** and follows them to a finding whose citations were checked by code.
- **Keeps a search index** of incidents, findings, prompts and threads, built from the event log.

## Environments at a glance

Under the header, a strip shows every watched app and environment, production first, with its state in words and a
glyph: `Checked, quiet`, `N open` (needs a look), `Over a limit`, `Check failing: …`, `Not checked yet`, or
`Not checked for <time>` once three polling intervals have passed without a full check. Each shows how long ago it
was checked and, for Kubernetes, the latest readiness (`all pods ready`, `2 not ready`) and memory against limit.
Anything not measured says so; not checked and stale use the hatched unknown pattern, so an empty inbox with stale
environments never looks like a healthy one.

## The inbox

The page at `http://127.0.0.1:7450` shows the inbox on the left: every incident that needs a look, ranked by severity
and environment tier (or sorted by most recent), with filters for `All`, `Prod`, and `Pre-prod`. Each row shows its
severity glyph, app and environment, occurrence count, age, and the verdict once there is a finding. It updates live;
there is no reload button.

To explore the page with realistic data without connecting to a real cluster or OpenCode, run `pnpm run demo` (use
`-- --port <n>` for a custom port or `-- --empty` for the empty inbox state).

Things leave the inbox one way in phase 1A:

- **Archive** (click the archive icon or press `a` / `e` on a focused item): the incident leaves the inbox for good
  and focus advances to the next item. More occurrences of the same signal update the archived incident (its count
  and timeline) without bringing it back.

*Planned*: snooze, suppress (rules), delegate, act, grouping one cause across environments into one decision, and
items coming back only for something materially new.

## Focus and the prompt bar

Click an incident (or step through the inbox with `j` / `k`) to put it in focus. The right stage shows what was seen
(the redacted sample line and the copyable command to see it again), structured findings with product impact, root
cause, next check, ruled-out hypotheses, unchecked gaps, and each citation marked verified (`✓ Verified by code`) or
unverifiable (`? Unverifiable`, rendered on a hatched unknown surface), the thread (active sessions, latest handoff
for fresh sessions, and every prompt with its `held`, `queued`, `sent`, `answered`, or `failed` status), and the
incident timeline.

Press `p` or `Enter` to jump into the docked prompt bar, type, and send. The prompt is recorded on the incident's
thread and served by an OpenCode session with the `overwatch-investigator` agent, in a worktree of the app's
checkout. The session receives a context pack built by code from the event log (the incident, recent findings, and
the thread's last handoff), what is deployed (the revisions running, when the rollout began, the revision it replaced
and the commits it brought in), the latest capacity summary, and a run token. The worktree is at the deployed commit
when Overwatch can tell which one that is; when it cannot, the brief says the code is the checkout's HEAD and not the
deployed code, and the finding records which code it read (shown on the page under the finding).

The investigator reads telemetry through Overwatch's `query_telemetry` tool (structured read operations, for
Kubernetes `logs`, `get`, `describe` and `top`, never free-form `kubectl` arguments), code with read, glob and grep,
and history with `git_history` (`log`, `show`, `blame`, `diff`); it has no shell. It files a finding with
`file_finding`. A quote attributed to a telemetry source must be in what that source returned to the session (a
query result, or a sample line the brief attributes to it); a quote from a file must be in that file. The owner's
question and Overwatch's own description of the incident are shown to the session but are not evidence. A finding
with a quote that is not where it says is refused with the reason, and the agent tries again.

Each finding has a **Copy summary** button: impact, who is affected, since when and status as one paragraph, to paste
to someone outside engineering. What you type in the prompt bar belongs to the incident it was typed on, and stays
there until the service confirms the prompt; if a send fails, the text is still there to send again.

Only incidents can be in focus in phase 1A. *Planned*: anything on screen (a pod, a metric window, a piece of
evidence, a selection, a search result set) as the focus, and modes other than investigate.

## Same session or a new one

Before you send, the prompt bar shows your locked focus target and what will happen, for example
`continues ses_...: continues the idle session` or `new session: a new session`. The decision is a pure function of
the thread's sessions, the mode, and your choice in the segmented selector (`Auto`, `New`, `Here`) next to the input:

| Choice | What happens |
| --- | --- |
| `Auto` | No session yet, or the last one failed: a new session. An idle session in the same mode: continue it. A running one: the prompt is queued behind its current turn (never interrupting it). Several: the most recent idle one. |
| `New` | Always a new session. It starts from the thread's handoff, so it knows what was concluded and ruled out. |
| `Here` | The latest session, whatever its state. |

The thread runs the same function again when your prompt arrives, so what the page showed and what happens agree.

*Planned*: answering a session that waits on a permission first, and starting fresh when the deployed revision
changed or the session grew too large.

## Keyboard shortcuts and theme

Press `?` anywhere on the page to open the keyboard reference: `j`/`k` (or arrow keys) move focus through the inbox,
`a`/`e` archive the focused incident, `p`/`Enter` jump to the prompt bar, `/` or `⌘K` open search, `1`/`2`/`3`
switch environment filters, `t` toggles between Night Watch (dark) and Daylight Chart (light), and `Esc` closes
overlays or leaves the prompt input.

## Working from OpenCode

Every session Overwatch starts is a normal OpenCode session titled `Overwatch: <incident>`. Open it and keep talking.
A prompt you type there is recorded on the same thread (origin `opencode`); Overwatch gives the session a new run
token and checks its finding like any other.

Any OpenCode session (not only Overwatch's) has the `overwatch` skill and the read tools: the inbox, an incident, a
thread, and search. Only sessions Overwatch started can query telemetry or file findings.

## Search

Search covers incidents (archived ones too), findings, prompts, and threads, by words or by exact id. Press `/` or
`⌘K` (or click the search bar in the header) to search from the page and jump directly into any incident, including
archived ones. Search is also available via the Api's `Search` query and the MCP tool `OverwatchApi_Search_ask`.
*Planned*: filtering by app/environment/time and prompting directly on a search result set.

## When OpenCode is closed

Polling, the page, archive, and search keep working. The top header shows OpenCode's live connection state and how
many runs are waiting (click it to inspect all watchers and queue counts from `/status`). A prompt you send is
recorded and its run waits: the prompt bar notes that it will queue, the thread shows it as `queued`, and
`bin/overwatch status` shows OpenCode not connected and how many runs wait. When OpenCode starts, each waiting run is
sent once. If OpenCode restarts in the middle of a run, the run continues: a managed OpenCode server resumes the turn
itself, and if a turn was not resumed Overwatch asks the session once to continue. Session and message ids are chosen
by Overwatch and recorded before anything is sent, so nothing is sent twice.

A run whose session ends twice without a finding, or that runs past `opencode.runTimeoutMinutes`, fails with the
reason on the thread. Prompt again to start a new session from the handoff.

## When a source is failing

The run's failure is in `bin/overwatch status` (`last_error`), the source's checkpoint stays where it was, and the
next run covers the same time again. *Planned* (phase 1B): classifying failures (sign-in, permission, rate limit,
unreachable, configuration), backing off and suspending, one inbox item per cause, and a Connections page.
