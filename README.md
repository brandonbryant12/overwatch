# Overwatch

Overwatch watches your apps on Kubernetes and Datadog from your laptop, counts what goes wrong exactly where it
read everything inside limits it writes down, marks every other total as a lower bound, says honestly when it does
not know, and lets an OpenCode model investigate with evidence it cannot invent. It is one Node process and one SQLite file, built on [Effect](https://effect.website) 4 for the service and [Foldkit](https://foldkit.dev) (on Effect) for the page.

This is the **simple core, milestones 1 to 4+**: the kernel, reality tools, calm Foldkit page with declarative GenUI
visual lenses, per-environment autonomy policies, read-only database inspection (`ow_db`), multi-angle OpenCode agents
(tuned for free local GPU models like GLM 5.3), slow-span & commit watching, narrow verified fixes, and clean corporate
forkability.
Specification: [docs/plans/simple-core.md](docs/plans/simple-core.md) with its
[amendments](docs/plans/simple-core-amendments.md) and [interfaces](docs/plans/simple-core-interfaces.md).
The agents are OpenCode sessions on your own model; nothing depends on a model being right. Code adjudicates
independent readings and a challenger, evidence is cited by handle, and disagreement is shown as disagreement.

![The demo, dark](docs/design/screenshots/v2/desktop-dark-all-groups.png)

## In one minute

```sh
git clone <this repository> overwatch && cd overwatch     # Node 24, or 22.16 or newer
pnpm install                                              # Effect, and the page's bundle (pnpm run build:web)
bin/overwatch check  --config ~/.config/overwatch/config.json
bin/overwatch serve  --config ~/.config/overwatch/config.json   # then open the address it prints
bin/overwatch status --config ~/.config/overwatch/config.json
bin/overwatch doctor --config ~/.config/overwatch/config.json
bin/overwatch demo   --config ~/.config/overwatch/config.json   # a seeded, isolated picture; contacts nothing
bin/overwatch install --config ~/.config/overwatch/config.json  # run it at login (launchd); docs/setup.md
```

## What exists

- **Storage**: one SQLite file owned by one process through SQLite's own exclusive lock; every change is one
  transaction that appends to an append-only event log; text is stored only after redaction.
- **Collection**: Kubernetes through read-only `kubectl` (logs, events, workloads, usage) and Datadog (logs, monitors,
  a metric, plus opt-in slow `spans` for latency regressions), counted by keys made from each source's own data, so
  replay, crash and late data never count twice; a total over a window that was not fully read is marked as a lower bound.
- **Health**: each environment is quiet, needs a look, partial, stale or signed out, from the least-known reading
  and the problems active now.
- **Failures**: classified (sign-in, permission, rate limit, unreachable, configuration), backed off, suspended and
  probed; one cause per failure; "offline" only when several independent endpoints all fail.
- **The page & declarative GenUI**: the environments strip, an at-a-glance Overview Situation Board with a calm
  **"What's New"** card (`Mark caught up` checkpoint, 24h fallback on first visit or seq reset, and a topbar
  `Overview` unseen indicator; pair with the topbar `Brief` sheet / `b` or `GET /v2/brief?afterSeq=<seq>` for a
  fence-bounded digest), per-environment policy pills, bounded scrollable read-only
  DB evidence tables, the inbox in four groups whose rows never move under you, Done, Later and Never with undo and a
  reason for everything that comes back, a finder, one bar that asks about what is in focus, and schema-validated
  declarative **Visual Lenses** (`causal_flow`, `span_waterfall`, `metric_compare`, `commit_risk`, `timeline`,
  `key_facts`) grounded strictly in stored evidence handles (`g` to synthesize via OpenCode, with instant deterministic
  derivation always available). Moving, deciding, undoing, finding, asking, and OpenCode handoff (`o`, `c`, `Shift+O`)
  are on the keyboard. It keeps its own clock, says stale or down by itself, and ages each environment's measurements too.
- **Agents & read-only DB inspection (`ow_db`)**: investigations by 1–5 independent readings (up to 6 concurrent
  sessions and 24 tool calls for free local GPU models like GLM 5.3) and a challenger, adjudicated by code; optional
  read-only SQL inspection (`postgres`, `mysql`, `sqlite`) scoped per `(app, env)` with named parameterized templates
  by default, opt-in guarded `allowSelect`, engine-level read-only flags, env-only credentials, and strict refusal for
  fixers; answers to your questions where you asked them; "Was this right?" corrections that reach the next
  investigation; briefs to copy; local notifications; and owner-only MCP tools (`ow_inbox`, `ow_get`, `ow_handoff`,
  `ow_search`, `ow_act`, `ow_correct`, `ow_investigate`, `ow_brief`, `ow_outlook`, `ow_db`) plus a skill so any local
  OpenCode session of yours can pull grounded handoff packs, queue on-demand investigations (including watch-only envs),
  teach new playbook rules, and act on the inbox end to end.
- **Per-app / per-env policies & fixes**: configure `investigate`, `readings`, `notify`, `critical` (including names
  beyond `prod`/`production`), `fixMode` (`"off"`, `"propose"`, `"draft_pr"`), and `genUi` via an `env -> app -> global`
  cascade. For an app that opts into `fixes`, a confirmed problem that began after one deployment gets a verified
  candidate that reverts one commit of that deployment or restores one setting. A model only selects; code derives the
  change from Git, checks it and verifies it in isolation (macOS). In default `"propose"` mode (human-in-the-loop) a
  draft pull request is opened only when you press `Shift-P`; opt-in `"draft_pr"` mode (human-on-the-loop) runs the
  same permit-gated `--draft` publication once verified and calibrated. Nothing is ever merged by Overwatch.
- **Looking ahead**: time left on a capacity metric, shown only when six consistent readings support it; a staging
  release compared with unchanged production; and an opt-in read-only **commit watcher** (`commitWatch`) flagging
  newly landed config, database, auth, timeout, and large commits before they become incidents.
- **Corporate forkability**: config layering via `"extends"` (relative or `~/` paths, with `overwatch install` scanning
  merged configs for `env:` secrets), config-driven `redactPatterns`, starter templates in [examples/](examples/), and
  fork recipes in [docs/forking.md](docs/forking.md).
- **Commands**: `check`, `serve`, `status`, `backup`, `restore`, `doctor`, `trial`, `demo`, `install`, `uninstall`, `restart`.
- **Investigation tools** over MCP, with evidence by handle, and `trial`, which measures your model on five seeded
  cases before any automation is allowed for that model.

## Documentation

- [docs/setup.md](docs/setup.md): install, configure, connect OpenCode, run, back up.
- [docs/forking.md](docs/forking.md): corporate fork architecture, config layering, per-env policies, read-only `ow_db`, local GPU (GLM 5.3) tuning, and fork recipes.
- [docs/genui.md](docs/genui.md): static chrome vs. declarative GenUI Visual Lenses and dual handle grounding.
- [examples/](examples/): ready-to-adapt starter configs (`corp-base.json`, `personal-override.json`, `opencode-glm53.json`).
- [docs/using.md](docs/using.md): what the service does, health, failures, the commands and their output.
- [docs/customizing.md](docs/customizing.md): the configuration grammar and the operating limits.
- [docs/design-philosophy.md](docs/design-philosophy.md): why it is shaped this way.
- [AGENTS.md](AGENTS.md): rules for people and agents changing the code.

## Tests

```sh
pnpm install          # the tools, and the page built into web/dist
pnpm run build:web    # build the page again after changing web/src
pnpm run check        # typecheck (service and page) and the tests in test/ and web/test/
pnpm run accept       # the milestone 1 acceptance suite in accept/m1 (M1_LONG=1 for the release run)
node --no-warnings --test --test-concurrency=2 accept/m2/*.test.mjs   # the page contract (system Chrome; build first)
node --experimental-strip-types --no-warnings test/real/screenshots.ts  # screenshots of the demo
```
