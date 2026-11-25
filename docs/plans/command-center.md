# Overwatch command center: plan

Status: fifth revision, 2026-11-25. Phase 1A is built on the `command-center` branch, the page has had its design
pass (`docs/design.md`), and a second-pass review's defects have been fixed with regression tests
(`test/regressions.test.ts`). `pnpm run check` and the end-to-end script are the measure of what passes. Section 11
lists what the second plan review changed.

This revision replaces the design that hosted everything inside OpenCode. That design was reviewed by two
independent models; what they found, and why it led here, is in the appendix.

## 1. The core facts

From the owner, and treated as fixed:

1. Tokens are unlimited, through the inference provider behind OpenCode.
2. There are several environments to stay current on.
3. Logs, Datadog and commits are monitored regularly, without being asked.
4. Issues are triaged as they arrive. OpenCode raises draft pull requests for easy fixes. The owner is brought in
   only when needed, and then works in an OpenCode session that knows the Overwatch system and how to act on it.
5. Overwatch regularly looks deeper than logs: spans, regressions, and ideas to improve the project.
6. The owner is never trapped in long lists or shown the same incident or insight again and again. Anything can be
   archived or classified so it leaves the list for good.
7. The whole system is easy to search.
8. The data model is clean, built on Alchemy Domain, with Effect giving type safety from the event store to the
   browser.
9. It is event sourced.
10. Anything on screen can be prompted on: put a thing in focus, type, and an agent works with that thing as its
    subject. Overwatch decides sensibly whether that continues an existing session or starts a new one.

11. It gets better with use. It learns from how the owner works with it, adapts and can be customised, and "the
    arrow always points in the direction of improvement". Nobody expects the first version to be right.
12. Other people will fork it. This version sets the architecture, the guides and the foundation a fork can
    configure for itself.

The goal is the most robust system that can be built upon. No earlier choice (plugin, GUI, no daemon) is binding.

This is a new project. Nothing has to stay compatible with today's plugin: its configuration format, stored
state, commands and code layout can all change, and there is no migration. Its collectors, hardening and tests are
reused where that is the fastest route to good code, not preserved for their own sake.

Still binding: read-only against environments, Kubernetes only through `kubectl get|describe|logs|top`, no spend
tracking, no Bun (blocked for the people who will use this), macOS, a laptop that sleeps, nothing
environment-specific in the repository, citations checked by code, draft pull requests only after verify passes.

## 2. The shape

Two programs, each doing what it is good at.

```text
  +--------------------- Overwatch service (Node, kept running by launchd) ---------------------+
  |  schedule: every 10 minutes per watcher, deeper analysis daily and weekly                    |
  |  collect:  kubernetes, datadog (logs, monitors, metrics, spans), git and github, jenkins     |
  |  domain:   event store (SQLite) -> incidents, insights, changes, asks, runs, connections     |
  |  read:     inbox, fleet, timelines, search                                                   |
  |  serve:    typed API, MCP server and the web app, on loopback                                |
  |  work:     a queue of jobs for agents                                                        |
  +-----------------------------+----------------------------------------^----------------------+
                                | starts and follows sessions            | tools call back
  +-----------------------------v----------------------------------------+----------------------+
  |  OpenCode: sessions, agents, skills, permissions, models, worktrees                          |
  |  thin Overwatch plugin: agents, skill, commands; connects sessions to the service over MCP   |
  +----------------------------------------------------------------------------------------------+
```

- **The service owns time, state and the view.** It polls whether or not OpenCode is open, keeps every fact, and
  serves the page. Nothing can unload it; launchd restarts it if it dies and starts it at login.
- **OpenCode owns thinking and doing.** Every investigation, triage proposal, fix and analysis is an OpenCode
  session using the owner's models, skills and permissions. The owner works in those same sessions.
- **The plugin is thin.** It registers the agents and a skill that explains Overwatch, and connects OpenCode to
  the service's MCP server, which is where sessions get their Overwatch tools. It holds no state and schedules
  nothing.

Why not host it all in OpenCode: a plugin is unloaded after 60 idle minutes, has no server-lifetime scope, and its
storage has no transactions, so every robustness property had to be worked around (appendix). A single process
with a real database gets them for free, and event sourcing becomes sound.

What it costs: a background service to install as well as the plugin; launchd's bare environment (section 8); and
agent work waits when OpenCode is not running, although detection does not.

## 3. Event-sourced domain

### 3.1 Store

- One SQLite file, opened by the one service process, through Node's built-in `node:sqlite`. No native database
  module to compile, no Bun.
