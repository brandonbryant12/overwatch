# Using Overwatch

What milestone 1 does. There is no page yet; everything is the command line, the loopback API and the event log.

## What the service does by itself

Every polling interval, for each source that is due:

- **Kubernetes**: lists the pods (the one call that also tells a signed-out cluster from a working one), reads each
  container's logs since the checkpoint minus a two-minute overlap (current and previous instance, up to 20 pods in
  UID order and 4 MiB per call), lists the pods again, then reads the namespace's warning events, the workloads'
  running revision and how many pods are not ready, and memory against the pods' own limits. After a sleep it
  catches up in six-hour slices, up to 14 days.
- **Datadog**: searches logs page by page in six-hour slices with a five-minute overlap, reads monitors and the
  configured metric.

Every window is half-open, `[from, to)`: a record exactly at a slice's end belongs to the next slice, and nothing
older than the 14-day floor is read, even inside an overlap.

Each line or log that is a problem counts once against an incident for its app, environment, source and problem.
The words error, fatal, panic, exception and critical (whole words, any case) make an error, which affects health;
warn and warning are counted and kept but do not change health. Numbers, IDs, quoted values and times do not split a
problem. Only new records are counted against the 50,000 per slice: a replayed record (its key is already stored)
or one inside an interval that already hit the limit is passed over first, so it can never use up a fresh
record's room.

A count is a lower bound (`exact: false`, shown as `N+`) whenever Overwatch knows it may have missed some: a slice
passed the storm limit; lines counted earlier were lost (rotation); a read was ambiguous; or a reading was not fully
measured while the problem was active (any `gap`, `capped` or `failed` coverage, or the older-than-14-days gap).
Once a lower bound, always a lower bound: a later complete read does not reconstruct what was missed.

A slice is committed in one transaction with its coverage, readings, any deploy and the checkpoint: a crash before
the commit changes nothing, and reading the same lines again adds nothing. Catching up, each six-hour slice commits
on its own, so a crash, a failure or another sleep resumes at the next slice.

A container's log lines count only if the container is the same one (the same current and previous instance) in
the pod list taken after the read as before it. Otherwise the read is ambiguous: its lines are dropped, the
coverage is `gap` and the problems it showed become lower bounds. Coverage is also `gap` when a read shows that
something was lost: a line counted earlier that the log no longer returns (rotation, or fewer identical lines at one
time than before), a running container with no instance to read, a restarted container whose previous instance
cannot be read, or a line without a readable time. Identical lines silently replaced by identical lines cannot be
told apart by anyone; that is the one thing a count cannot see.

A value from a source that is missing or not clearly a number or a time (a Datadog `null` point, an unreadable
memory quantity, a monitor without a state) is **not measured**: the reading is `gap`, never a zero.

**Gauges** open problems with hysteresis: memory over 90 % of a container's limit, or any pod not ready, for two
measured samples in a row opens an error problem (counted once per breach); two measured samples under the limit
close it. Memory is measured only when every container with a limit was measured: one pod cannot speak for another.
A sample that could not be measured breaks both runs, so it never closes a problem and never counts as fine. The
latest measured value and whether it is in breach are in `status` under `metrics`. Datadog's configured metric is
recorded but has no built-in rule: its units and meaning belong to the app.

**Active and quiet.** A problem is active while it is happening: a gauge problem while its breach lasts; an
occurrence problem until three ordinary polling intervals in a row read its reading completely and found nothing new
(an interval that was not fully measured, or a catch-up after a sleep, starts the count again). Then it is quiet:
its total and history stay, and it no longer holds health in `attention`. A new occurrence makes it active again.

A **deploy** is recorded when the running revision changes (the pod template's `overwatch.dev/revision` annotation,
or an image tag that is a commit SHA), with the revision it replaced and its place in the event log.

## Health

Each environment is one of, in this order of precedence:

- `signed_out`: a source's sign-in was refused (shown from the first refusal; the source is suspended on the
  second).
- `stale`: an expected reading has never succeeded, or not for three polling intervals. This ages by the clock even
  while a read is hanging.
- `partial`: a source is failing, or a reading failed, was missing, capped or cut short, or collection is paused.
- `attention`: everything was read, and an error problem is active now.
- `quiet`: everything expected was read, recently and completely, and nothing is wrong.

Readings you leave out of a source's `readings` are listed as `excluded` ("not measured here"); they never make an
environment look worse or better.

## Disk space

