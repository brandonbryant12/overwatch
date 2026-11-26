# Overwatch: the case for a redesign

A case file for people asked to propose the best path forward. It states the goal, what is fixed, what was built,
how it was graded, and exactly how it fell short. It proposes nothing.

## The goal

A personal tool for one engineer, graded at least an A as "personal software productivity tool". The owner's words:

- "The output is like auto fixing issues and detecting problems real time or before hand. As well as keeping me up
  to date and non technical team up to date."
- "I have multiple envs I need to stay up to date on. I want to monitor logs and datadog, commits regularly."
- "I want to triage issues as they come. Have open code raise draft PRs on easy fixes. Bring me in to help triage
  when needed. When I am needed I am working via opencode sessions but the session has knowledge of the overwatch
  system and how to interact."
- "I want to regularly look deeper beyond logs and maybe analyze spans and regressions and come up with ideas to
  improve project."
- "I will not be trapped at looking at long lists or same incident or insight over and over. I can archive or
  classify some way to not show up in my list anymore." "I can search system easily."
- "I want the UI to be superpowered in a way that anything I want a closer look into I can just prompt with that
  thing in focus." "It should be smart when to keep things into same session or new sessions."
- "I want this dashboard to have the ability to learn and adapt and customize with me over time."
- "A great product is one that can be simple but everything is well thought out."
- "The most beautiful and awesome dashboard ever. Let's have fun with it."
- On the redesign: "We can be more dramatic in a redesign and refactor. We do want to use sqlite and some command
  center in dashboard but we can be technologically indifferent. It's more important to have a great product and
  ideally simple. Opencode agent is another thing we do want to take advantage of. Be more extreme. We can create
  an overwatch in some vein that is at least an A, that leverages my unlimited local inference of GLM 5.3."

## What is fixed

- It runs locally on the owner's work laptop (macOS), which sleeps and loses its VPN. It will be forked by
  colleagues on corporate machines behind a registry proxy.
- Inputs: Kubernetes through the `kubectl` CLI only, read-only (`get`, `describe`, `logs`, `top`); Datadog through
  its API; the local repository checkouts and the GitHub remote through `git` and `gh`; later Jenkins.
- Read-only against environments. No remediation. Draft pull requests only, after the app's own verify commands pass.
- Every agent is an OpenCode 2 session running GLM 5.3, an open-weights model behind a private endpoint with no
  token limit. It is weaker than the models building this. Nothing has been run on it yet.
- No Bun. No spend tracking. Nothing pushed to Slack or Teams; updates for other people are written by the tool and
  sent by the owner. SQLite for storage. A dashboard as the command center.
- Everything else is open: language features, libraries, architecture, the front-end stack, whether there is a
  build step, whether it is event sourced, how agents are used.

## What was built (branch `command-center`, 71 commits, about 14,000 lines with the page)

Two programs. A Node service that owns scheduling and state, and a thin OpenCode plugin.

- State is event sourced on Alchemy Domain (`@alchemy.run/domain`, a five-week-old beta) through a custom
  single-process host on `node:sqlite`: a key-value layout the library owns, an exclusive gate per object, alarms,
  leases, receipts, and a journal table written by recognising the library's private storage keys. Aggregates:
  Watcher, Incident, Thread, Run. Views and policies are delivered asynchronously and can lag their aggregates.
- Effect throughout; a Foldkit (Effect, Elm-style) web page built with a bundler; a typed API and an MCP server
  derived from the model; `@opencode/client` to drive sessions.
- Collection: polling every source from its checkpoint with an overlap, de-duplicating by occurrence ID, grouping
  by a normalised fingerprint; metric series with hysteresis; failure classification, back-off and suspension.
- Investigations: an OpenCode session in a git worktree at the deployed commit; the agent queries telemetry through
  MCP tools and files a finding whose quotes are checked by substring match against what the session was shown.
- The page: an inbox grouped into Needs you, New, Working, Quiet; three ways out (Done, Later, Never) with undo;
  focus plus a prompt bar; an environments strip; a visual language, logo and demo mode from a design pass.
- 209 tests including property tests, a real OpenCode end-to-end run with a scripted model, and a headless browser
  test. Documentation for setup, use, customising and design philosophy.

## How it was graded

