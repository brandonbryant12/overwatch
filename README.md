# Overwatch

Overwatch watches your apps' logs and telemetry on a schedule, keeps an event-sourced record of what it finds, and
has OpenCode agents investigate it read-only, with every citation in an answer checked by code. It is a tool for one
person on a laptop.

It is two programs:

- **The Overwatch service** (Node, one process, one SQLite file). It polls every watcher whether or not OpenCode is
  open, keeps every fact as an event, serves a typed Api, an MCP server and a web page on loopback, and drives agent
  runs into OpenCode.
- **OpenCode 2**, which runs every agent session, reached through a thin plugin that registers the investigator agent,
  a skill, and the service's MCP server.

This is phase 1A of the plan in [docs/plans/command-center.md](docs/plans/command-center.md): one thin slice through
every layer, with one collector (Kubernetes through read-only `kubectl`), one incident page with an inbox, focus,
archive and a prompt bar, and one investigator. Much of the plan is not built yet; the documents below say what is.

## Documentation

- [docs/setup.md](docs/setup.md): prerequisites, install (including behind a proxy), the plugin, starting the service,
  launchd, and troubleshooting.
- [docs/using.md](docs/using.md): what the service does by itself, the inbox, prompting on an incident, sessions, and
  what happens when OpenCode is closed.
- [docs/customizing.md](docs/customizing.md): every configuration option, adding apps, sources and model changes,
  prompts and permissions, and the tests.
- [docs/design-philosophy.md](docs/design-philosophy.md): the principles it is built on and what each rules out.
- [AGENTS.md](AGENTS.md): rules for people and agents working on the code.

## In one minute

```sh
pnpm install                                   # Node 22.13+ and pnpm; no Bun
cp examples/config.json ~/.config/overwatch/config.json   # then edit it
bin/overwatch check                            # validate the configuration
bin/overwatch serve                            # the service, on http://127.0.0.1:7450
```

Add the plugin to the global OpenCode configuration (see [setup](docs/setup.md#4-the-plugin)), open
`http://127.0.0.1:7450`, and prompt on an incident.

## Checking it

```sh
pnpm run check                                 # typecheck and every test
OPENCODE_BIN=/path/to/opencode pnpm run e2e    # against a real, isolated OpenCode 2 server
pnpm run test:crash                            # every kill point of the host's crash scenario (about 10 minutes)
```
