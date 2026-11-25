# Overwatch

**Initial product and architecture plan · November 24, 2026**

Overwatch is a local command center for the applications you operate. Open it in the morning and you should be able to answer three questions at a glance. **What changed? What is an agent already handling? What needs my judgment?** When an investigation turns into engineering work, its evidence and conversation should follow it all the way to a locally verified draft PR.

## A day in Overwatch

Imagine checkout latency rises in production after a rollout. Most pods are ready. A collection run finds that the slow requests share a database span and that a recent Jenkins build changed the query path. Overwatch opens one incident, links the affected environment, and shows the traces, comparison window, and build. Deployment timing is a lead. The agent still needs evidence that explains the slowdown.

From the incident, you ask, *“Is this happening on the old replicas too?”* The agent compares both revisions and adds its answer to the timeline. You can keep talking there or open that same session in the OpenCode desktop app or terminal. If the evidence supports a code change, the agent reproduces the slow path locally, makes the change, repeats the check, and opens a draft PR with the results. The incident continues watching production until fresh telemetry shows recovery. If the agent needs a decision at any point, the inbox tells you exactly which decision would unblock it.

## What the dashboard should show

| View | What you see and can do |
| --- | --- |
| **Overview** | One row per app and environment. Show health, its reason, evidence age, open incidents, and current agent activity. An offline connector shows stale or unknown coverage. Put items needing a decision first. Filter by app, environment, service, or team tag. |
| **Environment** | Show deployments and revisions alongside their pods, readiness, restart counts, CPU and memory, with units and sample times. Drill into a pod’s events and logs or a service’s traces and builds. **Collect now** runs against the selected scope and shows progress. |
| **Incident** | Lead with impact, affected scope, current hypothesis, and next action. Below that, show evidence, decisions, linked sessions, issues, and PRs in time order. Ask a question, redirect or pause the agent, create a GitHub issue, or request a verified draft PR here. |
| **Needs me** | Each entry carries a specific question, why the answer matters, what the agent checked, and what it can do next. Answering resumes the waiting work. Keep routine progress on the incident timeline. |
| **Sessions and insights** | List Overwatch-managed sessions with their trigger, app, environment, status, and latest activity. Resume in the GUI or CLI. Surface evidence-backed findings from exploratory runs, including trends that merit attention before they become incidents. |

## Configure an environment once

An **application** owns its local repository and verification instructions. Each **environment** maps that application to its deployed services and connector scopes. This mapping lets an agent go from a slow span to the right workload, build, and checkout without asking you for four identifiers. Preview the resources each mapping matches during setup.

