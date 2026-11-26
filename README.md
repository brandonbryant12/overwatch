# Overwatch

Overwatch watches your apps on Kubernetes and Datadog from your laptop, counts what goes wrong exactly where it
read everything inside limits it writes down, marks every other total as a lower bound, says honestly when it does
not know, and lets an OpenCode model investigate with evidence it cannot invent. It is one Node process and one SQLite file, with no runtime dependencies and nothing to build.

This is the **simple core, milestones 1 and 2**: the kernel, the tools for proving it on a real laptop and a real
model, and the page.
Specification: [docs/plans/simple-core.md](docs/plans/simple-core.md) with its
[amendments](docs/plans/simple-core-amendments.md) and [interfaces](docs/plans/simple-core-interfaces.md).
Agents answering prompts from the page is milestone 3.

![The demo, dark](docs/design/screenshots/v2/desktop-dark-all-groups.png)

## In one minute

```sh
git clone <this repository> overwatch && cd overwatch     # Node 22.13 or newer; nothing to install
bin/overwatch check  --config ~/.config/overwatch/config.json
bin/overwatch serve  --config ~/.config/overwatch/config.json   # then open the address it prints
bin/overwatch status --config ~/.config/overwatch/config.json
bin/overwatch doctor --config ~/.config/overwatch/config.json
bin/overwatch demo   --config ~/.config/overwatch/config.json   # a seeded, isolated picture; contacts nothing
```

## What exists

- **Storage**: one SQLite file owned by one process through SQLite's own exclusive lock; every change is one
  transaction that appends to an append-only event log; text is stored only after redaction.
- **Collection**: Kubernetes through read-only `kubectl` (logs, events, workloads, usage) and Datadog (logs, monitors,
  a metric), counted by keys made from each source's own data, so replay, crash and late data never count twice; a
  total over a window that was not fully read is marked as a lower bound.
- **Health**: each environment is quiet, needs a look, partial, stale or signed out, from the least-known reading
  and the problems active now.
- **Failures**: classified (sign-in, permission, rate limit, unreachable, configuration), backed off, suspended and
  probed; one cause per failure; "offline" only when several independent endpoints all fail.
- **The page**: the environments strip, the inbox in four groups whose rows never move under you, Done, Later and
  Never with undo and a reason for everything that comes back, a finder, and one bar that asks about what is in
  focus. Moving, deciding, undoing, finding and asking are on the keyboard (a source is reached by a click or the
  finder). It keeps its own clock, says stale or down by itself, and ages each environment's measurements too.
- **Commands**: `check`, `serve`, `status`, `backup`, `restore`, `doctor`, `trial`, `demo`.
- **Investigation tools** over MCP, with evidence by handle, and `trial`, which measures your model on five seeded
  cases before any automation is allowed for that model.

## Documentation

- [docs/setup.md](docs/setup.md): install, configure, connect OpenCode, run, back up.
- [docs/using.md](docs/using.md): what the service does, health, failures, the commands and their output.
- [docs/customizing.md](docs/customizing.md): the configuration grammar and the operating limits.
- [docs/design-philosophy.md](docs/design-philosophy.md): why it is shaped this way.
- [AGENTS.md](AGENTS.md): rules for people and agents changing the code.

## Tests

```sh
pnpm install          # dev dependencies only: typescript, fast-check, @types/node
pnpm run check        # typecheck and the unit and property tests in test/
pnpm run accept       # the milestone 1 acceptance suite in accept/m1 (M1_LONG=1 for the release run)
node --no-warnings --test --test-concurrency=2 accept/m2/*.test.mjs   # the page contract (uses system Chrome)
node --experimental-strip-types --no-warnings test/real/screenshots.ts  # screenshots of the demo
```
