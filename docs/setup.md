# Setting up Overwatch

This covers a locked-down macOS laptop: Node and pnpm only, packages through a registry proxy, no Bun, read-only
access to environments. Every step ends with how to check it worked.

## 1. Prerequisites

| Tool | Why | Check |
| --- | --- | --- |
| Node 22.13 or newer | Runs the service and the tests. Overwatch is TypeScript that Node runs by stripping types; no build step. 22.13 is the first Node 22 with `node:sqlite` unflagged. | `node --version` |
| pnpm | Installs dependencies. | `pnpm --version` |
| git | Worktrees for investigations. | `git --version` |
| OpenCode 2 (2.4.1 tested) | Runs every agent session. | `opencode --version` prints `opencode v2.…` |
| `kubectl`, logged in to each cluster you watch | The Kubernetes collector. Only `get`, `describe`, `logs` and `top` are ever run. | `kubectl --context <ctx> -n <ns> get pods` |
| Datadog API and application keys, if you watch Datadog | The Datadog sources. Read-only scopes are enough. | see [Secrets](#secrets) |

Bun is not used anywhere and must not be installed for Overwatch: no script, test or dependency needs it.

On Node 22, type stripping is behind a flag; every Overwatch command (`bin/overwatch`, the `pnpm` scripts, the launchd
agent) passes `--experimental-strip-types` for you. Node 23.6 and later do not need it but accept it.

## 2. Install

```sh
git clone <this repository> overwatch
cd overwatch
pnpm install
pnpm run check
```

`pnpm install` also builds the page into `web/dist` (the `prepare` script). `pnpm run check` must end with all tests
passing; it touches no cluster, no Datadog and no repository host.

### Behind a registry proxy

pnpm reads the npm configuration. Point it at the proxy in `~/.npmrc` (not in the repository):

```ini
registry=https://npm-proxy.example.internal/
strict-ssl=true
cafile=/path/to/corporate-ca.pem
```

If outbound HTTPS needs a proxy too, set `https-proxy=` in the same file, or `HTTPS_PROXY` in the shell.

### The native binary

The `alchemy` package (a required peer of Alchemy Domain) brings `rolldown`, which has a platform binary package
(`@rolldown/binding-darwin-arm64` on Apple silicon). pnpm installs it as an ordinary optional dependency; no install
script runs. Overwatch uses rolldown only to bundle the page (`pnpm run build:web`). If your proxy blocks the binding
package, `pnpm install` still succeeds: its `prepare` step builds the page with `--optional`, prints why it could
not, and carries on. The service then answers `/` with a short page saying the page is not built; the Api, MCP and
`/status` work. Build `web/dist` on another machine with `pnpm run build:web` and copy the directory in. Whether the binding installs behind your proxy is one of the plan's phase 0 checks and has not been
verified on a corporate machine.

Check: `ls node_modules/.pnpm | grep rolldown` lists the binding, and `pnpm run build:web` prints `built …/web/dist`.

## 3. Configure

The service reads one JSON file (comments allowed), by default `~/.config/overwatch/config.json`
(`$XDG_CONFIG_HOME/overwatch/config.json` when set). Start from the example:

```sh
mkdir -p ~/.config/overwatch
cp examples/config.json ~/.config/overwatch/config.json
```

Edit apps, environments, sources and watchers; every option is in [customizing.md](customizing.md). Then:

```sh
bin/overwatch check
```

It prints `… is valid` or the list of problems. Nothing environment-specific goes into this repository: names,
contexts, paths and queries live only in your config file.

### Secrets

Secrets are never written into the config. Where an option takes a secret (`opencode.password`, Datadog keys), give
a reference:

- `env:NAME`: the environment variable `NAME`.
- `keychain:service/account`: a generic password in the macOS login keychain. Store it yourself:
  `security add-generic-password -s overwatch -a opencode-password -w` (it prompts for the value).

The service resolves references when it needs them and never logs or stores the values (a test checks that Datadog
keys reach Datadog's request headers and appear in nothing Overwatch stores).

### Datadog

Add the keys to the keychain yourself (each command prompts for the value):

```sh
security add-generic-password -s overwatch -a datadog-api-key -w
security add-generic-password -s overwatch -a datadog-app-key -w
```

then reference them, and add Datadog sources to an environment:

```jsonc
"datadog": { "apiKey": "keychain:overwatch/datadog-api-key", "appKey": "keychain:overwatch/datadog-app-key", "site": "datadoghq.com" },
"apps": { "shop-api": { "environments": { "production": { "sources": {
  "errors": { "type": "datadog-logs", "query": "service:shop-api env:production status:error" },
  "monitors": { "type": "datadog-monitors", "tags": ["service:shop-api"] }
} } } } }
```

Check: `bin/overwatch check`, then after the next poll `bin/overwatch status` shows a checkpoint for each Datadog
source, or its error under `last_error`. Under launchd the keychain must be unlocked (it is while you are logged in).

### Notifications

On macOS the service notifies once when an incident opens in a production-tier environment and once when its finding
arrives. Which environments notify is configuration (`tier`, `notify`; see [customizing.md](customizing.md)); the
global `"notify": false` turns all of it off. The first notification may ask macOS to allow notifications from
`osascript` (Script Editor); allow it in System Settings, Notifications.

## 4. The plugin

The plugin must be in the **global** OpenCode configuration: Overwatch's sessions run in worktrees, and a plugin
configured for one project does not load there. Edit `~/.config/opencode/opencode.json` (show the change to yourself
before saving; keep everything else as it is) and add:

```json
{
  "plugins": [
    { "package": "/absolute/path/to/overwatch", "options": { "url": "http://127.0.0.1:7450" } }
  ]
}
```

`url` defaults to `http://127.0.0.1:7450`. The plugin registers:

- the agent `overwatch-investigator`, denied everything by default and allowed to read code, run read-only `git`,
  load skills, and use Overwatch's MCP tools;
- the skill `overwatch`, which tells any session how to read the inbox, an incident, a thread and search;
- the MCP server `overwatch` at `<url>/mcp`, with Code Mode off.

It checks the service's health and Api version when it loads. If the service is not up it logs a warning and
registers everything anyway; the tools work once the service starts.

Check: start OpenCode in any directory and list agents (`overwatch-investigator` is there) and MCP servers
(`overwatch` connected). From a script: `client.agent.list(...)` and `client.mcp.list(...)`, as `scripts/e2e.ts` does.

## 5. Start the service by hand

```sh
bin/overwatch serve                       # or: bin/overwatch serve --config /path/to/config.json
```

It prints `listening on http://127.0.0.1:7450 (database …)`. Open that address for the page. In another terminal:

```sh
bin/overwatch status
```

shows whether OpenCode is connected, each watcher's last run and next run, any configuration errors, and each
source's checkpoint. The service answers only on loopback, and refuses requests from other host names and other
origins.

Data lives in `dataDir` (default `~/.local/share/overwatch`): the database `overwatch.sqlite`, `worktrees/`, and
`logs/` when run by launchd. Only one service may have a database open: a second one (a terminal and launchd both
running it, say) refuses to start and names the process that has it. The lock is held by the operating system on
`overwatch.sqlite.writer` and released when the process exits or dies, so there is nothing to clean up after a crash;
`overwatch.sqlite.writer.holder` only says who holds it. An `overwatch.sqlite.lock` left by an earlier version is only
consulted: if that version is still running the new one refuses to start, and a note left by one that died is removed.

## 6. Keep it running with launchd

```sh
bin/overwatch launchd print        # shows the agent it would install
bin/overwatch launchd install      # writes ~/Library/LaunchAgents/dev.overwatch.service.plist and loads it
bin/overwatch launchd uninstall    # unloads and removes it
```

`--no-load` writes or removes the file without calling `launchctl`; `--agents-dir <dir>` writes elsewhere (the
tests use a temporary directory).

launchd starts programs with a bare environment: no shell `PATH`, none of your terminal's variables, no interactive
login. So install from the terminal where `kubectl`, its login helper (for example a cloud CLI it calls), `git` and
`security` all work: install records that `PATH` in the agent and prints where it found each tool, and `NOT FOUND`
for any it did not. A `kubectl` login that opens a browser cannot complete under launchd; log in from a terminal
first, and Overwatch keeps using the cached credentials. Secrets come from the keychain at run time.

Check: `launchctl print gui/$(id -u)/dev.overwatch.service` shows it running, `bin/overwatch status` answers, and
`~/.local/share/overwatch/logs/service.log` has the `listening on` line.

The plist generation and install are tested against a temporary directory with a fake `launchctl`; installing for
real, surviving sleep and restart after a kill are phase 0 checks that have not been run on a real machine yet.

## 7. Backup and restore

```sh
bin/overwatch backup ~/overwatch-2026-11-25.sqlite   # safe while the service runs
bin/overwatch restore ~/overwatch-2026-11-25.sqlite  # with the service stopped
bin/overwatch rebuild-search                          # with the service stopped; rebuilt from the journal at start
```

A backup is one consistent SQLite copy: incidents, threads, unfinished runs, schedules, checkpoints, unsent reports
and the journal travel together. Restore copies the backup next to the database, checks it (it opens, it has
Overwatch's tables, SQLite's integrity check passes) and only then replaces the database in one rename; it refuses
while a service has the database open. The restore test (`test/service.test.ts`) shows the restored service sends
nothing to OpenCode again and keeps incidents marked Done out of the inbox; that is what is tested, not a general
guarantee about every kind of work.

## Troubleshooting by symptom

| Symptom | What to check |
| --- | --- |
| `bin/overwatch check` lists problems | Each line names the option path and what is wrong. Fix the file; nothing runs until it is valid. |
| `status` says `The service is not answering` | Is it running (`launchctl print …`, or the terminal)? Is `service.port` taken by something else? The log says `listening on` once up. |
| The page says `connecting` and never `live` | The page reads the service on the same address it was loaded from. Open it from `http://127.0.0.1:<port>`, not another host name: other host names are refused on purpose. |
| `status` shows `opencode.connected: false` | OpenCode is not running, or not where the service looks. Without `opencode.url` it finds the managed OpenCode server the way the OpenCode client does; with a fixed `url`, check it and `opencode.password`. Runs wait meanwhile and nothing is lost. |
| OpenCode logs `[overwatch] the service is not answering` | Start the service; the plugin does not need a restart. If it says the Api versions differ, update the plugin and the service together (they are one repository). |
| The investigator says it has no token, or tools are refused | Tools need the run token Overwatch puts in the prompt and must be called from that run's session. A session you started yourself can read and search, not query telemetry or file findings. |
| A watcher's `last_error` names a source | The source failed for that run; its checkpoint did not move, so the next run covers the same time. For Kubernetes, run the same `kubectl` command from the error in a terminal. |
| `Needs you` says a connection is signed out, not allowed, configured wrongly or unreachable | Run the fix command the item shows. Overwatch tries again by itself every `failures.ceiling` (30 minutes), and at once after the laptop wakes or the network changes; the item closes when it works. `bin/overwatch status` shows each environment's `suspended`. |
| `Needs you` says "Offline or off the VPN" | Every connection is unreachable at once: connect to the network or VPN. One item, not one per source. |
| Runs stay `queued` | OpenCode is not connected (see above). |
| A run failed with "finished twice without filing a finding" | The model ended its turn twice without calling `file_finding`. Prompt on the incident again; it starts from the handoff. |
| launchd starts it but `kubectl` fails | The agent's `PATH` lacks `kubectl` or its login helper. Reinstall from a terminal where `which kubectl` works. |
| The service will not start: "Another Overwatch service (pid …) has … open" | Another service already has the database: stop it (`launchctl bootout gui/$(id -u)/dev.overwatch.service`, or the other terminal). The lock is released by the operating system when that process exits, so there is no file to remove. |
| `restore` refuses a file as "not an Overwatch backup" | It is not a whole Overwatch database (does not open, lacks Overwatch's tables, or fails SQLite's integrity check). The current database was not touched. |
| The page says it has not been built | `pnpm install` could not load the bundler (often the native binding behind a proxy). See [The native binary](#the-native-binary). |
| An environment on the strip says "Not checked for …" | Its last full check is older than three polling intervals: the service is not running, a source keeps failing, or the laptop slept; `bin/overwatch status` shows each watcher's last run and error. |
| A finding says the code read is "NOT the deployed code" | Overwatch could not resolve the running revision in the app's checkout: `git fetch` in the checkout, or set `deployedCommit` for the environment. |
| No notifications appear | Only production-tier environments notify by default; check `tier`/`notify`, the global `notify`, and macOS notification permission for Script Editor. |
