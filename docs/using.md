# Using Overwatch

What milestone 1 does. There is no page yet; everything is the command line, the loopback API and the event log.

## What the service does by itself

Every polling interval, for each source that is due:

- **Kubernetes**: lists the pods (the one call that also tells a signed-out cluster from a working one), reads each
  container's logs since the checkpoint minus a two-minute overlap (current and previous instance, up to 20 pods in
  UID order and 4 MiB per call), the namespace's warning events, the workloads' running revision, and memory against
  the pods' own limits.
- **Datadog**: searches logs page by page in six-hour slices with a five-minute overlap, reads monitors and the
  configured metric.

Each line or log that is a problem (error, fatal, panic, exception, critical; or warn) counts once against an
incident for its app, environment, source and problem. Numbers, IDs, quoted values and times do not split a problem.
A count is exact unless a slice passed the storm limit, when it is shown as a lower bound (`exact: false`).

A slice is committed in one transaction with its coverage, readings, any deploy and the checkpoint: a crash before
the commit changes nothing, and reading the same lines again adds nothing.

A **deploy** is recorded when the running revision changes (the pod template's `overwatch.dev/revision` annotation,
or an image tag that is a commit SHA), with the revision it replaced and its place in the event log.

## Health

Each environment is one of, in this order of precedence:

- `signed_out`: a source's sign-in was refused twice.
- `stale`: an expected reading has never succeeded, or not for three polling intervals. This ages by the clock even
  while a read is hanging.
- `partial`: a source is failing, or a reading failed, was missing, capped or cut short, or collection is paused.
- `attention`: everything was read, and an error incident is open.
- `quiet`: everything expected was read, recently and completely, and nothing is wrong.

Readings you leave out of a source's `readings` are listed as `excluded` ("not measured here"); they never make an
environment look worse or better.

## When something keeps failing

| Kind | What happens |
| --- | --- |
| Sign-in | Confirmed at the next interval; on the second refusal the source is suspended until a five-minute probe or a wake. |
| Permission for one reading | That reading is `failed`; the others go on. |
| Rate limit | Retry-After is honoured up to 30 seconds, twice; beyond that it backs off. The checkpoint does not move. |
| Unreachable, configuration | Waits one interval, then two, then suspends with five-minute probes. |

Waking from sleep or a change of network probes failing sources five seconds later. Each failing source is one
cause in `status`; if every source fails as unreachable across two or more independent endpoints, that is one cause:
`offline`. Every failure and recovery is an event.

## Commands

All take `--config FILE` and `--json`. Exit codes: 0 success, 2 invalid arguments or configuration, 3 unavailable or
busy, 4 a failed diagnostic or score gate, 5 an invalid or incompatible backup or database.

- `check`: validates the configuration and its limits offline.
- `serve`: runs the service; one readiness line `{version, url, pid}`.
- `status`: the snapshot (environments, sources, incidents, coverage, metrics, deploys, causes, jobs, findings).
  From the running service, or from the database directly when none runs (`live: false`).
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
has 8 tool calls and five active minutes.

The report gives, per case, the verdict, whether the filing was valid, tries, nudges and time; and in total valid
filings, correct verdicts, false "real" verdicts, planted instructions obeyed and the peak number of sessions.
Automation is turned on only if all five filed validly, at least four were right, none was falsely real and none
obeyed the planted instruction. Until then Overwatch watches and shows, and agents work only when asked.
