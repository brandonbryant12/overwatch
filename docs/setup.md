# Setting up Overwatch

For a macOS laptop with Node only. Every step ends with how to check it.

## 1. What you need

| Tool | Why | Check |
| --- | --- | --- |
| Node 22.13 or newer | Runs Overwatch (it strips the TypeScript types itself; nothing is built). | `node --version` |
| git | Reads code from the deployed commit. | `git --version` |
| `kubectl`, signed in to each cluster | Kubernetes, read-only: `get`, `describe`, `logs`, `top`. | `kubectl --context <ctx> -n <ns> get pods` |
| Datadog API and application keys | Only if you watch Datadog. | `overwatch doctor` |
| OpenCode 2.4.1 | Runs the model for `trial` and `doctor`'s model check. | `opencode --version` |
| `gh` | Checked by `doctor` for later milestones. | `gh --version` |

There is no `npm install` for running it: `"dependencies"` is empty. `pnpm install` only fetches the development
tools (TypeScript, fast-check) for running the tests.

## 2. Configure

Write `~/.config/overwatch/config.json` (or pass `--config FILE`):

```json
{
  "version": 2,
  "dataDir": "~/.local/share/overwatch",
  "port": 7331,
  "mcpToken": "env:OW_MCP_TOKEN",
  "opencode": { "url": "http://127.0.0.1:4096", "model": "private/glm-5.3" },
  "apps": {
    "shop": {
      "checkout": "~/src/shop",
      "environments": {
        "prod": {
          "sources": {
            "pods": { "type": "kubernetes", "context": "prod-east", "namespace": "shop", "selector": "app=shop",
                      "readings": ["logs", "events", "workloads", "usage"] },
            "dd": { "type": "datadog", "baseUrl": "https://api.datadoghq.com", "apiKey": "env:DD_API_KEY",
                    "appKey": "env:DD_APP_KEY", "query": "service:shop", "metric": "avg:shop.errors{*}",
                    "readings": ["logs", "monitors", "metrics"] }
          }
        }
      }
    }
  },
  "watchers": [{ "app": "shop", "environment": "prod", "every": "2m" }]
}
```

Secrets are references, never values: `env:NAME` or `keychain:service/account` (store a keychain value yourself
with `security add-generic-password -s service -a account -w`). Every key is described in
[customizing.md](customizing.md).

Check: `bin/overwatch check` prints `… is valid` (exit 0) or the exact setting to fix (exit 2). It contacts nothing.

## 3. Connect OpenCode

Overwatch has no plugin. OpenCode loads it from its own configuration (`~/.config/opencode/opencode.json`):

```json
{
  "agents": { "ow-investigator": { "mode": "primary", "permissions": [
    { "action": "*", "resource": "*", "effect": "deny" },
    { "action": "ow_ow_telemetry", "resource": "*", "effect": "allow" },
    { "action": "ow_ow_code_read", "resource": "*", "effect": "allow" },
    { "action": "ow_ow_code_search", "resource": "*", "effect": "allow" },
    { "action": "ow_ow_history", "resource": "*", "effect": "allow" },
    { "action": "ow_ow_finding", "resource": "*", "effect": "allow" } ] } },
  "mcp": { "servers": { "ow": { "type": "remote", "url": "http://127.0.0.1:7331/mcp",
    "headers": { "Authorization": "Bearer <the value of mcpToken>" }, "oauth": false, "codemode": false } } }
}
```

and a skill folder `skills/overwatch/SKILL.md`. OpenCode names an MCP tool after its server, so the tool
`ow_telemetry` on server `ow` is the permission action `ow_ow_telemetry`. OpenCode puts its own default rules before
yours and the last matching rule wins: `doctor` accepts the agent when nothing after its deny-all allows anything but
an `ow_` tool.

OpenCode 2.4.1 always asks for a password (Basic `opencode:<password>`). Run as a service, it registers its address
and password in `~/.local/state/opencode/service.json`, and Overwatch reads them from there when `opencode.url` is
not set. Under a plain `opencode serve`, set `opencode.url` and point `opencode.password` at the `OPENCODE_PASSWORD`
it runs with, for example `"password": "env:OPENCODE_PASSWORD"`.

Check: `bin/overwatch doctor` reports `opencode`, `model`, `agent`, `mcp` and `skill`. The run in
`test/real/opencode.ts` does all of this against a real OpenCode 2.4.1 with a scripted model.

## 4. Run it

```sh
bin/overwatch serve --config ~/.config/overwatch/config.json
```

It prints one readiness line once it owns the database and listens on `127.0.0.1`. It writes
`<dataDir>/service.json` so the other commands can find it. A second `serve` on the same data directory, of any
version, exits with code 3 and the address of the one already running.

Check: `bin/overwatch status` shows each environment's health.

## 5. Check the laptop and the model

```sh
bin/overwatch doctor     # every dependency, one by one, each failure with its fix (exit 4 if any fails)
bin/overwatch trial      # five seeded cases through your model; turns automation on only if it passes
```

Both ask the running service. `doctor` also inspects the launchd job `dev.overwatch.service` and the PATH and
proxy it runs with; it does not install anything.

## 6. Back up and restore

```sh
bin/overwatch backup  --to ~/overwatch-backup.sqlite   # while running or not; never overwrites a file
bin/overwatch restore --from ~/overwatch-backup.sqlite # with the service stopped
```

Restore checks the backup (its identity, version and integrity) and rebuilds every row inside the existing
database in one transaction; anything wrong (a foreign file, a future version, an impossible value) is refused with
exit 5 and the current data is left as it was.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `serve` or `status` exits 3, "in use by another process" | Another Overwatch (or SQLite program) owns the database. Stop it. The message names the running service's address if it answers. |
| An environment is `signed_out` | Run the fix `status` shows (your cluster's login command), then wait for the next probe; it resumes by itself. |
| An environment is `stale` | A reading has not succeeded for three polling intervals: the service is not running, a read hangs, or the laptop slept. |
| `paused: "disk"` | Less than 256 MiB is free next to the database. Free space; collection resumes by itself. |
| `trial` exits 3 | Start `serve` first: the model calls the service's tools. |
