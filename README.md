# Overwatch

An [OpenCode 2](https://opencode.ai) plugin that reads your apps' logs and telemetry for you. It checks each app and
environment on a schedule, from wherever it last left off, opens an incident for anything new, has an agent
investigate it read-only against the deployed code, and reports back in a few lines. If you let it, and the fix is
small and passes your tests, it opens a draft pull request.

It is built for one operator on a laptop: gaps from sleep or a closed lid are expected and caught up on, not missed.

## What it does

- **Watchers** bind an app to an environment. Each run reads every source since that source's last successful check
  (24 hours back the first time, never more than 14 days), walks long gaps in slices, oldest first, and says plainly
  when the cap cut coverage short.
- **Sources** are what an environment exposes: Kubernetes through read-only `kubectl` (pods, warning events, logs,
  terminations, usage against the pods' own limits, node allocatable, namespace quotas), Datadog logs, monitors and
  metrics through its API, CI through `gh`, and any program you point a `command` source at.
- **Incidents** follow "one breach, one incident": a recurring error updates its open incident instead of opening
  another, metrics need consecutive samples to breach and to clear, and nothing resolves while its source is failing.
- **Investigations** run as OpenCode sessions in a worktree at the deployed commit, with the skills you name. The
  investigator can read code and query telemetry, and cannot edit, run arbitrary commands or reach the web.
- **Reports** come from one structured finding rendered twice: a product summary you can paste (what users see, who,
  since when, status; under 80 words) and an engineering section (verdict and confidence, cause marked observed or
  inferred, at most three pieces of evidence, `file:line` at the deployed commit, what was not checked, one next
  check). The limits are enforced; "nothing found" is a valid answer.
- **Draft pull requests**, only when enabled for a watcher, only when the investigation says a small fix is possible,
  and only after the app's verify commands pass in a fresh worktree. Never a ready pull request, never a merge.

There is no spend tracking or spend cap. Runs are bounded by wall-clock timeouts and concurrency limits.

## Use

```sh
git clone <this repository> ~/src/overwatch
```

Add it to your global OpenCode config with your own apps (see [`examples/opencode.jsonc`](examples/opencode.jsonc) and
[`docs/configuration.md`](docs/configuration.md)):

```jsonc
{
  "plugins": [{ "package": "/absolute/path/to/overwatch", "options": { "apps": { ... }, "watchers": [ ... ] } }]
}
```

In any OpenCode session:

| Command | |
| --- | --- |
| `/overwatch` | Watchers, what each source has checked through, coverage gaps, open incidents, recent findings. |
| `/overwatch-run [app/env]` | Run watchers now. |
| `/investigate [--app a] [--env e] [--since 6h] [--until ISO] <pasted bug report>` | A one-off investigation; the report comes back to this session. |

Agents in any session can also call `overwatch_query` (read-only telemetry) and `overwatch_status`.

Requirements: OpenCode 2 (verified against 2.4.1), `git`, and whichever of `kubectl` and `gh` your sources use, already logged in.
macOS for keychain secret references and notifications; the rest is platform-neutral.

## Develop

```sh
bun install
bun run typecheck
bun test
OPENCODE_BIN=/path/to/opencode bun run smoke   # loads the plugin into a real OpenCode 2 server; see below
```

The smoke test starts a real OpenCode server with a temporary HOME, config and data directory, a local fake model,
and fake `kubectl` and `gh` on PATH. It checks that the commands, tools and agents register, that the scheduler runs a
watcher that opens an incident, that the investigator gets only its allowed tools and the watcher's named skill, files
a finding and produces a report at the deployed commit, that a rerun de-duplicates, and that every `kubectl` call was
read-only. It touches no cluster, Datadog account, repository host or real OpenCode config.

Layout:

```text
src/index.ts          plugin entry: agents, tools, commands, scheduler
src/sweep.ts          one watcher run
src/window.ts         since-last-check planning
src/signals.ts        signals, overlap de-duplication
src/incidents.ts      one breach, one incident
src/detection.ts      metric hysteresis
src/investigate.ts    investigation sessions at the deployed commit
src/fix.ts            verified fixes and draft pull requests
src/report.ts         finding schema, limits, rendering
src/sources/          kubernetes, datadog, github-ci, command
prompts/              investigator and fixer system prompts
```

See [`AGENTS.md`](AGENTS.md) for working on this repository with an agent, including setting it up for a new
environment.
