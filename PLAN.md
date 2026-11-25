# Overwatch

**Product and architecture plan · v2 · November 24, 2026** · supersedes `INITIAL_PLAN.md`

Overwatch is a local command center for the applications you operate. It has three jobs:

1. **Respond.** When something breaks, you see it within seconds and get an agent's first take within about two minutes.
2. **Discover.** Agents explore traces, logs and resource trends on a budget and surface problems before they become incidents.
3. **Communicate.** One click turns an incident into an update, an issue or a brief that a teammate can read.

Two rules apply to all three. **Overwatch earns attention, it does not demand it**: short structured output, detail on demand. **Overwatch gets better with use**: every output can be rated by you and is scored by an LLM judge, and those scores change prompts, playbooks and thresholds through reviewed diffs.

## 1. Experience

### The loop

```
collect ──▶ detect ──▶ triage ──▶ investigate ──▶ act ──▶ watch recovery ──▶ learn
 (code)     (code)    (agent)      (agent)      (agent)      (code)        (judge + you)
```

Collection and detection are plain code, so health is fast, cheap and never waits on a model. Agents start when a signal fires, when you ask, or when exploration budget is available.

### A day in Overwatch

**09:00.** You open **Now**. Twelve tiles are green, one is amber. Nothing needs you. Two new insights are waiting.

**11:42.** A rollout of `checkout-api` reaches prod. Overwatch sees the Jenkins build and opens a rollout watch: tighter polling, before/after comparison. p95 latency doubles. A macOS notification arrives: *"checkout-api prod: p95 2.1s after build #482 (was 0.9s)."*

**11:44.** The incident card has a first take: three bullets, a latency sparkline, the suspect span, the build diff link. You type *"Is this on the old replicas too?"* The agent compares revisions and answers in two lines with one chart.

**11:50.** You press **Prepare fix**. The agent works in a git worktree, reproduces the slow query, changes it, reruns the check and opens a draft PR. One ask appears in **Needs me**: *"Push branch and open draft PR? Checks pass locally."* You approve. You press **Draft update** and paste the stakeholder version into Slack.

**12:30.** The fix deploys. Fresh telemetry shows p95 back at baseline, and the incident resolves itself. You rate the root cause as correct. That case joins the evaluation set.

### Views

| View | Purpose | Shows |
| --- | --- | --- |
| **Now** | The home screen. Fits one screen for about ten environments. | Needs me, then active incidents, then a fleet grid of app × environment tiles with health, reason, evidence age and agent activity. |
| **Environment** | Health in depth. | Workloads and pods with readiness, restarts, CPU and memory sparklines. A strip of rollouts and builds. **Collect now**. |
| **Incident** | One problem, start to finish. | Headline, severity, scope, status, next action. Three-bullet current understanding. Collapsed timeline of findings, asks, actions. Chat dock. |
| **Insights** | Things worth knowing that are not on fire. | Ranked feed. Each item: one line, why it matters, evidence. Actions: promote, create issue, watch, dismiss. |
| **Runs** | Everything agents and collectors did. | Trigger, scope, duration, cost, judge score. **Open in terminal**, **Open in desktop**. |
| **Scorecard** | Is Overwatch getting better? | Quality metrics and pending improvement proposals (section 5). |

Every button is an **intent**: a verb, a scope and references to context. Navigation and filtering are ordinary UI code. Everything else (Investigate, Prepare fix, Create issue, Draft update, Collect now) starts a run with the context already attached. A command palette (⌘K) exposes the same intents.

### Text budget

Agents write into typed fields with hard limits. A command that exceeds a limit is rejected and the agent retries shorter. Prose never reaches the screen unparsed.

| Output | Limit |
| --- | --- |
| Headline | 80 characters, includes the number that matters |
| Understanding | 3 bullets, 120 characters each, each citing evidence |
| Chat answer | 2 to 4 lines plus at most one chart or table |
| Ask | One question, up to 3 options, a recommended default, one line on why it matters |
| Insight | One line plus one "why it matters" line |
| Stakeholder update | Impact, status, next update time. 60 words. |

Prefer a sparkline, diff or evidence chip over a sentence. Disclosure has four levels: headline, understanding, evidence, raw session. The first two are all most incidents need.

### Attention