- Alchemy Domain owns how aggregates, views and policies are stored (3.3). Its layout is its own, so Overwatch
  also keeps a **journal**, a table it owns: `journal(position, stream, version, type, data, at, command_id)`,
  unique on `(stream, version)`. A row is written in the same transaction as the aggregate commit that produced
  the event, so `position` is the real commit order and never changes. Search, export, audit and replay tests
  read the journal. (A projection with a constant key was the first idea; it reorders across streams when
  rebuilt and copies every event a second time, so it is not used for this.)
- **Only things that happened are events.** A poll that finds nothing new writes no event. Checkpoints, coverage
  windows and metric series are operational state in plain tables. Fifty watchers polling every ten minutes
  would otherwise write 2.6 million events a year that say nothing.
- Events are immutable. Alchemy Domain has no upcasting: fields are only ever added as optional, and a change of
  meaning is a new event. Views and projections carry a version; bumping it rebuilds them. Every upgrade is
  tested against recorded old events and persisted aggregate snapshots.
- Alchemy never prunes its command receipts or its per-view and per-policy intake rows. The host compacts what
  is safe to drop, and disk growth and rebuild time are measured at a year's volume before phase 1 is called done.
- Raw telemetry is not event data. Events carry evidence pointers (query, window, link) and a bounded, redacted
  excerpt.
- Restore uses a consistent SQLite backup, which carries schedules, receipts and unfinished work with it. The
  journal also exports to JSON lines.

### 3.2 Model

Each aggregate is an Alchemy Domain class: a state schema, commands with their inputs, events and rejections, a
pure `decide` and a pure `evolve`. No I/O, no clock, no model call inside either.

| Aggregate | What it is |
| --- | --- |
| Catalog | Apps, environments and their tier, sources, repositories |
| Watcher | One source in one environment: checkpoint, coverage, last run |
| Incident | One problem in one app and environment, from first signal to verified recovery |
| Insight | Something worth knowing or improving that is not on fire |
| Change | A pull request, commit or recorded mitigation, and its delivery through build and release |
| Ask | One decision only the owner can make |
| Run | One unit of work: a collection, an agent job, an outward action |
| Connection | A system Overwatch reads: healthy, backing off or suspended; last success; refused reads; next attempt |
| Rule | A standing instruction: suppress this, auto-archive that, escalate the other |
| Thread | A line of work about one subject: the prompts asked, the sessions that served them, the outcome |

Policies react to events and issue commands: a new incident starts triage; an accepted easy fix starts a fixer; a
merged change starts delivery tracking; a release starts recovery verification. Timeouts and follow-ups are
scheduled commands. Both are deterministic and tested as stories, which replay every order in which concurrent
policies could run.

Every outside system (OpenCode, `kubectl`, Datadog, GitHub, Jenkins, git) is an Alchemy `ExternalSystem`: a typed
set of operations whose arguments, results and errors are schemas, with a real implementation and a test stub.

Outward effects (starting a session, opening a pull request) use an outbox: the intent is recorded as an event,
then performed, then its result recorded. After a crash, unfinished intents are reconciled, so nothing is done
twice and nothing is forgotten. Alchemy's sagas are not used at first: they need a durable workflow engine the
package does not ship for a single process, and policies, scheduled commands and the outbox cover what this plan
needs.

### 3.3 Alchemy Domain

The domain is built on Alchemy Domain (`@alchemy.run/domain`), pinned to an exact version. Checked against
2.0.0-beta.87 on Node 23.11, with no Bun:

| Fact | Evidence (inside the package unless a URL) |
| --- | --- |
| It installs with npm and its `lib/` imports cleanly under plain Node ESM. | import test of the main entry and `Story`, `InMemory`, `DurableObjects`, `Platform`, `Http`, `Ai`, `Cli` |
| A host is a Layer providing `Platform`. The practical route is `DurableObjects.makePlatform(host)`, which needs a key-value store with `get`, `put`, `delete`, `list`, `transaction`, an exclusive gate, and one alarm. | `src/Platform.ts`; `src/DurableObjects.ts` |
| A 104-line host on `node:sqlite` ran aggregates, a view, a policy, idempotent retries, persistence across restarts and a scheduled command firing after a restart. | prototype and three smoke scripts in `docs/plans/prototypes/alchemy-sqlite-host/` (a spike, not hardened) |
| Shipped hosts are Cloudflare, Rivet and Effect Cluster on Postgres. There is no single-process or SQLite host. The closest to adapt stores everything in one table. | `src/EffectCluster/index.ts` |
| `Domain.Api` gives a server handler and a typed client from the model: commands and queries as methods, views with `get`, `watch`, `events`, `list`. Protocols are HTTP with streamed live reads, WebSocket, and in-process. The client runs in a browser. | `src/Api.ts`; https://alchemy.run/domain/api |
| `toHttpApi` gives a plain Effect HTTP API with OpenAPI. `toMcp` gives an MCP server with one tool per exposed command, query and view read. | `src/Ai.ts`; https://alchemy.run/domain/mcp |
| `Story` runs given/when/then on an in-memory platform with a controlled clock, fails on anything unasserted, and replays each order of concurrent policy deliveries, up to 256. | `src/Story.ts` |
| There is no global event order across aggregates, and no upcasting. A projection with a constant key does receive every event in one ordered log, history first. | https://alchemy.run/domain/projection; `src/Event.ts` |
| Required peers at runtime are `effect` and `alchemy`. `alchemy` brings a native bundler binary; the install is about 108 MB. The other peers are optional. | `package.json` `peerDependenciesMeta` |
| It is five weeks old with six publishes, all betas. The host-facing interface changed by 143 lines between beta.84 and beta.87, and there is no documentation for writing a host. | `npm view` times; diff of `Platform.d.ts` |

