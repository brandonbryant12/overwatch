# Using Overwatch

What exists now, and what does not yet. Anything marked *planned* is described in
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
glyph: `Checked, quiet`, `N open` (needs a look), `Over a limit`, `Check failing: …`, `Checked, memory not measured`,
`Not checked yet`, `Not checked for <time>` once three polling intervals have passed without a full check, or
`Not checked since <time> (signed out)` when its connection is suspended. Each shows how long ago it was checked and,
for Kubernetes, the latest readiness and memory against limit.

"Quiet", on the strip or as the inbox's all-clear, comes from one rule: never while any environment is suspended,
failing, not yet checked, stale, over a limit, missing a reading it should have, or has something open, and never
while a cause is waiting on you. An empty inbox with something unchecked says "Inbox empty", not "All quiet".

## The inbox

The page at `http://127.0.0.1:7450` shows the inbox on the left, grouped by why each thing needs you:

- **Needs you**: something that stops Overwatch working (a signed-out connection, everything offline, OpenCode not
  running while work waits), anything that came back, and a production incident whose finding says real or unsure or
  whose investigation failed after its retry.
- **Working**: an agent is on it and there is nothing to do yet; collapsed to a count.
- **New**: arrived, or changed (a new finding, a rise in severity), since you last looked at it.
- **Quiet**: handled without you (the finding says not real), or looked at and unchanged; collapsed to a count.

A row is in the first group that applies, with one line saying why when it needs you. Within a group rows are ranked
by severity and tier (or by most recent), with filters for `All`, `Prod` and `Pre-prod` by the tier each environment
is configured with.

**Rows never move while you look.** A row that changes updates in place. What arrives, or now belongs in another group,
waits behind that group's `N new` line; press `r` (or click the line, or come back to the page) to show them, sorted.
When nothing is shown at all, what arrives is shown at once. "Since you last looked" is kept in your browser.

To explore the page with realistic data without connecting to a real cluster or OpenCode, run `pnpm run demo` (use
`-- --port <n>` for a custom port or `-- --empty` for the empty inbox state). It seeds every group, an incident marked
Done, one that came back saying why, one deferred until something changes, a muted one, and a suspended connection.

## Three ways out

Each is one key on the incident in focus, or a button on its row and in its header. Each says what it did, with
`u` to undo; anything that left the inbox can be found by search and put back from its page.

- **Done** (`d`): "this is dealt with." It comes back if it happens again: "Back: happened again 3 times since you
  marked it done." Occurrences already in flight (within one polling interval of Done) do not count. The count is
  what the report determines; when a batch spans that interval and its middle is unknown, it says "at least once".
- **Later** (`l`): "not now." Type until when: `2h`, `2d`, `tomorrow` or `monday` (9:00 your time), `worse` for
  until it gets worse, or nothing for until something changes (a new finding on it, or a deploy in its environment).
  Any Later also comes back if it gets worse: the severity rises, or the rate reaches twice what it was with at least
  five more. It comes back saying which. `w` is Later until it gets worse, in one key: "I know about this level, tell
  me if it grows."
- **Never** (`n`): "stop raising this." Before you confirm, it shows how many it would have hidden over the last 14
  days; you can give a reason (noise, expected, duplicate). It mutes this incident's fingerprint in its app and
  environment, and breaks through only if the severity rises or the rate reaches ten times what it was. `m` (or
  `Muted N` above the inbox) lists everything muted with its reason, how many it hid this week, when it last did, and
  Undo.

A Done that came back three times within 14 days was probably the wrong way out: its row offers `w` Later until it
gets worse, or `n` Never. It only offers. Every way out, undo and return is an event recording who issued it. The
thresholds are configuration (see [customizing.md](customizing.md)).

*Planned*: grouping one cause across environments into one decision, bulk actions, and a general rule editor.

## Focus and the prompt bar

Click an incident (or step through the inbox with `j` / `k`) to put it in focus. The right stage shows what was seen
(the redacted sample line and the copyable command to see it again), structured findings with product impact, root
cause, next check, ruled-out hypotheses, unchecked gaps, and each quote marked `✓ Exact quote matched` (found where
the finding says, which proves the words are there, not that the conclusion is right) or `? Not matched` (on a hatched
unknown surface). A finding's header shows how many of its quotes matched ("2 of 3 quotes matched") and whether the
code it read was the deployed code, not the model's own confidence; the thread (active sessions, latest handoff
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
question and Overwatch's own description of the incident are shown to the session but are not evidence; a quote from
`git_history`'s output counts. A finding with a quote that is not where it says is refused with the reason, and the
agent tries again. A verdict of real with the cause marked observed needs at least one matched quote; without one the
cause is recorded as inferred, and the agent is told.

Each finding has a **Copy summary** button: impact, who is affected, since when and status as one paragraph, to paste
to someone outside engineering. What you type in the prompt bar belongs to the incident it was typed on, and stays
there until the service confirms the prompt; if a send fails, the text is still there to send again.