| Connector | Per-environment configuration | Evidence or action |
| --- | --- | --- |
| Kubernetes / EKS | Local kube context, namespace, workload and label selectors. Pass the context explicitly on each call. | Read deployments, pods, events, logs, and available resource metrics. Show missing metrics as unavailable with their source. [Kubernetes resource metrics](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/) |
| Datadog | Site or base URL, log indexes, APM service and environment tags, and a reference to the local credentials accepted by the required endpoints. | Search logs and spans over a recorded time window, compare latency distributions, and retain links to representative traces. [Datadog authentication](https://docs.datadoghq.com/api/latest/authentication/) |
| Jenkins | Controller URL, folder and job paths, branch mapping, account and local token reference. | Link build number, revision, result, and relevant console excerpts to a rollout when the identifiers match. [Jenkins remote API](https://www.jenkins.io/doc/book/using/remote-access-api/) |
| Git / GitHub | Local checkout, configured Git remote, target branch, and existing GitHub authentication. | Inspect changes, work on a dedicated branch or worktree, run project checks, file an issue, and publish a draft PR. |

Setup should be credential-blind. You select a local credential reference or existing CLI profile and see which operations succeeded, which failed, and when they were checked. The connector resolves the secret on the host and returns scoped, scrubbed evidence to the browser, model, and event history. Agent sessions run directly on the Mac with the operator’s normal OpenCode permissions and local tools. This design keeps credentials out of the setup and connector output. The session still has whatever file and shell access the operator grants it.

## Collection, investigation, and action

**Collection** runs locally while the Mac is awake, even with every dashboard tab closed. Use Kubernetes watches where available and incremental polling for query-based sources. Cadence belongs to the environment. A rollout or open incident can shorten the interval, a quiet environment can back off, and rate limits can delay a source independently. Keep per-source checkpoints and display the last successful observation. After sleep or loss of VPN, show the gap and collect once on reconnect before judging health.

**Investigation** starts from an anomaly, a user question, or a scheduled exploration. For a trace “random walk,” sample a slow request and an ordinary request for the same route and release. Follow the child spans that account for the difference, then check whether the pattern recurs across pods or revisions. Each run has a time and query budget and records what it sampled. A useful outcome can be an incident, a lower-priority insight, or a short record explaining why the sample was inconclusive. Recurring evidence updates the existing incident.

**Actions** such as **Investigate**, **Create issue**, and **Prepare draft PR** send an intent to an agent with the selected environment, incident, evidence, and desired outcome already attached. Navigation, filtering, and routine collection use ordinary application code. The operator can configure which work starts autonomously per environment. An OpenCode permission request, an ambiguous target, or a decision that needs business context appears in **Needs me** with a way to continue.

For a fix, record the starting revision, a reproduction or failing check, the change, the exact verification steps and results, and the resulting issue or PR link. Run the repository’s normal local workflow, including the affected user flow when applicable. If it cannot be reproduced locally, say what was verified and what remains unknown. Track local verification, PR status, deployment, and observed recovery separately.

## Architecture and ownership

| Owner | Responsibility |
| --- | --- |
| **OpenCode 2 service** | Owns sessions, conversation history, model execution, tools, and permission prompts. Connect the local Overwatch backend through the version-matched network client. Store the service, workspace, and session identifiers needed to return to the same conversation. [OpenCode client](https://opencode.ai/docs/build/client/) · [Shared service](https://opencode.ai/docs/cli/) |
| **Overwatch local service** | Owns the app/environment catalog, collection, evidence, incidents, decisions, and links to external work. Start with a single process and a local SQLite store. Keep connector I/O and session calls outside the functions that decide incident state. |
| **Web dashboard** | Reads a snapshot, sends commands, and subscribes to the local service’s event stream. Each tab can act independently. Versioned updates and replay from a cursor bring tabs back into sync after reconnect. One collection schedule serves all tabs. |

The local installations differ. On November 24, the shell’s `opencode` reported 1.19.6, `opencode2` reported beta-19157, and OpenCode Desktop bundled a 2.2.7 CLI whose help lists `--server` and `--session`. Prove same-session handoff against one selected service before choosing the client version or desktop launch mechanism. Check the session exists on that service before opening it. OpenCode 2.4 also documents scheduled and event-driven automations. Evaluate those as a trigger source if that version is selected, with one owner for each schedule. [OpenCode 2.4 release notes](https://opencode.ai/changelog/v2.4.0)

### An event model small enough to verify

Use Alchemy Domain’s command, event, and view model for Overwatch decisions. An incident moves from **investigating** to **watching for recovery** to **resolved**. A pending human decision can arise in either active state. Recording the question puts it in the inbox, and recording the answer removes it and lets the session continue. Keep large telemetry at its source and retain the query, observation time, source link, and a bounded, redacted excerpt. Evaluate the Alchemy package against local durability and replay before committing to its runtime. [Alchemy Domain](https://alchemy.run/domain/) · [Model testing](https://alchemy.run/domain/testing-models/)

Persist each requested external action with a stable ID before dispatch. Associate its session and provider result with that ID so the next worker can reconcile interrupted work. Start with executable stories for ordinary incidents. For formal verification, model two tabs, one pending action, a restart, and a delayed provider response. Explore the possible orderings and use the resulting traces to check the implementation.

- Two tabs acting on the same pending decision can accept it once. A stale response receives the recorded outcome.
- A retry after an uncertain GitHub response reconciles the existing issue or PR before another write. If the outcome stays ambiguous, the action waits for review.
- Replaying recorded events reconstructs the same incident and inbox without dispatching external work.
- A passing local test or a drafted PR cannot mark production recovered. Recovery requires fresh evidence for the affected environment.

These properties cover workflow decisions. An operator evaluates an agent’s diagnosis by following the cited evidence and challenging the conclusion.

## First milestones and handoff

1. **Prove session continuity.** In a disposable local repository, create one session through the client, ask a follow-up, resume it in the terminal and desktop, and see the reply back in Overwatch. Record which version and handoff path worked.
2. **Deliver one useful monitoring loop.** Configure one application and environment, collect pod health and Datadog traces, surface a repeatable latency incident, and ask it a question. Open two browser tabs, trigger collection, then close both. On return, both should show the same completed run and incident.
3. **Close the engineering loop.** Add Jenkins build correlation and let the agent reproduce a known sample problem, verify the fix locally, and create a GitHub issue and draft PR. Interrupt the workflow after an external write and confirm it resumes with the original artifact.
4. **Broaden coverage.** Add more apps and environments, tune polling and exploration from observed noise and cost, and introduce insights. Later, generate daily team emails from the same incident history. A technical brief can cite traces, builds, and PRs. A nontechnical brief should explain impact, recovery, and outstanding decisions.

**For the next planning pass**, pick the pilot app and environment, its most useful recurring question, and what evidence would answer it. Set its initial collection and research budgets, name the actions that may run unattended, and test the OpenCode handoff. Use that example to settle the smallest event model and first dashboard screen.
