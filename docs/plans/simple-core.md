# Overwatch 2: the simple core

Status: specification, 2026-11-25. This replaces the design on the `command-center` branch. It is the outcome of a
council of five independent reviews (`docs/plans/council/`), each given the same case file
(`docs/plans/redesign-brief.md`). All five said rewrite, and agreed on the shape below. Where they disagreed, the
decision and its reason are in section 12.

## 1. Why a rewrite, in one paragraph

Four gradings stalled at B minus because guarantees were promised without limits and enforced by checks that sat
at the seams between mechanisms: a domain library's storage beside plain tables, two clocks, views that lagged,
lock files, worktrees, and quotes matched by substring. Each fix held for the case tested and failed next to it.
This design removes the seams. Each guarantee is true because of how the data is shaped, inside limits that are
written down, and nothing has been proven yet on the owner's laptop or the owner's model, so that comes first.

## 2. Principles

1. **One process, one file.** One Node process owns one SQLite file. Every change is one synchronous transaction.
2. **Nothing to install.** No runtime dependencies, no native modules, no build step. `git clone`, then run.
3. **True by construction.** A guarantee comes from a key, a constraint or a type, not from a check that can be
   forgotten or bypassed.
4. **Limits are declared.** Inside them, behaviour is exact. Beyond them, it says so and carries on. It never
   counts wrongly in silence, never shows healthy when it does not know, and never loses its place.
5. **Code decides; the model interprets.** The model is never trusted with counts, order, identity, quotes,
   commands or confidence.
6. **Reality before features.** The laptop and the model are tested before anything is built on assumptions
   about them.
7. **Small.** A budget of about 5,000 lines for the service including the collectors kept from before, and
   about 1,200 lines of page script. Exceeding it needs a reason written here.

## 3. The product (what an A is made of)

One screen, five things to learn (unchanged from the last plan): the inbox, three ways out, one bar that finds
or asks, the environments strip, and briefs.

In the A-grade product, and nothing else:

- **Watching.** Kubernetes (logs, events, pod and workload state, usage against limits) through read-only
  `kubectl`; Datadog logs, monitors and metrics; deploys and commits from the cluster and `git`.
- **The environments strip.** Each environment is one of: checked and quiet, needs a look, checked in part,
  not checked since, signed out. Quiet is shown only when every expected reading is fresh.
- **The inbox.** Groups Needs you, New, Working, Quiet. Rows stay put. `d` Done, `l` Later, `n` Never, `u` undo.
  Everything that comes back says why.
- **Investigation by the owner's model.** Several independent readings of the same evidence, a challenger for
  any "real", and a result decided by code and shown as agreement, never as confidence.
- **One bar.** Put anything in focus and ask, or search. `o` opens the same thing in an OpenCode session that has
  the Overwatch tools.
- **Briefs.** `b` gives what changed, for the owner, and in plain words for people outside engineering.
- **"Was this right?"** A correction is one dated line in a playbook file per app, used by later investigations.
- **Before it happens.** Time left before a limit is reached at the current rate; and what is in staging but not
  yet in production, checked there first.
- **Narrow automatic fixes.** A draft pull request that reverts a deploy that regressed, or restores a setting,
  after the app's verify commands pass. Off until the trial says the model has earned it.
- **Tools for a real laptop.** `doctor`, `trial`, `install`, `status`, `backup`, `restore`, `demo`.

Postponed until the above is an A: spans and deeper analysis, insights, Jenkins, prompting on a selection, an
`ask_owner` tool for any session, grouping one cause across environments into one row. Declined: a general rule
editor, interviews, the system proposing changes to itself.

## 4. Storage

One file, `overwatch.db`, in the data directory. `node:sqlite`, WAL, `synchronous=FULL`, foreign keys on, an
`application_id` and a `user_version`.

**One writer, by the database itself.** At start the process sets `locking_mode=EXCLUSIVE` and takes the write
lock before it listens on any port. The operating system holds that lock until the process ends, however it ends.
A second process, of any version, cannot open the file and exits saying who holds it. There are no lock files.
While the service runs, the command line talks to it over loopback; when it does not, the command line opens the
file itself.

**One way to change anything.** A single function runs a change as one `BEGIN IMMEDIATE` transaction. Node is
single threaded and the SQLite calls are synchronous, so two changes cannot interleave. Every transaction that
changes state also appends to `events`.

**One clock for decisions.** `events.seq` (an autoincrement integer) is the only thing that decides "before" and
"after". Wall-clock time is used for display and for deadlines in the outside world ("until Monday 09:00"), and a
monotonic clock for timeouts and back-off.