One independent assessor (a different model family from the builder) graded four times, reproducing every claim.
Overall: C plus, B minus, B minus, B minus. Before the fourth round the assessor wrote 18 failing tests; the builder
made all 18 pass without weakening them; the grade did not move.

Area grades at the last grading: host B minus, domain B plus, service B minus, security and safety C plus,
end-to-end types B plus, page as software B, design B plus, tests B plus, documentation B minus, room to grow
B minus, product usefulness B minus, simplicity B.

## How it fell short, by kind

Every one of these was reproduced by the assessor. Several were introduced by the fix for the previous round.

- **Counting.** 202 log lines counted as 201 (the count came from a list capped at 200 examples). The fix removed
  the cap: the same 20,000 lines polled twice then counted 39,500 (the overlap de-duplication keeps only 500 IDs),
  and 200,000 lines hit a call-stack error, counted zero and saved no checkpoint. Earlier: three lines became five
  when the service died between reporting and saving its checkpoint.
- **One writer.** Two services opened one database. Fixed with a lock file; then two started at the same instant
  both won (67 of 200); fixed; then a new version started beside a running older one and both served.
- **Order.** A deploy and a deferral raced because a reaction read a lagging view. Fixed by letting the incident
  decide from its own history; then the two reversed when they shared a millisecond, although the journal had
  their true order.
- **What a finding may claim.** A quote verified because it appeared in the brief; then in a query's own arguments;
  then with a short word missing after an ellipsis; then because a file shared a source's name; an empty worktree
  was labelled deployed code; an untracked file verified as deployed code; a continued session kept the label
  after a file changed. The model's confidence word was shown as if calibrated.
- **Secrets.** A token in a prompt was stored; then a `password=` value; then one in a caller-supplied identifier
  and one in an error message. The stricter identifier rule that followed made the page's own prompts fail under
  one redaction setting, and earlier silently stopped every live subscription.
- **False health.** A green "checked, quiet" beside an unmeasured reading; one healthy source masking another's
  gap; green after sleep with failed refreshes; green while a status request hung, because the page's clock only
  advanced when a request settled.
- **Restore.** A text file replaced a database; then one with the right table names and wrong columns; then one
  with an extra required column; then one with an inline uniqueness constraint.
- **Notifications.** Never retried; then a non-zero exit treated as success and one notification sent twice.
- **Growth.** Every deploy visits every incident ever opened in that environment and writes a receipt for each.
- **Not yet proven at all:** GLM 5.3 on any task; a real laptop install (the launchd agent, cluster sign-in under
  it, the registry proxy, a native binary one dependency brings); real Datadog; real clusters.

## What reviewers said about why

- The assessor: "I would stop the current fix-and-regrade loop. The obstacle is that ordinary operating conditions
  still violate the guarantees." It would resume only for "a bounded redesign with three acceptance conditions:
  exact counts under a declared burst and replay budget, journal-position ordering, and mutual exclusion across
  supported upgrades."
- A strategy review: "The plan chases A plus by adding surface area before proving corporate-laptop limits or GLM
  5.3's real accuracy." "Build-then-grade stalls because point reviews patch individual bypasses while new phases
  widen state faster than point tests close it." It questioned "whether a custom host on a beta domain library
  costs forks more than plain SQLite plus pure decide and evolve functions."
- The orchestrator's read: each pass fixes the case tested and breaks or exposes a neighbour; the system declares
  no operating limits, so every guarantee is implicitly "under all conditions" and the code grows to defend
  conditions the product does not need; the defects cluster at seams between mechanisms.

## Where to look

- This repository: `docs/plans/command-center.md` (the plan, sixth revision), `docs/design-philosophy.md`,
  `docs/using.md`, `docs/design.md`, `docs/design/screenshots/`, `AGENTS.md`, `src/`, `web/`, `test/`.
- The four assessments, if still present: `/private/tmp/ow-review.Oz72DF/assessment.md`,
  `/private/tmp/ow-third.VEiE7u/assessment.md`, `/private/tmp/ow-fourth.tzGCYw/assessment.md`.
- OpenCode 2 source at commit 3ac14c0, for what a session, a plugin and an MCP server can do:
  `/private/tmp/claude-501/-Users-brandon-Development/68b623d9-d83a-4e8e-a030-6fae89e4c754/scratchpad/src/opencode`.