What this means for the plan:

- The SQLite host is Overwatch's own code and its largest dependency risk. It is built first. Both reviewers
  broke the prototype, so its contract is explicit:
  - Every read and write on the one connection goes through one lock that knows which call owns the open
    transaction. In the prototype a second object's write could join another object's transaction and vanish
    when that one rolled back.
  - The per-object exclusive gate is separate from the connection lock.
  - An alarm is claimed, fired, then cleared, in that order, with the claim surviving a crash. The prototype
    cleared first and lost the alarm if the process died while firing.
  - Alarms are driven by a short wall-clock ticker, not one long timer: timers pause while a laptop sleeps.
    Overdue work is drained in bounded batches at start and on wake.
- `Story` always builds the in-memory host, so it cannot test the SQLite host. Conformance is a suite of
  command, receipt and view fixtures run through the in-process API client against both hosts, plus crash tests
  on SQLite alone (kill between any two writes, restart, compare).
- The version is pinned exactly and upgraded deliberately, one beta at a time, with the conformance suite as the
  gate.
- Aggregates are written as Alchemy classes. That is a real commitment: leaving Alchemy later means rewriting
  the model's wiring, though `decide` and `evolve` are plain functions and the journal holds every event.

### 3.4 Types from the store to the browser

One model, no hand-written copies of its shapes anywhere:

- **Domain**: commands, events, state and views are Effect schemas in the Alchemy model.
- **API**: `Domain.Api` derives the server and the typed client. The web app and the command line use that
  client; live views arrive by `watch`.
- **Agents' tools**: sessions reach Overwatch through one MCP server run by the service.
  - Reads and commands on the model come from `toMcp`, with an explicit allowlist of what is exposed.
  - Telemetry queries and filing a finding are hand-written MCP tools, because they must know which session is
    calling: evidence shown to a session is what its citations are checked against. OpenCode sends the session
    ID in the call's metadata, which `toMcp` discards. Each agent run also carries a token naming the run, its
    role and what it may touch; a call for another run, or outside the role, is refused.
- **Agents' answers**: findings, triage proposals and insights are decoded with schemas before anything is
  recorded. A reply that does not decode is sent back with the reason.
- **Outside systems**: every `kubectl`, Datadog, GitHub and Jenkins response is decoded with a tolerant schema at
  the `ExternalSystem` boundary. Configuration is decoded the same way.
- **Web app**: Foldkit, a front-end framework built on Effect that Alchemy Domain ships an integration for, so
  the page's state and messages are schemas too. It is confirmed in the first increment; the fallback is Solid
  with the same typed client.
- **Plugin**: no Effect and no domain client at run time. It registers the agents and the skill, registers the
  service's MCP server with OpenCode, and uses plain `fetch` for a health and version check. It imports the
  model's types only.

## 4. What runs, and when

| Cadence | Work | Who |
| --- | --- | --- |
| Every 10 minutes per watcher (configurable; more often during a rollout watch) | Logs, events, pods, monitors and metrics since the last check; new commits and pull requests; build results | Collectors, deterministic |
| On every new signal | Fingerprint, correlate, open or update an incident, apply rules | Domain, deterministic |
| On every new incident | Triage proposal, then investigation with verified citations | Agents |
| On an easy, verified fix | Draft pull request | Fixer, then service code after verify passes |
| On every merged change | Review the change for production risk against recent incidents | Agent |
| On every release | Before-and-after comparison of errors, latency and spans; follow linked incidents to verified recovery | Deterministic, then an agent for the explanation |
| Daily and weekly per app | Deeper analysis: slow and failing spans, regressions against a baseline, capacity trends, drift between environments, flaky pipelines; improvement ideas | Deterministic measurement first, then analyst agents |
| Each morning, and after sleep | Digest of what changed and what was handled | Agent |

Detection and decisions are code. Models interpret, explain and propose. A number in an insight comes from a
measurement the service made, not from an agent's reading of a chart.

