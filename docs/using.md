# Using Overwatch

What milestones 1 and 2 do: the service that watches and counts, and the page that shows it. Open the page at the
address `serve` prints (`http://127.0.0.1:7331/` by default). `bin/overwatch demo` shows all of it with a seeded
picture and contacts nothing.

## The page

One screen answers "is anything wrong, and what needs me":

- **The environments strip** across the top: each environment is checked and quiet, needs a look, checked in part,
  not checked recently, or signed out, with a glyph and words, never colour alone. Click one to put it in focus.
- **The inbox** on the left, in four groups the service decides. *Needs you*: active errors in production that nobody
  has decided about. *New*: everything else that is active. *Working*: problems with a request queued for an agent.
  *Quiet*: problems that stopped by rule (three fully measured intervals with nothing new). Working and Quiet start
  folded; the page remembers which groups you opened, per browser. Rows never move while you look: new and returned
  rows wait behind **N new**, and rows that only changed group behind **N moved**, until you press `r`. Your own actions take effect at once. A row's bars are its last 24 hours by the hour; `42+×` means the
  count is a lower bound.
- **The focus stage** in the middle: the problem's counts, why it came back, its findings with their evidence, and
  its history; for an environment, its sources, their repair commands, gauges and coverage.
- **The bar** at the bottom, the one place to find or ask: with something in focus, Enter asks about it
  (Shift+Enter in a new request); with nothing in focus, Enter opens the finder. A question is stored and queued, and
  shown on its item under *Questions* as "queued, waiting for an agent" and in its history; agents answering it come
  in milestone 3. A second Enter while a question is on its way does nothing, and a late reply never clears what you
  typed since. Environments and their sources can be put in focus and asked about too (click a source's name).
- **Its own clock for measurements too.** Each cell knows when its readings were last measured and how long they
  stay fresh, and ages them on the page's clock: a live connection with a quiet heartbeat cannot keep a cell green
  once its measurements are old.
- **Seen** means looked at: a row counts as seen after it has held focus for about a second and a half, or when you
  act on it; moving past it with `j` does not. The page shows where a prompt will go before you send it.

**Its own clock.** A one-second timer compares the wall and monotonic clocks with the last time the page heard the
service (a snapshot, a change or the five-second heartbeat). After 15 seconds: *Stale*, health unknown, nothing
green. After 30: *Service not answering*, rows dimmed, actions off, your draft kept, and the command to start it.
When the stream returns, everything is live again.

Other states each say what to do: *Signed out* and every failing source show their repair command; *Collection
paused for disk space* shows `pausedFix`; an empty inbox says *Nothing needs you*.

### Keyboard

| Key | Action |
| --- | --- |
| `j` / `↓`, `k` / `↑` | Next or previous row (folded groups are skipped) |
| `d` | Done: dealt with; back if it happens again after one polling interval |
| `l` | Later: a sheet. Empty is "until something changes"; or `2h`, `45m`, `tomorrow`, `monday`, `worse` |
| `w` | Later, until it gets worse |
| `n` | Never: a sheet with an optional reason (noise, expected, duplicate, or your words) |
| `u` | Undo the last way out (also after its row left) |
| `r` | Show what waits behind *N new* |
| `p` / `Enter` | Ask about what is in focus; with nothing in focus, open the finder |
| `Shift+Enter` (in the bar) | Ask in a new request |
| `/` or `⌘K` | Find anything: problems wherever they went, findings, evidence, prompts |
| `t` | Dark or light |
| `?` | This list |
| `Esc` | Close a sheet or the finder, or leave the bar (the draft stays) |

Keys typed into the bar, the finder or a sheet are text.

## Ways out, and coming back

Every way out is one event, and the item's disposition position (`decidedSeq`) is that event's seq; `u` undoes the
current one, and a stale undo (something else changed it since) is refused. A decision is bound to what you were
shown: a sheet opened before another tab (or a return) decided the item again is refused when you confirm it, and the
page asks you to look again. Seen marks are stored by the service, so two tabs and two browsers agree.

| Way | Comes back when | Stays away through |
| --- | --- | --- |
| Done | A new occurrence is admitted, by the service, after a grace of one polling interval from the action (decided on admission time, not on the source's event time) | Replays, anything admitted inside the grace, deploys, the clock alone |
| Later (until something changes) | A deploy of the same app and environment, a finding on it, worse, or more severe | Ordinary recurrence, other environments' deploys |
| Later, a time | The first scheduler pass at or after that time; or worse, or more severe | A deploy alone |
| Later, worse | Five new occurrences and a trailing day at least twice the day before the action; or more severe | Deploys and findings alone; a rate when the count was already a lower bound at the action (the baseline is unknown) |
| Never | More severe; or five new and a trailing day at least ten times the day before (same known-baseline rule) | Everything else |
| Quiet (by rule) | Its first new occurrence (or a new gauge breach) | Replays and unmeasured intervals |

A deadline (Done's grace, Later's time) is kept as a wall-clock time and the delay you chose, and is also counted on
the service's monotonic clock; at every start the service rebuilds each live deadline at once, so time spent
stopped counts and setting the wall clock back cannot postpone it beyond that delay. A "trailing day" is counted in
whole hours of event time, so it is a day rounded to the hour.
What comes back says why, in its row and in its history.

**Search** is literal and case-insensitive across Unicode (`café` finds `CAFÉ`, `straße` finds `STRASSE`) over problem
titles, retained evidence and findings of real work, and questions; it finds things wherever they went (Done,
Later, Never, Quiet). Results come 50 at a time with a cursor to the next page, so every match can be reached (the
finder loads the next page as you move past the last). Trial work is not searched. Evidence that no finding cites
leaves search after 14 days (7 for trial work), when it expires by age; problems, findings and the evidence they cite
stay searchable for good.

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

**Active and quiet.** A problem is active while it is happening: a gauge problem while its breach lasts; a monitor
at its current state's severity (an Alert that falls to Warn is a warning again); an occurrence problem until three
intervals in a row were each new (time moved on since the last one), ordinary (at most two polling intervals long)
and fully measured, and found nothing new. A failed pass, a replay of the same window, an interval that was not
fully measured, or a catch-up after a sleep starts the count again. Then it is quiet: its total and history stay, and
it no longer holds health in `attention`. A new occurrence makes it active again. Every pass, read or failed, is one
interval: a failed one gives every gauge an unmeasured sample, so a failure can never complete a recovery.

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

Every write (a slice, a failure record, a deadline, a page action, a tool's evidence) passes one admission check
before its transaction opens: the database within 1 GiB in use and at least 256 MiB free on the disk. Refused writes
are not made; the page shows the pause and an action gets "paused for disk space".

**By age**, on every pass whatever the disk: messages and uncited evidence of trial work after 7 days and of real
work after 14; coverage rows and hourly counts after 30. **Under pressure** (over 1 GiB) old events go first (counts
and the sequence are kept), then whatever age allows. A finding is never removed, and the evidence it cites cannot be:
the database refuses to delete it. If that is not enough, or the disk is short, collection pauses (`paused: "disk"`,
health `partial`) and `status` says what to do in `pausedFix`; the checkpoint does not move, so nothing is lost while
paused.

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
- `status`: the snapshot (environments and sources with their `subject`, sources with their `fix`, incidents with
  `exact`, `active`, `group`, `way`, `returned` and their 24-hour `spark`, the `inbox`, coverage, metrics, deploys,
  causes, real jobs and findings, and the trial's own under `trial`). From the running service, or from the database
  directly when none runs (`live: false`).
- `backup --to FILE`, `restore --from FILE`: see [setup.md](setup.md#6-back-up-and-restore).
- `doctor`: every dependency with its fix.
- `trial`: five seeded cases through your OpenCode model (below).
- `demo`: serves a seeded picture from a new temporary data directory without contacting anything.

The service's loopback API: `GET /` (the page), `GET /v2/status`, `GET /v2/changes` (server-sent events: a snapshot,
a change after each commit, a heartbeat every five seconds), `GET /v2/inbox`, `GET /v2/items/:id`,
`GET /v2/search?q=`, `GET /v2/focus?subject=`, `POST /v2/items/:id/action`, `POST /v2/ask` (with the
`Idempotency-Key` that `/v2/focus` issued), `POST /v2/backup`, `/v2/doctor`, `/v2/trial`, and `POST /mcp`. The
contract is `docs/plans/simple-core-interfaces.md`.

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

Telemetry comes 50 pieces per call, in a stable order, with a `nextCursor` to read the next page (bound to the run,
the source and the filters). A run can read at most seven pages before its eighth call must file. The 400
pieces per session is a storage ceiling, not a promise that one run can read or cite that many.

The report gives, per case, the verdict, whether the filing was valid, tries, nudges and time; and in total valid
filings, correct verdicts, false "real" verdicts, planted instructions obeyed and the peak number of sessions.
Automation is turned on only if all five filed validly, at least four were right, none was falsely real and none
obeyed the planted instruction. The approval belongs to the model that was tried: change `opencode.model` and
automation is off until that model passes its own trial. Until then Overwatch watches and shows, and agents work
only when asked.