**Text is clean or it is not stored.** The writer accepts numbers, identifiers Overwatch generated, and a
`Clean` string type that only the redaction function can produce. Text from outside (a log line, a prompt, an
agent's words, an error message, a file name) cannot be written without passing through it, and the compiler
enforces that. Identifiers supplied from outside are hashed, never stored as given.

**History.** `events` is append-only: `seq, at_ms, kind, subject, actor, data`. Triggers refuse updates and
deletes. The other tables hold current state and are changed in the same transaction as the event that explains
the change. This is the whole of the event sourcing: a log that is always consistent with the state, with no
replay, no projections and no lag.

Tables (the builder may adjust columns; the meanings are fixed):

| Table | Holds |
| --- | --- |
| `events` | The append-only log |
| `incidents` | One row per problem per app and environment: fingerprint, title, severity, counts, whether the count is exact, the way out it is in and the `seq` at which it was put there, why it came back |
| `occurrences` | The key of each occurrence already counted, kept only for the overlap window |
| `sources` | Per watcher and source: checkpoint, last success, failure kind, streak, next attempt, suspended since, the fix command |
| `coverage` | What was read and what was not: ok, capped, gap, failed |
| `metrics` | Readings with their limits, for hysteresis, the strip and "time left" |
| `deploys` | Each observed rollout with its `seq`, revision and the one it replaced |
| `jobs`, `runs` | Agent work and each session serving it, with identifiers chosen before anything is sent |
| `evidence` | Everything shown to a session, in numbered pieces |
| `findings` | What was concluded, as claims that point at evidence |
| `mutes`, `owner`, `outbox`, `search` | What is muted; what the owner has seen; notifications to deliver; the search index |

## 5. Collection

**Counting cannot be wrong inside the limits.** Each occurrence has a key made only from the source's own data:
for a log line, the pod, container, the line's full timestamp, an ordinal among lines sharing that timestamp, and
a hash of the line; for a Datadog log, its ID; for an event, its UID and count. In one transaction the collector
inserts the keys with "ignore if present", adds the number actually inserted to the incident's count, records
coverage, moves the checkpoint and drops keys older than the overlap window. Replaying the same lines adds zero.
A crash before the commit changes nothing; a crash after it has already moved the checkpoint.

**Streaming.** Output from `kubectl` is read line by line. No source builds a list of everything it read. An
unterminated last line from a killed or capped command is dropped.

**Storms.** Past the limit for one source in one slice (section 10) the count is marked not exact and shown as
"50,000+", coverage records "capped", and the checkpoint still moves. A watcher never wedges.

**Failures** keep the classification already built: sign-in, permission for one read, rate limit, unreachable,
configuration. Sign-in stops after one confirming attempt; one cheap canary call per cluster goes first so an
expired sign-in is one failure, not one per pod. Others back off, then suspend, with a slow probe. Waking from
sleep or a change of network waits a few seconds, then probes. Everything unreachable at once is one cause.

**Health is the least-known reading.** An environment's state is the worst of its sources. A check the cluster
does not support (no metrics API, for example) is switched off per environment in configuration and shown as
"not measured here", so "checked in part" is distinct from stale and the strip can still go green honestly.

**A deploy** is recorded with its `seq`. In the same transaction, incidents in that environment that are waiting
for a change and were put there before that `seq` come back. There is no other bookkeeping.

## 6. Agents

Every agent is an OpenCode session on the owner's model. Its working directory is one empty read-only folder,
and the built-in file and shell tools are denied. It can touch nothing except Overwatch's tools.

**Evidence by handle.** Every piece of telemetry, code or history a session sees is cut into numbered pieces by
the service and stored before the model sees it: `[E7 | pods] 10:05:02 payments timeout after 300ms`. A finding
cites numbers. The model never supplies a quote or a source name; the page and the report copy the text from
the stored piece. The owner's question, the brief's instructions, earlier conclusions and a tool's arguments
get no number and so cannot be cited. An unknown number is refused with the list of valid ones.

**Code from the commit.** Code is read with `git` straight from the object store at the deployed commit
(`git show <sha>:<path>`, `git grep <sha>`). There is no worktree for reading. An untracked file, a dirty
checkout or a half-made directory cannot exist inside a commit. If the deployed commit is not in the checkout
and cannot be fetched, the brief and every finding say which commit was read instead, or that none was.

**Tools**, few and flat. For an investigation: `ow_telemetry {source, since?, until?, query?}`,
`ow_code_search {pattern, path?}`, `ow_code_read {path, from, to}`, `ow_history {path?, ref?}`,
`ow_finding {verdict, cause, claims: [{statement, evidence: [ids]}], ruled_out, not_checked, next_check, impact,
affected, since, status}`, and for the challenger `ow_challenge {outcome, reason, evidence}`. For the owner's own
sessions: `ow_inbox {}`, `ow_get {id}`, `ow_search {text}`, `ow_act {id, action, until?, reason?}`. A call is
tied to its run by the session ID OpenCode attaches to every tool call; nothing is copied through the prompt.

**Using tokens that are free.** A weak model with no token limit is made reliable by asking several times and
letting code compare. Each new incident gets `readings` independent investigations (default three), each told
to start from a different place (the telemetry, the change, a harmless explanation). If most say "real", a
challenger session is given only the evidence and the claim and told to disprove it. Code decides:

| Readings | Challenger | Recorded as |
| --- | --- | --- |
| Most say real | upheld | real, with the agreement shown ("3 of 3, challenger upheld") |
| Most say real | disproved, with evidence | not real, with the disproof shown |
| Most say not real | not run | not real |
| Anything else | | unsure, with each reading shown; under Needs you if it is production |

"Observed" is set by code: real, upheld, and at least one cited piece that is telemetry. The model's own
confidence is never asked for or shown.

**Limits on a run** are in section 10. A run that will not file is nudged once, retried once in a fresh session,
then parked with its reason. OpenCode being away pauses the queue behind one inbox item.

**Without a plugin.** OpenCode loads an MCP server, agent definitions and skills from its own configuration.
`overwatch install` writes those entries and files, showing the change first and keeping a copy of what was
there. The service finds OpenCode through the registration file OpenCode writes, and talks to it with `fetch`.

**The trial.** `overwatch trial` replays seeded incidents with known answers through the real model: real
faults, harmless noise, errors that predate a deploy, missing code, and instructions planted in log lines. It
reports valid filings, verdict accuracy, false "real", injected instructions obeyed, tries and time, and how the
endpoint behaves with several sessions at once. Automatic investigation is on only above stated scores;
automatic pull requests only with a perfect verify record. Below them Overwatch still watches, shows and
searches, and agents work only when asked.

## 7. The page

Plain ES modules and one stylesheet, served by the service. No bundler and no framework to install; one small
rendering library may be vendored into the repository as a single file. The look, the logo and the keyboard map
from the design pass are kept.

- The server computes everything the page shows: groups, health, why something is back, where a prompt will go.
  The page renders and sends commands. It decides nothing and generates no identifiers.
- One stream from the server carries changes and a heartbeat every five seconds.
- **Staleness has its own clock.** A one-second timer in the page, independent of any request, compares both a
  monotonic and a wall clock with the last heartbeat. After 15 seconds: "Stale, last heard 18s ago, health
  unknown", and nothing is green. After 30: "Service not answering", the command that restarts it, rows dimmed,
  actions off, drafts kept.
- What the owner has seen is stored by the service, so two tabs and two browsers agree.

## 8. Commands

`overwatch serve | status | check | doctor | trial | install | uninstall | backup | restore | demo`.

- `doctor` checks, one by one and with the fix for each: Node; the data directory; each cluster context signed
  in (one call each); Datadog keys; `git` and `gh`; each checkout and whether the deployed commit is in it;
  OpenCode found and answering; the model answering one turn; the agents and MCP entry installed; the launchd
  agent and the paths and proxy settings it will run with.
- `install` sets up the launchd agent with absolute paths for every tool it found and the environment it needs,
  and the OpenCode entries. Upgrading is `git pull` then `overwatch restart`; the old process is stopped first,
  and a newer database is refused by an older program.
- `backup` writes one SQLite file. `restore` never moves a foreign file into place: it creates a fresh database
  from the current schema, copies rows from the backup through the same writer as everything else, and renames
  the result in. A backup from an older version is migrated in a temporary copy first. Work that was in flight
  is reconciled against OpenCode and GitHub before anything is sent again.

## 9. What is deleted, and what is kept

Deleted: `@alchemy.run/domain`, `alchemy`, `effect`, `foldkit`, the bundler, `@opencode/client`, the OpenCode
plugin, the custom host, aggregates, views and policies, lock files, receipts and outboxes per feature, worktrees
for reading code, quote matching, run tokens in prompts, the model's confidence, caps hidden in code.

Kept, adapted: the Kubernetes and Datadog parsers and the read-only `kubectl` allowlist; redaction by name and by
entropy; tolerant parsing; hysteresis; the deploy context; failure classification and back-off; the three ways
out and their meanings; the inbox grouping rule; the design language, the logo and the demo; the documentation
structure. The assessor's properties are rewritten against the new interfaces.

## 10. Operating limits

Inside these, behaviour is exact. `check` refuses a configuration beyond the first group.

| Limit | Value | Beyond it |
| --- | --- | --- |
| Watchers; sources per watcher; polling interval | 50; 4; at least 60 s (default 10 min, 2 min for production) | `check` refuses |
| Occurrences per source per slice | 50,000 | Count marked "50,000+", coverage "capped", checkpoint moves |
| Distinct problems per source per slice | 500 | The rest fold into one "many other errors" incident |
| Log output per pod per call; pods per source | 4 MiB; 20 | Coverage "capped" |
| Overlap for late data | 2 min Kubernetes, 5 min Datadog | Later data is not counted; the number missed is recorded |
| Catch-up after sleep | 14 days, in 6-hour slices | Older is a recorded gap; investigations on waking are capped and the rest held |
| Datadog rate limit | waits as told up to 30 s, twice | Backs off; checkpoint does not move |
| Agent work | 3 readings; 2 jobs at once; 8 tool calls and 5 minutes per run | One retry, then parked with the reason |
| Evidence | 16 KB per piece; 400 pieces per session | Truncated with a marker |
| Staleness | 15 s stale, 30 s down | As section 7 |
| Disk | database 1 GiB; 256 MiB free | Old events are compacted; below the floor, collection pauses and says so |
| One service per data directory; one installed version | | A second refuses to start |

## 11. How it is built, and what an A means

**Order.** Each milestone is small and is accepted before the next starts.

1. **Kernel and reality tools.** Storage, the writer, counting, order, coverage and health, failure handling,
   collection from Kubernetes and Datadog, deploys, `serve`, `status`, `check`, `backup`, `restore`, `doctor`,
   and `trial` with the investigation tools. No page.
2. **The page.** Strip, inbox, ways out, search, focus and the bar, staleness.
3. **Agents in full.** Readings and the challenger, the owner's tools and skill, open in OpenCode, playbook
   corrections, briefs, notifications.
4. **Acting and looking ahead.** Narrow draft pull requests, time left before a limit, the staging check.

**Method.** Before a milestone is built, the independent assessor writes its acceptance tests against this
document: black-box, through the command line, the loopback API, the MCP endpoint and the event log, inside the
limits in section 10, plus tests that going beyond a limit fails in the declared way. The builder makes them pass
without changing them. The assessor then grades against the rubric below, not against conditions outside the
limits. If two gradings in a row do not improve, the work stops.

**The rubric.**

- **Correct inside the limits.** Property tests and kill tests show: no occurrence lost or counted twice up to
  the storm limit, across replay, crash, late data and restart; order by `seq` with clocks held still; one writer
  across versions; restore equals backup and starts nothing twice; no text stored that did not pass redaction;
  nothing green over anything stale, failed, suspended or unmeasured, including with a request left hanging.
- **Honest beyond them.** Each limit in section 10 produces its declared behaviour.
- **Real.** On the owner's laptop: `doctor` passes behind the proxy and under launchd; two days running through
  sleep and network changes with no stuck watcher and no false green.
- **The model.** `trial` on the owner's model meets the stated scores, or automation stays off and the product
  is graded as a watcher with agents on request.
- **Useful.** The owner can clear the inbox from the keyboard, find any past incident in seconds, ask about
  anything in focus, and copy a brief.
- **Simple.** Inside the size budget; no runtime dependency; a fork installs it in ten minutes from the guide.

The third and fourth can only be run by the owner. Everything is built so that running them is one command each.

## 12. Where the council disagreed

| Question | Decision | Why |
| --- | --- | --- |
| Automatic pull requests: cut, or keep narrow | Keep narrow, in milestone 4, off until the trial unlocks it | The owner asked for it by name; three seats cut it only because the model is unproven |
| Reading code: a verified worktree, or git objects | Git objects, no worktree | It removes a class of defects instead of checking for them |
| Restore: do not build it, validate the schema exactly, or rebuild from rows | Rebuild from rows into a fresh database | Safe by construction and small; a restore that can destroy data is worse than none |
| The OpenCode side: a thin plugin, or configuration only | Configuration only | OpenCode loads MCP servers, agents and skills itself; one less API to track |
| The OpenCode client: the package, or `fetch` | `fetch`, with the versions tested named and checked by `doctor` | Nothing to install; the risk of routes changing is contained in one small file |
| How many readings: three and a challenger, or one and a sceptic | Three and a challenger by default, set by configuration, with the trial measuring whether the endpoint copes | Free tokens are the owner's advantage; the design is the same at any number |
| Event sourcing: keep it, or drop it | A log in the same transaction as the state | The history, audit and timeline are wanted; replay and projections are what caused the trouble |
| Deeper analysis, spans, insights | Postponed, not cut | The owner wants them; they come after the core is an A |
| Catch-up after sleep: 72 hours or 14 days | 14 days | An earlier decision by the owner |