- **Notify now** (macOS notification): a new incident at severity *page*, or an ask that blocks an active incident.
- **Needs me**: asks only. Routine progress stays on the incident timeline.
- **Digest**: everything else, batched into Insights and the daily brief.
- Silence means healthy *and* covered. A stale or offline connector shows as unknown, never green.

### Autonomy

Set per environment and per action. OpenCode permission rules enforce it, not prompts.

| Level | Meaning | Default for |
| --- | --- | --- |
| **Act** | Does it and records it. | Reading telemetry, investigating, editing in a worktree, running local checks. |
| **Propose** | Prepares it and asks first. | Pushing a branch, opening a draft PR, creating an issue, sending a brief. |
| **Never** | Denied by rule. | Anything that changes cluster state (`kubectl delete`, `apply`, `scale`, `rollout`). |

### Discover

Exploration runs use leftover daily budget and record what they sampled.

- **Trace walk.** Sample a slow and an ordinary request for the same route and release, follow the spans that explain the difference, then check whether it recurs.
- **New error signatures.** Cluster log messages and flag patterns that did not exist last week.
- **Drift.** Memory creep, restart counts, week-over-week latency per endpoint.
- **Rollout retrospectives.** Compare each deploy's first hour against the hour before.

**Watch** turns an insight into a standing detector. The monitoring grows from what you found worth watching.

### Communicate

A **brief** is a rendered message for an audience, built from incident history. It is drafted by an agent, approved by you, then copied or sent.

- **Incident update**, in engineer and stakeholder versions.
- **GitHub issue**, with evidence links and reproduction steps.
- **Postmortem draft** at resolution, generated from the timeline.
- **Daily brief** (later), in technical and non-technical versions, by email.

Your edits to a draft are captured as feedback.

## 2. Primitives

Eleven concepts cover the product. New features should compose these before adding one.

| Primitive | What it is |
| --- | --- |
| **App / Environment** | The catalog. An app owns a local repo and its verification steps. An environment maps the app to connector scopes (kube context and namespace, Datadog service and env tags, Jenkins job). |
| **Connector** | Typed read operations against one system, plus `probe` and `redact`. Used by collectors and by agents through the same code. |
| **Evidence** | An immutable pointer: source, query, time window, link, captured-at, and a bounded redacted excerpt. Telemetry stays at its source. |
| **Signal** | A detector's output: something deviated. Carries a fingerprint for deduplication. |
| **Finding** | A claim, its evidence, a confidence and a kind. The unit of agent output. An *insight* is a finding not attached to an incident. |
| **Incident** | An aggregate. `investigating → watching → resolved`, or `dismissed`. One open incident per fingerprint per environment. |
| **Run** | One unit of work: collect, triage, investigate, explore, fix, brief or judge. Has a trigger (signal, intent, schedule), scope, budget, outcome and, for agent runs, an OpenCode session. |
| **Ask** | A decision only you can make. Covers OpenCode permission requests, OpenCode forms and agent-raised questions. Answering resumes the run. |
| **Action** | An outward-facing side effect (issue, PR, sent brief) with a stable ID recorded before dispatch, so a retry reconciles instead of duplicating. |
| **Brief** | A message for an audience: `draft → approved → sent`. |
| **Feedback / Verdict** | Your rating or a judge's score on a finding, incident, ask, insight or brief. |

## 3. Architecture

```
 Browser tabs (Solid)             OpenCode desktop / TUI
        │ SSE watch + commands            │ same sessions
        ▼                                 ▼
 ┌───────────────────────────┐    ┌──────────────────────────┐
 │ Overwatch service (Bun)   │◀──▶│ OpenCode 2 shared service│
 │  domain model (events)    │    │  sessions, agents, tools,│
 │  scheduler, collectors    │    │  permissions, models     │
 │  connectors ──▶ k8s, DD,  │    └────────────┬─────────────┘
 │    Jenkins, GitHub        │                 │ MCP (HTTP, localhost)
 │  MCP endpoint  ◀──────────┼─────────────────┘ agents read evidence,
 └───────────────────────────┘                   write findings and asks
```

### Who owns what

| Owner | Responsibility |
| --- | --- |
| **OpenCode 2 service** | Sessions, conversation history, model execution, tools, permission prompts. Overwatch never reimplements these. |
| **Overwatch service** | Catalog, scheduling, collection, detection, evidence, incidents, asks, actions, briefs, feedback. One Bun process bound to `127.0.0.1`, running whether or not a tab is open. |
| **Dashboard** | Reads views, sends commands, subscribes to changes. Holds no state that matters. |

