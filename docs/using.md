# Using Overwatch

What exists in phase 1A, and what does not yet. Anything marked *planned* is described in
[plans/command-center.md](plans/command-center.md) and is not built.

## What the service does on its own

- **Polls each watcher on its schedule** (`every`, 10 minutes by default), whether or not OpenCode is open. A run
  reads each source from where it last succeeded, minus a two-minute overlap, in slices, oldest first. After a sleep
  it runs once and covers the whole gap; it does not run once per missed interval. A stretch older than
  `lookback.max` is not read: it is recorded as a gap, both in the coverage table and as an event on the watcher.
- **Opens one incident per breach.** A signal (for Kubernetes: a normalized error log line, a failing pod, a warning
  event) is identified by its fingerprint in its app and environment. More of the same signal counts quietly against
  the existing incident. A poll that finds nothing new writes nothing to the event log.
- **Records one triage intent per new incident**: a prompt on the incident's thread, asked by Overwatch. With
  `opencode.autoInvestigate` on (the default) it becomes an investigation; off, it waits as `held` until you prompt.
- **Drives investigations into OpenCode** and follows them to a finding whose citations were checked by code.
- **Keeps a search index** of incidents, findings, prompts and threads, built from the event log.

## The inbox

The page at `http://127.0.0.1:7450` shows the inbox on the left: every incident that needs a look, newest first, with
its app and environment, how often it happened, and the verdict once there is a finding. It updates live; there is
no reload button.

Things leave the inbox one way in phase 1A:

- **Archive**: the incident leaves the inbox for good. More occurrences of the same signal update the archived
  incident (its count and timeline) without bringing it back.

*Planned*: snooze, suppress (rules), delegate, act, grouping one cause across environments into one decision, and
items coming back only for something materially new.

## Focus and the prompt bar

Click an incident to put it in focus. The right side shows what was seen (a sample line, how to see it again), its
timeline, its findings with each citation marked ✓ (found by code where it says) or ? (could not be checked), and its
thread: every prompt asked about it, how each was routed, and its status (`held`, `queued`, `sent`, `answered`,
`failed`).

Type in the prompt bar and send. The prompt is recorded on the incident's thread and served by an OpenCode session
with the `overwatch-investigator` agent, in a worktree of the app's checkout. The session receives a context pack
built by code from the event log (the incident, recent findings, and the thread's last handoff) and a run token. The
investigator reads telemetry through Overwatch's `query_telemetry` tool and the code in its worktree, and files a
finding with `file_finding`. Overwatch checks every quote against what that session was shown and the files it
names; a finding with a quote that is not there is refused with the reason, and the agent tries again.

Only incidents can be in focus in phase 1A. *Planned*: anything on screen (a pod, a metric window, a piece of
evidence, a selection, a search result set) as the focus, and modes other than investigate.

## Same session or a new one

Before you send, the prompt bar says what will happen, for example `continues ses_…: continues the idle session` or
`new session: a new session`. The decision is a pure function of the thread's sessions, the mode and your choice in
the selector next to the prompt bar:

| Choice | What happens |
| --- | --- |
| `auto` | No session yet, or the last one failed: a new session. An idle session in the same mode: continue it. A running one: the prompt is queued behind its current turn (never interrupting it). Several: the most recent idle one. |
| `new` | Always a new session. It starts from the thread's handoff, so it knows what was concluded and ruled out. |
| `here` | The latest session, whatever its state. |

The thread runs the same function again when your prompt arrives, so what the page showed and what happens agree.

*Planned*: answering a session that waits on a permission first, and starting fresh when the deployed revision
changed or the session grew too large.

## Working from OpenCode

Every session Overwatch starts is a normal OpenCode session titled `Overwatch: <incident>`. Open it and keep talking.
A prompt you type there is recorded on the same thread (origin `opencode`); Overwatch gives the session a new run
token and checks its finding like any other.

Any OpenCode session (not only Overwatch's) has the `overwatch` skill and the read tools: the inbox, an incident, a
thread, and search. Only sessions Overwatch started can query telemetry or file findings.

## Search

Search covers incidents (archived ones too), findings, prompts and threads, by words or by exact id. In phase 1A it
is available as the Api's `Search` query and the MCP tool `OverwatchApi_Search_ask`; the page has no search box yet
(*planned*: a command palette).

## When OpenCode is closed

Polling, the page, archive and search keep working. A prompt you send is recorded and its run waits: the thread
shows it as `queued`, and `bin/overwatch status` shows OpenCode not connected and how many runs wait. When OpenCode
starts, each waiting run is sent once. If OpenCode restarts in the middle of a run, the run continues: a managed
OpenCode server resumes the turn itself, and if a turn was not resumed Overwatch asks the session once to continue.
Session and message ids are chosen by Overwatch and recorded before anything is sent, so nothing is sent twice.

A run whose session ends twice without a finding, or that runs past `opencode.runTimeoutMinutes`, fails with the
reason on the thread. Prompt again to start a new session from the handoff.

## When a source is failing

The run's failure is in `bin/overwatch status` (`last_error`), the source's checkpoint stays where it was, and the
next run covers the same time again. *Planned* (phase 1B): classifying failures (sign-in, permission, rate limit,
unreachable, configuration), backing off and suspending, one inbox item per cause, and a Connections page.