New collection needed: Datadog spans (search and aggregates by service and resource), commits and pull requests
per repository, and Jenkins job results.

### 4.1 When something keeps failing

Overwatch does not hammer a thing that is broken, and it does not tell the owner about it more than once.

Every failure is classified by code, and the class decides what happens next:

| Kind | Examples | What Overwatch does |
| --- | --- | --- |
| Sign-in or permission for the whole connection | Expired cluster login, a rejected Datadog key, `gh` logged out | Stops at once, after one confirming attempt. Repeated bad sign-ins can lock an account. Raises one inbox item with the exact command that fixes it. Checks quietly at a slow pace and resumes by itself once sign-in works |
| Permission for one kind of read | The account may not list nodes | Turns off that one check, says so on the Connections page, keeps everything else |
| Rate limit | HTTP 429 | Waits as long as the response asks; if it keeps happening, polls that source less often |
| Unreachable | Timeouts, gateway errors, VPN down | Retries with a growing wait up to a ceiling, then suspends. When everything is unreachable at once it is treated as one cause (offline or off the VPN): one notice, not one per source |
| Wrong configuration | Unknown namespace, a query the API rejects | Suspends that watcher until its configuration changes. Raised once |
| Agent work | A session that errors or times out, a fix that fails verify, the inference provider down | One retry in a fresh session, then the job is parked with its reason. A provider outage pauses the whole agent queue behind one notice and resumes when a probe succeeds. A fix is attempted a fixed number of times, never in a loop |

Rules that hold for all of them:

- **Suspended is a state, recorded as events.** A connection is healthy, backing off or suspended, with the
  reason, the failure streak and the time of the next attempt on the Connections page. "Retry now" and "resume"
  are commands.
- **One item per cause.** A failure raises one inbox item, grouped by cause, updated quietly while it lasts and
  closed by itself on recovery. It follows the same archive, snooze and suppress rules as anything else. A cause
  still open after a day appears in the digest; it is not raised again.
- **Unknown, never green.** Anything read through a suspended connection shows as not checked, with since when.
  Its incidents neither resolve nor reopen, and nothing is "verified recovered" on data that was not read.
- **Recovery is automatic.** A slow, cheap probe (one call) continues while suspended; waking from sleep or a
  network change triggers one immediately. On success the watcher catches up from its checkpoint.
- **Limits are configuration**, with defaults: how many attempts, how long the wait grows, when to suspend.

## 5. Not being trapped in lists

### 5.1 One inbox, and everything leaves it

- The owner's home is an inbox of items that need a decision: an incident that needs a call, an ask, an insight
  worth a look, a pull request waiting. Not a log of everything that happened.
- Every item has the same exits: **act** (answer, approve, open in a session), **snooze** (until a time or until
  something changes), **archive** (done, do not show again), **suppress** (never raise this kind of thing, with a
  scope and an optional expiry), **delegate** (let an agent take it further).
- An item that has left the inbox comes back only for something materially new: a state change, a regression
  past a threshold, a snooze ending. More occurrences of the same thing update the item quietly.
- Everything else is reachable by search and by the digest.

### 5.2 The same thing is never shown twice

- **The inbox holds decisions, not records.** One outage can produce a monitor alert, pod errors in three
  environments, an investigation, an ask and a pull request. They are grouped under one decision, by shared
  release, fingerprint and cause, ranked by environment tier and impact. The owner sees one row.
- A decision remembers the last material change it showed and what the owner did with it. Opening a session on
  it does not answer it. Archive, snooze ending and recurrence are separate, defined transitions.
- Incidents are identified by fingerprint; a recurrence updates the existing incident or, after the reopen
  window, opens one that links back.
- Insights are identified by a claim key that code computes (subject, measure, baseline, scope) and code
  enforces, including when two analyses propose the same thing at once. A new insight on an existing key needs
  a material change past a threshold. The analyst is also shown earlier insights, including rejected ones with
  the owner's reason, but uniqueness never depends on a model noticing a rephrasing.
- A suppression can be overridden by severity: a rule that hides a nuisance does not hide it becoming an outage.
- After sleep, a burst of new work is capped and summarised, not started all at once.
- The digest obeys the same dispositions: something archived or suppressed does not come back there either.
- Suppressions and auto-archive choices are Rules: events like any other, visible, searchable, reversible, and
  applied by code before anything reaches the inbox. "This rule hid 14 things this week" is shown, so a rule that
  hides too much is noticed.
- Bulk actions: archive all like this; make it a rule.

### 5.3 Search

- One search over incidents, insights, timelines, evidence excerpts, reports, changes, commits and runs, and also
  archived decisions, Rules, Asks and Threads, with filters for app, environment, state, disposition and time,
  lookup by exact ID, and stable paging.