Only incidents can be in focus in phase 1A. *Planned*: anything on screen (a pod, a metric window, a piece of
evidence, a selection, a search result set) as the focus, and modes other than investigate.

## Same session or a new one

Sessions are workers you do not manage. Before you send, the prompt bar shows your locked focus target and where the
prompt will go, for example `continues ses_...: continues the idle session` or `new session: a new session`:

- No session yet, or the last one failed: a new session. An idle session: continue it. A running one: the prompt is
  queued behind its current turn (never interrupting it). Several: the most recent idle one.
- **Shift+Enter** sends in a new session instead. It starts from the thread's handoff, so it knows what was concluded
  and ruled out.

The thread runs the same function again when your prompt arrives, so what the page showed and what happens agree.

## Keyboard shortcuts and theme

Press `?` anywhere on the page for the keyboard reference: `j`/`k` (or arrow keys) move through the rows as shown,
`d` Done, `l` Later, `w` Later until it gets worse, `n` Never, `u` undo, `r` show new rows, `m` the muted list,
`p`/`Enter` jump to the prompt bar (Shift+Enter there sends in a new session), `/` or `⌘K` search, `1`/`2`/`3`
environment filters, `t` theme, and `Esc` closes a sheet or leaves the prompt input.

## Working from OpenCode

Every session Overwatch starts is a normal OpenCode session titled `Overwatch: <incident>`. Open it and keep talking.
A prompt you type there is recorded on the same thread (origin `opencode`); Overwatch gives the session a new run
token and checks its finding like any other.

Any OpenCode session (not only Overwatch's) has the `overwatch` skill and the read tools: the inbox, an incident, a
thread, and search. Only sessions Overwatch started can query telemetry or file findings.

## Search

Search covers incidents wherever they went (Done, Later, Never), findings, prompts, and threads, by words or by exact
id. Press `/` or `⌘K` (or click the search bar in the header) to jump into any incident; one that left the inbox shows
where it went and a `Put back` button. Search is also available via the Api's `Search` query and the MCP tool `OverwatchApi_Search_ask`.
*Planned*: filtering by app/environment/time and prompting directly on a search result set.

## When OpenCode is closed

Polling, the page, the ways out, and search keep working. With work waiting, `Needs you` shows one item: OpenCode is
not running, with how many investigations wait. The top header shows OpenCode's live connection state and how
many runs are waiting (click it to inspect all watchers and queue counts from `/status`). A prompt you send is
recorded and its run waits: the prompt bar notes that it will queue, the thread shows it as `queued`, and
`bin/overwatch status` shows OpenCode not connected and how many runs wait. When OpenCode starts, each waiting run is
sent once. If OpenCode restarts in the middle of a run, the run continues: a managed OpenCode server resumes the turn
itself, and if a turn was not resumed Overwatch asks the session once to continue. Session and message ids are chosen
by Overwatch and recorded before anything is sent, so nothing is sent twice.

A run whose session ends twice without a finding, or that runs past `opencode.runTimeoutMinutes`, fails with the
reason on the thread, and is retried once in a fresh session. If the retry fails too, the work is parked: a production
incident then shows under `Needs you` with the reason. Prompt again to start a new session from the handoff.

## When a source is failing

Overwatch does not hammer a thing that is broken, and tells you once. Each failure is classified by what it says:

| Kind | Example | What Overwatch does |
| --- | --- | --- |
| Sign-in | `You must be logged in to the server (Unauthorized)`, a rejected Datadog key | One confirming attempt at the next poll, then suspended. |
| Permission | `pods is forbidden: … cannot list` | That source is suspended; the rest keep working. |
| Configuration | an unknown namespace or context | Suspended until its configuration changes. |
| Rate limit | HTTP 429 | Waits as long as asked, else a growing wait. Never suspended. |
| Unreachable | timeouts, refused connections, gateway errors, the VPN down | A growing wait (1m, 2m, 4m… up to 30m), then suspended after 5 in a row. |

A sign-in failure is per connection (a kubectl context, a Datadog site): every source behind it waits. A suspended
connection is one item under `Needs you` with the exact command that fixes it, updated quietly while it lasts and gone
once it recovers; if every connection is unreachable at once, that is one item, "Offline or off the VPN". Its
environments show `Not checked since …`, never quiet, and nothing read through it is counted, so its incidents
neither resolve nor come back. Overwatch tries a suspended connection again every 30 minutes with one ordinary poll,
and at once after waking from sleep or a network change; when it works, the source catches up from its checkpoint.
Suspending and resuming are events on the watcher. The limits are configuration (`failures`).

*Planned*: a Connections page with retry and resume buttons, turning off only the one check a permission forbids (a
whole source is suspended today), and pausing the agent queue when the model provider (not OpenCode) is down.