### How Overwatch uses OpenCode 2

Overwatch is a **client of the shared service**, not a plugin inside it. A plugin instance is created per location and rebuilt on location reload, and its lifetime across the 60-minute idle unload is undocumented. A collector must run continuously, so it lives in its own process. Extension points do the rest.

| OpenCode 2 feature | Use in Overwatch |
| --- | --- |
| `@opencode/client`, `Service.ensure()` | Find or start the shared service with a version predicate. |
| `session.create({ id, title, agent, location, metadata })` | One session per agent run. The client-supplied `id` makes creation retry-safe. `metadata` carries the run and incident IDs. |
| `session.prompt({ id, text, delivery })` | Send intents and chat. `steer` for talking to a live incident, `queue` for follow-up work. Returns once queued, so completion comes from events. |
| `event.subscribe()` | Session status, `permission.asked`, `form.created`. The stream is live-only with no replay, so on every reconnect Overwatch lists sessions and pending permissions and reconciles. |
| Permission reply (`once`, `always`, `reject`) | Asks are answered from the dashboard. |
| Agents as markdown (`.opencode/agents/overwatch/*.md`) | `triage`, `investigator`, `explorer`, `fixer`, `scribe`, `judge`. Each has its own model and permission rules. |
| Skills (`.opencode/skills/<id>/SKILL.md`) | One per connector and one playbook per app. This is where learned knowledge lives. |
| MCP (`mcp.servers.overwatch`) | Agents call Overwatch tools to read evidence and to record findings, asks and actions. |
| `opencode --session <id>` | **Open in terminal**. Present in the local 2.x CLI help. |
| `opencode://` URL scheme | **Open in desktop**. The scheme is registered locally. A session-level link is not documented and needs a spike. |

OpenCode automations (2.4, experimental) are not used in v1. Overwatch's scheduler is the single owner of every schedule.

### Agents read and write through typed tools

Connectors are exposed to agents as MCP tools from the Overwatch process. The process resolves the Datadog or Jenkins token from the macOS Keychain and returns scrubbed results. Agents never see a credential, and every tool result is already an Evidence record. Kubernetes and Git use the machine's existing kube context and Git configuration.

Agents write back the same way: `RecordFinding`, `RaiseAsk`, `RequestAction`, `ProposeResolution`. These are domain commands, validated by schema and accepted or rejected by an aggregate. **An agent proposes. The domain decides.** No code parses agent prose.

Telemetry is untrusted input. A log line can contain text aimed at the model. So `triage`, `investigator` and `explorer` get read-only permissions: no edit, no push, a shell allow-list. Only `fixer` can edit, and only inside a worktree. Outward-facing writes always go through an Action.

### Domain model

