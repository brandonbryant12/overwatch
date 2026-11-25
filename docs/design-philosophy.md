# Design philosophy

The principles Overwatch is built on, why, and a decision each one settled. They come from
[plans/command-center.md](plans/command-center.md); the last few are ones the implementation relied on.

## Attention is scarce and compute is free

The person using it has limited attention and effectively unlimited tokens. So the system spends compute freely
(poll often, investigate every new incident, re-check citations) and spends attention only on decisions.
*Settled*: a new incident starts an investigation by default instead of waiting to be asked; the inbox shows a
verdict, not raw logs.

## Deterministic code detects and decides; models interpret and propose

Whether something happened, whether it is new, and whether a claim is supported are questions code can answer the
same way every time. Models explain and propose. *Settled*: de-duplication, fingerprints, routing a prompt to a
session and checking citations are all pure functions or plain code; a model never decides whether an incident is a
duplicate.

## The event log is the memory; sessions are workers

Everything that happened is an event in one store, and a session can be thrown away at any time because a context
pack rebuilds what it needs from the log. *Settled*: a new session starts from the thread's handoff (what was
concluded, verified and ruled out), not from an old transcript; the e2e test shows a fresh session answering "what
did we rule out" from it.

## Unknown is never shown as healthy

What was not read is not green. *Settled*: a stretch the lookback cap cut off is recorded as a gap (an event, and a
`gap` row in the coverage table), and a source that fails keeps its checkpoint, so the next run reads the same time
again instead of skipping it.

## Nothing is told twice, and everything leaves the inbox

The inbox holds things that need a decision, and each has a way out that sticks. *Settled*: archive is a
disposition, separate from the incident's state, so more of the same signal updates an archived incident without
bringing it back.

## One model, typed from the store to the browser

Commands, events, views and the Api are Effect schemas in one Alchemy Domain model; the service, the MCP server and
the page use the same definitions. *Settled*: the page imports the model's routing function and runs it to show
where a prompt will go before it is sent, and the Thread aggregate runs the same function when the prompt arrives.

## Read-only against environments, and every outward action proposed

Overwatch never changes an environment. *Settled*: Kubernetes is reached only through `kubectl get|describe|logs|top`
with the configured context and namespace, checked in code for collection and for agents alike; the investigator is
denied everything by default.

## Evidence is checked by code, or it does not count

A finding is a claim with citations, and a citation is either in what the session was shown or it is not.
*Settled*: the tools that read telemetry and file findings are written by hand so they know which session is calling;
what a session is shown is recorded, and its quotes are checked against exactly that.

## Fail quietly and visibly

Classify a failure, back off, suspend, and raise one item per cause; never retry forever and never repeat a notice.
*Settled in phase 1A*: a run that ends without a finding is nudged once and then fails with its reason on the thread;
a failing source records its error and keeps its checkpoint. Classification, back-off and one item per cause are
planned for phase 1B.

## Each program does what it is good at

The service owns time and state: it polls when OpenCode is closed and never loses a fact. OpenCode owns thinking and
doing: every agent run is a real OpenCode session the person can open and continue. *Settled*: the plugin holds no
state and schedules nothing; it registers an agent, a skill and the MCP server, and checks the service's version.

## Everything on screen is addressable and can be prompted on

Anything shown has a typed reference and can be the focus of a prompt. *Settled in phase 1A*: an incident is the
focus, and prompts are recorded on that incident's thread whether typed on the page or in OpenCode. Other kinds of
focus are planned.

## Small replaceable pieces at explicit boundaries

Each part can be swapped without rewriting the others. *Settled*: the Domain host is Overwatch's own code behind
Alchemy's host interface, tested by a conformance suite that runs the same fixtures on Alchemy's in-memory host; the
journal is a table Overwatch owns, so leaving Alchemy would not lose the history.

## A foundation to fork and grow

This is a starting point people will fork, make their own, and improve for years. So prefer explicit seams over
cleverness, configuration over code, and additive change over rewrites: events only gain optional fields, thresholds
and schedules live in configuration, prompts and skills are files, and what the owner does is recorded as an event
naming who did it, so that later the system can propose changes to its own rules from that history. *Settled*:
a fork adds a source type through the config's `extensions` and a module in `local/`, a directory upstream never
writes to, and points the plugin at its own prompt file, without editing upstream files.

## Principles the implementation relied on

- **Choose ids before you act, and record them first.** Session, message and run ids are derived by the model and
  recorded before anything is sent to OpenCode, so every retry is the same call. *Settled*: the OpenCode outbox is
  create-then-prompt-then-mark-sent, all idempotent by id, and the crash and e2e tests show one session and one
  prompt after restarts.
- **The aggregate decides; views are eventually consistent.** A view can lag the aggregate it reads. *Settled*: the
  worker checks a run's aggregate before acting on what the pending-runs view lists, and the context pack reads the
  incident's view at least as new as its last commit in the journal.
- **One lock that names its owner.** Every access to the one SQLite connection goes through one lock that knows which
  object holds the open transaction, so one object's write can never be lost to another's rollback.
- **A crash test is worth more than an argument.** The host is killed at every commit and every write of a scenario
  and restarted; three real holes were found this way and fixed.