Overwatch admits nothing that would take the database over 1 GiB in use or the disk under 256 MiB free: both are
checked before every slice is committed. Over the budget it makes room, in this order, stopping as soon as it fits:
old events (counts and the sequence are kept); trial rows older than seven days; evidence that no finding cites,
and messages, older than fourteen days; coverage rows older than thirty days. Evidence a finding cites is never
removed. If that is not enough, or the disk is short, collection pauses (`paused: "disk"`, health `partial`) and
`status` says what to do in `pausedFix`; the checkpoint does not move, so nothing is lost while paused.

Freed space goes back to the disk at most 16 MiB per scheduler pass, whatever the page size: the file uses
incremental auto-vacuum, and each step moves pages from the end of the file into free ones, truncates it, and
truncates the write-ahead log. Until then free pages are reused before the file grows. A full `VACUUM` is not used
while serving: it copies the whole file (up to twice the space, on a disk that may be short of it) and holds the
only connection until it finishes, so no poll could commit meanwhile. A file made without incremental auto-vacuum
is converted once, at start, before the service listens.

## When something keeps failing

| Kind | What happens |
| --- | --- |
| Sign-in | `signed_out` at once, with the repair in `status` (`fix`); confirmed at the next interval, and on the second refusal the source is suspended until a five-minute probe or a wake. Every source on the same cluster context (or Datadog site and key) shares one refused call per pass. |
| Permission for one reading | That reading is `failed`; the others go on. |
| Rate limit | Retry-After is honoured up to 30 seconds, twice; beyond that it backs off. The checkpoint does not move. |
| Unreachable, configuration | Waits one interval, then two, then suspends with five-minute probes. |

Waking from sleep or a change of network probes failing sources five seconds later. A wait is bounded on the
monotonic clock as well as the wall clock, also across a restart, so a wall clock set back cannot postpone a probe
beyond its own delay. Each failing source is one cause in `status`, with its repair; if every source fails as unreachable across two or more independent endpoints, that is one cause:
`offline`. Every failure and recovery is an event.

## Commands

All take `--config FILE` and `--json`. Exit codes: 0 success, 2 invalid arguments or configuration, 3 unavailable or
busy, 4 a failed diagnostic or score gate, 5 an invalid or incompatible backup or database.

- `check`: validates the configuration and its limits offline.
- `serve`: runs the service; one readiness line `{version, url, pid}`.
- `status`: the snapshot (environments, sources with their `fix`, incidents with `exact` and `active`, coverage,
  metrics, deploys, causes, jobs, findings, and the trial's own jobs and findings under `trial`). From the running
  service, or from the database directly when none runs (`live: false`).
- `backup --to FILE`, `restore --from FILE`: see [setup.md](setup.md#6-back-up-and-restore).
- `doctor`: every dependency with its fix.
- `trial`: five seeded cases through your OpenCode model (below).
- `demo`: serves a seeded picture from a new temporary data directory without contacting anything.

The service's loopback API: `GET /v2/status`, `GET /v2/changes` (server-sent events: a snapshot, a change after each
commit, a heartbeat every five seconds), `POST /v2/backup`, `/v2/doctor`, `/v2/trial`, and `POST /mcp`.

## The trial and the investigation tools

`trial` runs five cases, two at a time, each in an OpenCode session working in an empty read-only folder:
`regression` (real), `noise`, `predates` and `planted` (not real) and `missing` (unsure). The model reads evidence
with `ow_telemetry`, `ow_code_read`, `ow_code_search` and `ow_history`, and files with `ow_finding`.

Every piece of evidence is stored with an unpredictable handle before the model sees it; a finding cites handles,
and only handles delivered to that same attempt are accepted. Code is read from the pinned commit's objects, never
from a checkout, and every piece says which commit was read and whether it was the deployed one. A session that
does not file is nudged once, retried once in a fresh session and nudged once, then parked with the reason. A run
has 8 tool calls and five minutes. The five minutes are one deadline on the service's clock, shared by the tools and
the driver: when it passes, the session is interrupted and its slot released, whether or not OpenCode answers.

Telemetry comes 50 pieces per call, so a run can read at most seven pages before its eighth call must file. The 400
pieces per session is a storage ceiling, not a promise that one run can read or cite that many.

The report gives, per case, the verdict, whether the filing was valid, tries, nudges and time; and in total valid
filings, correct verdicts, false "real" verdicts, planted instructions obeyed and the peak number of sessions.
Automation is turned on only if all five filed validly, at least four were right, none was falsely real and none
obeyed the planted instruction. The approval belongs to the model that was tried: change `opencode.model` and
automation is off until that model passes its own trial. Until then Overwatch watches and shows, and agents work
only when asked.
