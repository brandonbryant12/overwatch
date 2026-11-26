# Setting up Overwatch

For a macOS laptop with Node only: from a fresh clone to a service that starts at login. Every step ends with how to
check it.

```sh
git clone <this repository's Git remote> overwatch && cd overwatch
bin/overwatch check     # step 2 first: write the configuration
```

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
  "mcpToken": "keychain:overwatch/mcp-token",
  "opencode": { "url": "http://127.0.0.1:4096", "model": "private/glm-5.3", "password": "keychain:overwatch/opencode" },
  "apps": {
    "shop": {
      "checkout": "~/src/shop",
      "environments": {
        "prod": {
          "sources": {
            "pods": { "type": "kubernetes", "context": "prod-east", "namespace": "shop", "selector": "app=shop",
                      "readings": ["logs", "events", "workloads", "usage"] },
            "dd": { "type": "datadog", "baseUrl": "https://api.datadoghq.com", "apiKey": "keychain:overwatch/dd-api",
                    "appKey": "keychain:overwatch/dd-app", "query": "service:shop", "metric": "avg:shop.errors{*}",
                    "readings": ["logs", "monitors", "metrics"] }
          }
        }
      }
    }
  },
  "watchers": [{ "app": "shop", "environment": "prod", "every": "2m" }]
}
```

Secrets are references, never values: `keychain:service/account` or `env:NAME`. Store each keychain value yourself:

```sh
security add-generic-password -s overwatch -a mcp-token -w     # prompts for the value; likewise opencode, dd-api, dd-app
```

Use `keychain:` for anything the installed service needs: a launchd service does not see your shell's environment,
so `install` refuses a configuration with `env:` references (they are fine for `serve` in a terminal). Every key is
described in [customizing.md](customizing.md).

Check: `bin/overwatch check` prints `… is valid` (exit 0) or the exact setting to fix (exit 2). It contacts nothing.

## 3. Connect OpenCode

Overwatch has no plugin. OpenCode loads it from its own configuration (`~/.config/opencode/opencode.json`):

```json
{
  "agents": {
    "ow-investigator": { "mode": "primary", "permissions": [
      { "action": "*", "resource": "*", "effect": "deny" },
      { "action": "ow_ow_telemetry", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_code_read", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_code_search", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_history", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_finding", "resource": "*", "effect": "allow" } ] },
    "ow-challenger": { "mode": "primary", "permissions": [
      { "action": "*", "resource": "*", "effect": "deny" },
      { "action": "ow_ow_telemetry", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_code_read", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_code_search", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_history", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_challenge", "resource": "*", "effect": "allow" } ] },
    "ow-responder": { "mode": "primary", "permissions": [
      { "action": "*", "resource": "*", "effect": "deny" },
      { "action": "ow_ow_telemetry", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_code_read", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_code_search", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_history", "resource": "*", "effect": "allow" } ] },
    "ow-fixer": { "mode": "primary", "permissions": [
      { "action": "*", "resource": "*", "effect": "deny" },
      { "action": "ow_ow_telemetry", "resource": "*", "effect": "allow" },
      { "action": "ow_ow_proposal", "resource": "*", "effect": "allow" } ] }
  },
  "mcp": { "servers": { "ow": { "type": "remote", "url": "http://127.0.0.1:7331/mcp",
    "headers": { "Authorization": "Bearer <the value of mcpToken>" }, "oauth": false, "codemode": false } } }
}
```

and the owner skill: copy `skills/overwatch/` from this repository into OpenCode's skills folder
(`~/.config/opencode/skills/overwatch/SKILL.md`). The four agents are the roles Overwatch runs: readers file a
finding, the challenger files a challenge, the responder only reads to answer a question, and the fixer (only for an
app that opts in to fixes, step 6) selects one change. Overwatch also binds the
role on its side, so a responder that somehow had `ow_finding` allowed would still be refused.

**Your own sessions.** Any ordinary OpenCode session (your default agent, not the three above) can use the owner
tools `ow_inbox`, `ow_get`, `ow_search` and `ow_act` (allow `ow_ow_inbox`, `ow_ow_get`, `ow_ow_search`, `ow_ow_act` in
its permissions if they ask). The skill teaches the session to read before speaking and to confirm with you before
any way out. Overwatch asks OpenCode whether the calling session exists and refuses every session it runs itself.
From the page, `o` opens such a session with the focused problem already named in it.

**Notifications** (optional): `brew install terminal-notifier`, and make sure the service's PATH includes it. Without
it, notices are parked with that repair and the page works as before. OpenCode names an MCP tool after its server, so the tool
`ow_telemetry` on server `ow` is the permission action `ow_ow_telemetry`. OpenCode puts its own default rules before
yours and the last matching rule wins: `doctor` evaluates the rules the same way and accepts the agent only when
each of the five tools is allowed and other tools (bash, edit, read, web fetch, any other `ow_` tool) are denied.

OpenCode 2.4.1 always asks for a password (Basic `opencode:<password>`). Run as a service, it registers its address
and password in `~/.local/state/opencode/service.json`, and Overwatch reads them from there when `opencode.url` is
not set. Under a plain `opencode serve` (as in the sample above), set `opencode.url` and point `opencode.password`
at the `OPENCODE_PASSWORD` it runs with. Without a matching password every OpenCode check fails with 401.

Check: `bin/overwatch doctor` reports `opencode`, `model`, `agent` (the investigator), `agent:challenger`,
`agent:responder`, `mcp` and `skill`, and `agent:fixer` when an app opts in to fixes. These show that OpenCode
answers, the model replies, each role's rules allow exactly its tools (the four reading tools plus its own filing
tool, none for the responder, only `ow_telemetry` and `ow_proposal` for the fixer), the MCP server is connected and the
skill is installed; they do not run a tool. A missing challenger, responder or fixer is reported as failing with its
repair, but these role checks do not change `doctor`'s exit code: collection and the page work without them;
investigations need the first three, fixes need the fixer, and each stays off until its trial passes. `bin/overwatch trial` is what shows the tools working end to end. The
run in `test/real/opencode.ts` does both against a real OpenCode 2.4.1 with a scripted model.

## 4. Run it

Try it in a terminal first:

```sh
bin/overwatch serve --config ~/.config/overwatch/config.json
```

It prints one readiness line once it owns the database and listens on `127.0.0.1`. It writes
`<dataDir>/service.json` so the other commands can find it. A second `serve` on the same data directory, of any
version, exits with code 3 and the address of the one already running. Stop it with Ctrl-C.

Then install it as a per-user launchd agent, from a terminal where `kubectl`, `git`, `opencode` (and
`terminal-notifier`, if you use it) are on PATH and your proxy settings are set, because the service keeps that PATH
and `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`:

```sh
bin/overwatch install   --config ~/.config/overwatch/config.json  # writes ~/Library/LaunchAgents/dev.overwatch.service.plist and loads it
bin/overwatch restart                                             # after changing the configuration or pulling a new version
bin/overwatch uninstall                                           # stops it and removes the plist; the data directory is kept
```

The agent runs `serve` with the Node and the checkout you installed from, starts at login, restarts after a crash
and writes its output to `<dataDir>/service.log`. Nothing needs administrator rights. Installing again replaces the
earlier copy.

Check: `bin/overwatch status` shows each environment's health, and the page is at `http://127.0.0.1:7331/`.

## 5. Check the laptop and the model

```sh
bin/overwatch doctor     # every dependency, each failure with its fix; exit 4 if a required check fails (role checks are reported, not counted)
bin/overwatch trial      # five seeded cases through your model; turns automation on only if it passes
```

Both ask the running service. `doctor` also inspects the launchd job `dev.overwatch.service` and the PATH and
proxy it runs with (`launchd`, `launchd.paths`, `launchd.proxy`); if one fails, run `install` again from a terminal
that has them.

## 6. Opt an app in to fix proposals (optional)

Overwatch can propose a fix for a confirmed problem that began after one deployment: the revert of one commit of that
deployment, or one JSON setting restored to its previous value. A model only selects among options Overwatch computed;
Overwatch derives the change from Git, checks it and verifies it by itself, and shows you the verified candidate. A
draft pull request is opened only when you press `Shift-P` on that item. It never merges.

**Requirements.** `git` 2.40 or newer (for `git merge-tree --merge-base`), and `gh` signed in to the host of the
app's remote (`gh auth status`) from a terminal where the service's PATH finds it. The app's checkout must have the
remote configured (`git -C <checkout> remote get-url origin`). Overwatch never writes to that checkout: it fetches
into its own mirror under `<dataDir>/fixes/` and pushes only `ow/fix/<attempt>` branches. Make sure no protection
rule covers `ow/fix/*`, and that your base branch is protected as usual.

**Verification is macOS only.** The verify commands run in a fresh checkout of the candidate under `sandbox-exec`
(`/usr/bin/sandbox-exec`) with a deny-by-default profile: no network; reads only of the system folders, the
verify program's own installation, that checkout and its temporary folder; writes only inside the checkout and that
folder; one process group at a time, 60 s per command and 180 s in all. The verifier and every file it imports come
from the base: a change that touches one is refused. Without `sandbox-exec`, verification fails closed and no candidate is
verified; the item says why. A fork on another system has to supply an OS-enforced equivalent with the same
guarantees (no network, no reads or writes outside the checkout and the program's installation, a killable process
group), for example
a rootless container or `bwrap` on Linux, as `verify()` in `src/fixes.ts`.

**Configure** the app (only these files may change, and only these commands verify):

```json
"apps": { "shop": { "checkout": "~/src/shop",
  "fixes": { "remote": "origin", "base": "main", "paths": ["config/payments.json"], "verify": [["npm", "test", "--", "config"]] },
  "environments": { … } } }
```

Verify commands must pass with no network, from a fresh checkout that holds only tracked files. **A verify command
that needs an installed, untracked dependency tree (`node_modules` you installed by hand) fails closed**: the item
says `verify failed`, shows the command, its exit code and the first lines it printed, and names the missing module
when it can. Two patterns work:

1. **A standalone verifier.** A tracked script that uses only the language's standard library and checks the allowed
   files directly, for example `"verify": [["node", "scripts/check-config.cjs"]]` reading `config/payments.json`.
2. **An offline install inside the verifier's own temporary folder.** Track the lockfile and the package tarballs
   (for example under `vendor/`, referenced as `file:` dependencies). A tracked runner copies `vendor/`,
   `package.json` and `package-lock.json` into `fs.mkdtempSync(path.join(os.tmpdir(), "deps-"))`, runs
   `npm ci --offline --ignore-scripts --no-audit --no-fund` there, runs the check with
   `NODE_PATH=<that folder>/node_modules`, and removes the folder. `os.tmpdir()` is the sandbox's own scratch, which
   is writable; nothing is fetched.

Check a command before turning fixes on: from a fresh `git archive` of your base, with the network off, it must pass.
After a failed verify, fix the command, pass `bin/overwatch trial --fixes` again, then press `f`: that starts a new
attempt with its own proposal and its own verify. Add the `ow-fixer` agent (step 3) and restart.

**Calibrate** the model for fixes, with the service running:

```sh
bin/overwatch trial --fixes    # the five investigation cases, then a revert, a setting restoration and a refusal control
```

Fix proposals are on only if both parts pass (`Fix calibration: 2/2 verified; fix proposals on`). Changing the model,
the app's `fixes` settings or the fixer's tools turns them off until the trial passes again, and so does a real
verification failure. Check: `bin/overwatch doctor` reports `agent:fixer`.

**Time left and staging checks** need no trial: add `capacity` to a Datadog metric source and `promotion` to the app
(see [customizing.md](customizing.md)).

## 7. Back up and restore

```sh
bin/overwatch backup  --to ~/overwatch-backup.sqlite   # while running or not; never overwrites a file
bin/overwatch restore --from ~/overwatch-backup.sqlite # with the service stopped
```

Restore checks the backup (its identity, version and integrity) and rebuilds every row inside the existing
database in one transaction. Before it commits, the staged rows must satisfy every column constraint, every declared
reference between tables (a row naming a job, run, finding, evidence or problem that is not there) and the sequence
high-water mark (no row naming a seq the backup never issued). A copy that fails any of these is refused with exit 5
and the current data is left as it was. Values that are possible but wrong cannot be detected.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `serve` or `status` exits 3, "in use by another process" | Another Overwatch (or SQLite program) owns the database. Stop it. The message names the running service's address if it answers. |
| An environment is `signed_out` | Run the `fix` that `status` shows for the source (your cluster's login command and the `kubectl --context … get pods` check), then wait for the next probe; it resumes by itself. |
| `paused: "disk"` | Either less than 256 MiB is free next to the database, or the database holds more than 1 GiB that age cannot remove. Do what `pausedFix` in `status` says: free disk space or move `dataDir`. Nothing is written meanwhile (collection, failure records, page actions); the checkpoint waits and collection resumes by itself. |
| An environment is `stale` | A reading has not succeeded for three polling intervals: the service is not running, a read hangs, or the laptop slept. |
| `trial` exits 3 | Start `serve` first: the model calls the service's tools. |
| `install` exits 2 naming `env:` settings | Move those secrets to the keychain (step 2) and change the references to `keychain:`. |
| `install` or `restart` exits 3 | `launchctl` refused; its words are in the message. `launchctl print gui/$(id -u)/dev.overwatch.service` shows the job. |
| A notification is parked | It names its repair (usually: install `terminal-notifier` on the service's PATH). After a repair, parked notices are tried again by themselves; `POST /v2/notifications/<id>/retry` with a request key from `/v2/focus` tries one again now. |
| Investigations wait with "waiting for OpenCode" | OpenCode is down or erroring. Nothing failed: the work is kept and resumes when OpenCode answers. |