- A search projection in SQLite maintained from the event log. It uses SQLite's full-text index when the Node
  build has it and an index table of its own when it does not; the data is thousands of items, not millions.
- Available three ways: the web app (a command palette), the loopback API, and an OpenCode tool, so agents and
  the owner's own sessions search the same index.

### 5.4 Getting better over time

The event log already holds every decision the owner makes. What turns that into improvement is a loop, and every
step of it produces something explicit that the owner approves. The system never rewrites itself silently.

1. **Goals.** A short record, in the owner's words, of what matters for each app and environment. Everything else
   is measured against it.
2. **Measurement, by code, weekly.** How often triage proposals were right; how much of the inbox was archived
   unread; repeats that got through; routing choices the owner overrode; incidents the owner found that Overwatch
   missed; how often each rule fired.
3. **An interview.** A short OpenCode session that brings specific questions from those numbers ("you archived 9
   of 11 memory alerts in staging: stop raising them?"), never an open-ended survey. Answers become goals and rules.
4. **Change proposals.** Each is one concrete edit to a rule, a threshold, a prompt, a skill or a schedule, with
   its evidence and how its effect will be measured. Approved changes are events, so they are versioned and can
   be undone. The effect is measured afterwards, and a change that made things worse is flagged.
5. **Replay first.** A proposed rule or prompt is tried against past incidents from the journal before it is
   adopted ("would this have hidden October's outage?"). Replay reaches only the evidence that was stored.
6. **A playbook per app.** Lessons from resolved incidents, kept as a file the owner can read and edit, loaded by
   investigations.

Limits, stated up front: one person is a small amount of signal, so noise preferences are learned quickly and
subtler things slowly; and the system cannot easily know what it missed.

What this needs from earlier phases, and has: every owner action is an event that records who or what issued
it, and rules, thresholds and prompts are versioned data, not constants.

## 6. Prompting on anything, and sessions

### 6.1 Everything is addressable

Every thing the page can show has a typed reference: an incident, an insight, an environment, a pod, a metric
over a window, one timeline entry, one piece of evidence, a change, a commit, a connection, a search result set,
or a selection of several. Hover, select or open any of them and it is the focus.

One prompt bar, always available, takes what the owner types plus the focus. The same works from the keyboard on
any row, chart or tile. Examples: "why is memory climbing here", "compare this with last week", "is this the
same as the one in staging", "draft a fix", "archive everything like this and make it a rule".

### 6.2 A prompt becomes work

1. The service resolves the focus into a **context pack**, built by code and never by a model: the thing's state,
   its timeline, its evidence excerpts, the deploy context, related items, and the telemetry queries an agent
   can re-run. It is bounded, redacted and typed.
2. The prompt, its focus and its routing decision are recorded on a Thread.
3. An OpenCode session serves it, with the context pack as its brief and the Overwatch tools available. The
   answer streams into the page beside the thing in focus; the session is a real one the owner can open and
   continue in OpenCode.
4. Anything the agent does to Overwatch (classify, archive, link, propose, create a rule) is a command, recorded
   with the thread it came from. Anything outward is proposed for approval.

**The event log is the memory; sessions are workers.** A session never has to be kept alive to remember
something, because a context pack rebuilds what it needs from the log. That is what makes starting a new session
cheap and safe.

### 6.3 Same session or a new one

Decided by a pure function of things code can see: the focus, the mode the owner picked in the prompt bar (ask,
investigate, fix, analyse), and the state of the threads and sessions that exist. It never guesses intent from
the wording. The page shows the decision before sending ("continues: investigation of payment timeouts" or "new
session") and the owner can override it. The route is checked again at the moment of sending, and the focus, the
time window, the result IDs and the deployed revision are pinned into the prompt as they were when it was composed.

| Situation | Decision |
| --- | --- |
| The focus is the subject of a thread, or part of it (its evidence, its pod, its change), same mode, session idle | Continue that session |
| Same, and the session is running | Queue the prompt behind its current turn. Interrupting mid-turn ("steer") is an explicit choice, never the default |
| Same, and the session is waiting on a permission or a question | Show what it is waiting for; answer that first |
| Same, and the session failed or OpenCode is not running | New session on the thread with a handoff, or wait: the page says which |
| The thread has several sessions | The most recent idle one in the same mode; the page names it |
| A different mode that needs different permissions (investigate, then fix) | A new session of its own in its own worktree, linked to the thread by Overwatch |
| The session's context is no longer true: a new revision was deployed, the incident was resolved | New session with a fresh context pack and a handoff. If the question is about the change itself, the pack covers both sides of it |
| The session has grown past a size where answers degrade, or OpenCode has compacted it | New session with a handoff; the old one is kept for reference |
| The focus is a different subject | That subject's thread, or a new thread |
| The evidence in focus belongs to more than one incident | The owner chooses |
| The focus is several things, a search result set or the whole fleet | A thread scoped to that set; follow-ups reuse it |
| The owner says "new" or "here" | As told |

A thread groups its sessions, so the history of work on a subject reads in one place whatever the routing was.

**What a handoff carries.** When a session settles, Overwatch records on the thread what it concluded, the
citations that were verified, the hypotheses it ruled out and those still open, and any decision the owner made
in it, including follow-ups typed in OpenCode itself. That record, not the session's transcript, is what the
next session starts from, so a fresh session can answer "what did we rule out".

### 6.4 From inside OpenCode

- The plugin ships a skill that explains the model and connects OpenCode to the service's MCP server. Any
  session can search, read an incident or insight with its timeline, read the inbox, query telemetry, and act.
  A prompt typed in OpenCode about an incident is attached to that incident's thread the same way.
- Being brought in: an ask or a hard incident opens as an OpenCode session that already carries its context pack.
  The page links to the session; the session links back.
- The plugin is installed in the global OpenCode configuration, because agent sessions run in worktrees and a
  plugin configured for one project would not load there.
- Agents keep today's limits: investigators read code in a worktree of their own at the deployed commit and
  query telemetry; only the fixer edits, in its own worktree; nobody touches an environment; pull requests are
  drafts opened by code after verify passes.

### 6.5 Driving OpenCode reliably

OpenCode is another process that can be closed, restarted or mid-turn at any moment, so the service treats it as
an unreliable peer.

- The service finds OpenCode through the client's own discovery of the managed server. While it is not there,
  jobs wait and the page says so.
- Session and prompt IDs are chosen by the service and recorded before anything is sent, so a retry after a
  crash on either side cannot start a second session or send a prompt twice.
- A prompt being accepted is not the work being done. The event stream can drop events and has no replay, and
  "wait" only means idle in that process. After any reconnect the service reads the session's stored messages
  and what is active. An interruption because OpenCode shut down is resumable, not a failure.
- A job is finished only when a finding tied to that job has been filed and its citations have checked out.
- A draft pull request is reconciled before any retry: repository, base, a deterministic head branch and the
  verified commit, so a second attempt finds the first.
- An agent's worktree and the evidence it was shown are kept until its thread is archived or expires, and can
  be recreated at the exact commit. Today's plugin deletes both when a session ends, which would make
  continuing a session impossible.

The web app is the overview: the inbox, the fleet by environment tier, an environment page (pods by revision,
memory and CPU against limits, replicas, rollout), incident and insight pages with timelines, connections, and
search. It is served by the service on loopback and holds no logic of its own.

## 7. Phases

### Phase 0: checks that need the real environment

These cannot be done on a development machine and do not block the first increment, but anything that depends
on them waits for them.

| Check | Passes when |
| --- | --- |
| Install | `pnpm install` of the pinned packages, including Alchemy's native binary, works behind the downstream users' proxy; a per-user launchd agent runs `kubectl` with its login helper, `gh` and a keychain secret, fires after sleep and restarts after a kill |
| Spans | The Datadog keys in use can search and aggregate spans; a before-and-after comparison for one endpoint is correct |

### Phase 1A: one thin slice through every layer

One app, one environment, one collector. Everything else is deliberately absent.

- The hardened SQLite host with the journal written in the commit path.
- Minimal Watcher, Incident, Run and Thread aggregates.
- The typed API, and the MCP server with session-bound telemetry query and finding tools.
- A live inbox page: list, focus, archive, prompt bar.
- The thin plugin, installed globally, with the investigator agent.
- The service driving one investigation in OpenCode to a citation-checked finding.

It is done when these pass:

1. **Host.** Two transactions on different aggregates, one rolled back: the other's acknowledged write survives.
   Kill the process between commit, outbox and alarm firing: after restart nothing is lost or duplicated. Move
   the clock forward as a sleep would: overdue scheduled commands fire within 15 seconds.
2. **Detect once.** Overlapping polls create one incident. Sleep across three intervals and wake: covered
   windows and gaps are explicit and there is one triage intent.
3. **Live page and never twice.** A collector run opens an incident and the open page shows it without a reload.
   Archive removes it; the same signal on the next poll updates it silently and it does not return.
4. **Prompt in focus.** Prompting on a focused incident creates a thread and an OpenCode session; the
   investigator reads evidence over MCP and files a finding; the citations check out against what that session
   was shown; the finding appears on the page. A made-up citation, a finding filed for another run, and a
   `kubectl` verb outside the allowlist are each refused.
5. **OpenCode comes and goes.** With OpenCode stopped, polling, the page and archive work and prompt jobs queue
   visibly. Starting it drains the queue once. Restarting it mid-run, and dropping the event stream mid-answer,
   both end with one session, one prompt and the finding recovered.
6. **Continue and remember.** A follow-up from the page and one from OpenCode both land on the same thread after
   OpenCode has unloaded the directory. A fresh session answers "what did we rule out" from the handoff.
7. **Restore.** Rebuild search and restore the database from a backup: the incident is searchable, the inbox
   stays quiet and no work is started twice.
8. **Plugin.** It loads in a fresh worktree with no Effect at run time and gives the investigator the Overwatch
   tools under deny-by-default permissions.

### Design pass

A dedicated pass on look and feel by Gemini 4 Neon, using the repository's `gemini-frontend-design` skill. This is
one person's own tool, so it can be opinionated, dense and fun: it does not have to look like a product. It sets
the visual language (logo, type, colour, motion, density, how focus and the prompt bar feel) that every later page
follows, records it in `docs/design.md`, adds a demo mode so the page can be seen full of realistic data, and
leaves mock-ups of the pages still to be built.

### Learning loop

Designed with the owner straight after the design pass (5.4), then built in steps alongside the later phases:
goals and measurement first, the interview and change proposals next, replay last.

### Phase 1B: the service in full

The remaining collectors behind `ExternalSystem` boundaries, with the hardening and tests that exist today; the
failure handling of 4.1; the 10-minute schedule for every watcher; the Catalog and Connection aggregates;
install and uninstall of the launchd agent; `overwatch status`; storage compaction.
Exit: it polls unattended for a week through sleep and restarts with every run accounted for, and disk growth
and rebuild time at a year's volume are measured and acceptable. Parity with today's plugin is not a goal.

### Phase 2: the command center

The inbox as grouped decisions with act, snooze, archive, suppress and delegate; Rules; fleet, environment,
incident and connection pages; search in the page, the API and as a tool; the prompt bar with focus, context packs, Threads and session
routing; the skill that lets any OpenCode session act on Overwatch.
Exit: starting from an empty inbox each morning is normal, anything archived stays gone, any past incident is
found by search in seconds, and any thing on any page can be asked about without leaving it.

### Phase 3: triage to verified release

Triage proposals; asks; easy fixes as draft pull requests; the Change aggregate with delivery through build and
release (GitHub and Jenkins); verified recovery; commit and pull request monitoring with risk review.
Exit: one real fix is followed from detection to verified recovery in production with no bookkeeping by hand.

### Phase 4: looking deeper

Spans and regression measurement; the daily and weekly analyses; the Insight lifecycle with the never-twice rule;
improvement ideas that can become issues or draft pull requests; the digest; a scorecard of how often each kind of
agent output was accepted.
Exit: over a month, most accepted insights were new to the owner and none was a repeat.

### Phase 5: handover

Export and restore, 50 environments, upgrade paths, the downstream install guide, running without launchd.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| launchd's environment has no shell `PATH`, variables or interactive login | Install records the tool paths it found and tests each one; secrets come from the keychain; the Connections page shows every failure with its fix |
| A managed laptop forbids background agents | The same program runs in a terminal; only start-at-login is lost |
| A broken sign-in or outage is retried forever, or reported over and over | Failures are classified; sign-in failures stop at once; everything else backs off to a suspension; one inbox item per cause (4.1) |
| OpenCode is not running when an agent is needed | Jobs wait in the queue; detection, the page and search keep working; the inbox says agents are waiting |
| The service and plugin drift apart in version | One repository, one version; the plugin checks the service's API version at load |
| Alchemy Domain is a five-week-old beta whose host interface is undocumented and has changed between releases | Exact version pin; Overwatch owns the host; a conformance suite gates every upgrade; the journal keeps every event in a table Overwatch owns |
| Alchemy's install is heavy and includes a native binary | Proved on a downstream machine in the Install spike before anything depends on it |
| No upcasting and no global order in Alchemy Domain | Additive events only, with new events for new meaning; the journal projection gives the one ordered log |
| Session routing sends a prompt to the wrong place | The decision is shown before sending and can be overridden; threads keep the history together either way |
| A context pack leaks a secret or is too large | Built by code, redacted on the way in, bounded by schema |
| Agents flood the inbox | Rules run first; the never-twice rule; analyses measure before they speak; acceptance is tracked per kind of output |
| Secrets in stored excerpts | Redaction, by name and by entropy, before anything is stored |
| Scope | Nothing is kept for compatibility, so the first increment is a thin slice through every layer and not a rebuild to parity; every later phase ships on its own |

## 9. Decisions still needed from the owner

1. Whether the people who will use this can run a per-user background service, and install npm packages that
   carry a native binary.
2. The pilot: one app with staging and production, on Kubernetes and Datadog, that deploys often.
3. Which Jenkins jobs matter.
4. Whether Datadog APM (spans) is in use for the pilot app, and with which keys.

## 10. Not in this plan

Also deliberately out: the system changing its own rules, thresholds or prompts without the owner approving the
change.


Remediation in any environment, spend tracking, Bun, mobile, multi-user access control, paging integrations.

## 11. What the second review changed

Both reviewers kept the two-program shape and Alchemy Domain. Raised by both unless noted.

| Fourth revision | Now | Why |
| --- | --- | --- |
| The prototype SQLite host, to be hardened | An explicit host contract: one lock that knows the transaction's owner, claim-fire-clear alarms, a wall-clock ticker | Both reproduced a write lost to another object's rollback, and an alarm lost on a crash while firing |
| Conformance by running Alchemy's stories on SQLite | Shared fixtures through the in-process client on both hosts, plus crash tests | `Story` always builds the in-memory host |
| The journal as a projection with a constant key | A journal row written in the aggregate's commit transaction | Positions changed across a rebuild; every event stored twice; per-event rewrites that grow with the number of instances |
| Everything a watcher does is an event | Only things that happened are events; polling state is plain tables | Millions of empty events a year (one reviewer) |
| All tools from `toMcp` | Model reads and commands from `toMcp`; telemetry query and finding tools hand-written and bound to the calling session and run | `toMcp` discards the session ID that citation checking depends on |
| "The plugin uses the typed client" and "no Effect in the plugin" | No Effect and no client in the plugin; plain fetch and MCP registration | The two statements contradicted each other |
| Wait for a session to finish | Service-chosen IDs recorded first; reconcile from stored messages after any reconnect | Accepted is not done; the event stream drops events; a shutdown is resumable |
| Worktree removed when a session ends | Kept until the thread is archived, or recreated at the exact commit | Continuing the session would fail |
| Routing by "kind of work" | Routing by focus, an explicit mode and session state; queue by default, interrupt only when asked; five more cases | Intent cannot be decided by code from wording; interrupting mid-turn can derail a check |
| One inbox row per incident | One row per decision, grouping everything one cause produced across environments | One bad release across ten environments was ten rows |
| The analyst judges whether an insight is new | A claim key computed and enforced by code | A model will let rephrased duplicates through |
| Phase 1 rebuilds the service in full, then a page | Phase 1A is one slice through every layer with eight acceptance tests | It proves the whole path first; the owner also said nothing needs to stay compatible |

## Appendix: why not inside OpenCode

The second revision hosted everything in an OpenCode plugin. Research against the OpenCode source at commit
`3ac14c0` and review by Gemini 4 Neon and GPT-6.2 Astra (both at high reasoning) established:

| Finding | Evidence in the OpenCode repository |
| --- | --- |
| A plugin's `setup` runs per directory, and the directory is unloaded after 60 minutes without session activity. A plugin's own timer stops then. There is no server-lifetime scope. | `packages/core/src/plugin.ts:315-320`; `packages/core/src/location-activity.ts:30,115` |
| Automations can wake a plugin with no session open, but they are experimental, need an authorising session, cannot be resumed by a plugin once paused, cap code at 30 seconds, and can deadlock if created during setup. | `packages/core/src/automation.ts:783-797,611-619`; `packages/core/src/automation/code.ts:18-23,90-130`; `packages/core/src/plugin.ts:114` |
| Only session events keep a directory loaded, so a run in flight is killed at unload. | `packages/core/src/location-activity.ts:16,71` |
| Plugin storage is last-write-wins with no transactions or compare-and-set. An event log on it cannot be ordered or folded safely. | `packages/core/src/kv.ts:49-80` |
| A plugin cannot serve pages through the server, and artifacts are sandboxed so a page hosted as one cannot call the API. | `packages/server/src/handlers/artifact.ts:222`; `packages/server/src/request-site.ts:15-24` |
| The desktop GUI plugin API has no full-page surface outside a session except a settings page, loads only in the desktop app, and is experimental. | `packages/plugin/src/gui/registries.ts:274-282,404-441` |
| OpenCode pins `effect` 4.1.0 for plugins; Alchemy Domain needs `^4.1.4`. | `packages/plugin/README.md:13-19` |

What carries over from that review into this plan: one writer; runs recorded and safe to repeat; an outbox for
outward effects; triage disposition separate from incident state; symptom recovery tracked separately from change
delivery, with several delivery signals and "unknown" as a valid answer; connection health from actual reads, not
new `kubectl` verbs; the smallest useful screen early.

What this revision reverses from that review: the reviewers advised against event sourcing. Their objection was to
doing it on OpenCode's key-value store. On a single process with transactional SQLite, the objections (no
compare-and-set, unreliable replay order, read models overwritten by a stale writer) no longer apply.