Use the [Alchemy Domain](https://alchemy.run/domain/) model (`@alchemy.run/domain`, built on Effect) for everything Overwatch decides.

| Block | Overwatch use |
| --- | --- |
| **Aggregate** (`decide`, `evolve`) | `Incident`, `Run`, `Ask`, `Action`, `Brief`, `Environment`. Pure functions, no I/O. |
| **Command / Event / Rejection** | Every state change. Rejections enforce the text budget and lifecycle rules. |
| **View** | What each screen reads: `Now`, `IncidentDetail`, `NeedsMe`, `InsightFeed`, `RunList`, `Scorecard`. |
| **Policy** | Reactions: a signal opens or updates an incident, a new incident starts a triage run, an approved ask dispatches its action. |
| **ExternalSystem** | The only doors to the outside: `Kubernetes`, `Datadog`, `Jenkins`, `GitHub`, `OpenCode`, `Notifier`. |
| **Scheduled commands** | Collection cadence, ask escalation, recovery checks. Durable and replaceable by `commandId`. |
| **Api + `toHttpApi`** | The dashboard's commands and SSE reads. `events?after=<cursor>` resumes without gaps, which is what keeps tabs consistent. |
| **Api + `toMcp`** | The agent tool surface, generated from the same Api with an explicit `expose` list. |
| **Story** | Given, when, then tests that run in memory with stubbed externals and a controllable clock. |

Pod samples and metric series are not events. Collectors keep the latest observation per scope in a small table and emit an event only when a detector fires or health changes.

### Verification

Alchemy Domain does not ship a model checker. What it does provide, and what we add:

1. **Stories** for every command. A story runs every ordering of concurrent reactions and fails if there are more than 256, so concurrency stays small enough to check completely.
2. **`Domain.verify(Overwatch)`** in CI to catch wiring errors.
3. **Property tests over `decide` and `evolve`.** They are pure, so generating bounded command sequences and asserting invariants is cheap. This is our addition.

Invariants to hold from the first milestone:

- Two tabs answering the same ask: one is accepted, the other receives the recorded outcome.
- A retry after an uncertain GitHub response reconciles the existing issue or PR before any new write.
- Replaying events rebuilds the same views and dispatches nothing.
- A passing local test or a merged PR never resolves an incident. Resolution requires fresh evidence from the affected environment.
- Every finding cites at least one evidence record.
- At most one open incident per fingerprint per environment.

## 4. Coding patterns

- **Effect and Schema everywhere.** One error model, one dependency model, branded IDs. This matches both OpenCode's Effect plugin API and Alchemy Domain (`effect@4`).
- **Pure core, effects at the edge.** `decide` and `evolve` never perform I/O. All I/O sits behind an `ExternalSystem` with a live layer and a stub.
- **Story first.** A feature begins as a failing story.
- **One block per file, named by kind**: `Incident.aggregate.ts`, `RecordFinding.command.ts`, `Now.view.ts`, `TriageOnOpen.policy.ts`, `Datadog.external.ts`.
- **One connector contract.** Operations with input and output schemas, `probe`, `redact`. One shared contract test suite runs against recorded fixtures for every connector.
- **Deterministic IDs.** `commandId` derives from the cause, session ID from the run, action ID from the request. Any step can be retried.
- **Models propose, code decides.** No LLM call inside a collector, a detector or an aggregate.
- **Config is a typed file.** `overwatch.config.ts`, schema-validated, with secrets as references such as `keychain:datadog-prod`. The setup screen previews what each mapping matches and shows probe results.
- **One design system.** `Tile`, `StatusChip`, `Sparkline`, `Timeline`, `EvidenceChip`, `AskCard`. Screens compose these and read exactly one view each.

```
packages/
  domain/       model, Api, stories              (no I/O, no platform imports)
  connectors/   kubernetes, datadog, jenkins, github + contract tests
  server/       hosts the model, scheduler, OpenCode adapter, HTTP + MCP
  web/          Solid dashboard
agents/         agent markdown, skills, playbooks (versioned, reviewed)
evals/          replayable cases and judge rubrics
```

The dashboard uses Solid, which gives access to `@opencode/client/solid` and keeps a later OpenCode desktop panel possible.

## 5. Getting better over time

**Capture.** One click, everywhere output appears.

| On | Explicit | Implicit |
| --- | --- | --- |
| Finding | Up or down, with a reason chip: wrong, noisy, too long, missing evidence | Opened or ignored |
| Incident, at close | Was it real? Root cause right? Severity right? | Reopened, time to acknowledge |
| Ask | Was this worth interrupting you? | Time to answer |
| Insight | Dismiss reason | Promoted, watched |
| Brief | — | Your edits, as a diff |
| Fix | — | PR merged, reverted or closed |

**Judge.** After each agent run, the `judge` agent scores it against a rubric: grounded (each claim is supported by its cited evidence), concise (within budget), actionable, severity correct, confidence calibrated. Use a different model from the one that did the work where possible. Scores are stored as verdicts.

**Calibrate.** Track how often the judge agrees with you. Disagreements become rubric examples. A judge that does not agree with you is not yet trusted to gate anything.

**Replay.** Every rated incident and insight becomes a case in `evals/`: the evidence excerpts, the output, your verdict. Before changing a prompt, skill or model, replay the cases, judge both versions and compare.

**Propose.** A weekly run turns feedback into concrete diffs, delivered as asks:

- A playbook line: *"checkout-api: p95 rises during the 02:00 batch. Expected."*
- A threshold change: *"This rule fired 14 times and 13 were dismissed. Raise it?"*
- A prompt or skill edit, with its replay result attached.

Nothing changes without your approval, and every change is a commit.

**Scorecard.** Incident precision, noise rate, time to first take, ask-worthiness, judge and user agreement, cost per run.

## 6. Milestones

| # | Goal | Done when |
| --- | --- | --- |
| **0** | **Spikes** (timeboxed, section 7) | Host, OpenCode version and handoff path are chosen and written down. |
| **1** | **Watch.** Catalog, Kubernetes and Datadog connectors, Now and Environment views, Collect now. No LLM. | Two tabs show the same run. Close both, reopen, and the state is intact. |
| **2** | **Respond.** Detectors, incidents, triage first take, Needs me, chat, notifications, terminal handoff. Feedback buttons ship here so data accumulates early. | A repeatable latency regression produces one incident, one notification and a first take within the text budget. |
| **3** | **Act.** Jenkins correlation, rollout watch, issue creation, fix runs in a worktree, draft PR, action reconciliation. | A known sample bug goes from incident to verified draft PR. Killing the process mid-write does not duplicate the PR. |
| **4** | **Discover and learn.** Exploration runs, Insights, Watch, judge, replay, proposals, Scorecard. | A prompt change is accepted or rejected on replay results. |
| **5** | **Communicate.** Incident updates, postmortem drafts, daily brief by email. | A non-technical reader understands yesterday from the brief alone. |

## 7. Risks and spikes

1. **Local durable host for the domain model (largest risk).** Alchemy Domain documents four hosts: in-memory (tests), Cloudflare Durable Objects, Rivet (Docker swarm locally) and Effect Cluster (Postgres). None is a single local process with a file or SQLite store. Spike in this order and stop at the first that works:
   1. Effect Cluster against a local Postgres, with one runner in the Overwatch process.
   2. A small SQLite platform layer, if the platform interface is public.
   3. Fallback: a hand-written event store on SQLite using the same aggregate, command, event, view and policy shapes, so a later move is mechanical.
2. **OpenCode version.** Three versions are installed: `opencode` 1.19.6, `opencode2` beta-19157, and Desktop 2.2.7. The latest is 2.4.1 (November 23, 2026) and the shared service is currently stopped. Pick one 2.4.x install for the CLI, the desktop app and the client library.
3. **Session handoff.** Prove one session through the client, terminal and desktop. `--session` appears in the local CLI help but not in the published docs. No session-level desktop link is documented. Fallback: open the project and select the session.
4. **Agent tool surface.** Confirm that tools generated by `toMcp` are callable from an OpenCode agent over local HTTP, that the caller can be identified as a specific run, and that an OpenCode `ask` rule on a tool gives the approval step that `toMcp` itself does not yet provide.
5. **Session ID format.** Confirm what a client-supplied session `id` must look like.

## 8. Decisions for the next pass

- The pilot app and environment, and the one recurring question it should answer first.
- Initial collection cadence and daily run budget (time, tool calls, cost).
- Models per agent, including a different one for the judge.
- Where team communication goes first: clipboard, Slack or email.
- Which actions start at *Act* versus *Propose* for the pilot.

## Sources

Read on November 24, 2026.

- OpenCode 2: [client](https://opencode.ai/docs/build/client/) · [CLI](https://opencode.ai/docs/cli/) · [API](https://opencode.ai/docs/api) · [agents](https://opencode.ai/docs/agents) · [permissions](https://opencode.ai/docs/permissions) · [skills](https://opencode.ai/docs/skills) · [server plugins](https://opencode.ai/docs/build/plugins/server) · [MCP servers](https://opencode.ai/docs/mcp-servers) · [2.4.0](https://opencode.ai/changelog/v2.4.0) · [2.4.1](https://opencode.ai/changelog/v2.4.1)
- Alchemy Domain: [overview](https://alchemy.run/domain/) · [model](https://alchemy.run/domain/model) · [story](https://alchemy.run/domain/story) · [testing](https://alchemy.run/domain/testing-models) · [HTTP API](https://alchemy.run/domain/http-api) · [MCP](https://alchemy.run/domain/mcp) · [deadlines](https://alchemy.run/domain/deadlines) · [project layout](https://alchemy.run/domain/project-layout) · [Effect Cluster host](https://alchemy.run/domain/effect-cluster)
- Local checks: `opencode2 --help`, `opencode2 run --help`, `opencode2 service status`, and the desktop app's registered URL schemes.
