# Starter Configurations

Ready-to-adapt templates for forking Overwatch into a corporate environment with local GPU inference (OpenCode + GLM 5.3), per-environment policies, and read-only database inspection.

| File | Purpose |
| --- | --- |
| [corp-base.json](corp-base.json) | Shared corporate base config committed in your internal fork: `redactPatterns`, Datadog slow-`spans` detection, `commitWatch`, 5-angle local GPU `opencode` tuning (`concurrency: 4`, `toolCalls: 16`, `genUi: true`), per-environment `policy` overrides (`prod-us-east` critical human-in-the-loop `"propose"`, `staging` quiet `"draft_pr"`, `dev` watch-only `"off"`), and read-only `databases` (`postgres` named queries with `allowSelect: false` on prod, `allowSelect: true` on staging, and `sqlite` on dev). |
| [personal-override.json](personal-override.json) | Per-engineer laptop config using `"extends": "./corp-base.json"` (supports relative and `~/` paths) to override local `checkout` paths, `dataDir`, `mcpToken`, personal `watchers`, per-env policy tuning (e.g. raising prod `readings` to `5` on local GPU), and replacing inherited `env:` DB DSNs with `keychain:` references for `launchd`. |
| [opencode-glm53.json](opencode-glm53.json) | OpenCode 2.4.1 configuration wiring a local GPU GLM 5.3 provider, Overwatch's four least-privilege agent roles (`ow-investigator`, `ow-challenger`, `ow-responder` with `ow_ow_db` allowed; `ow-fixer` with `ow_ow_db` explicitly denied), and the remote `/mcp` server (`ow`) for both background agents and your own interactive OpenCode sessions. |

## Quickstart (5 Minutes)

1. **Copy and adapt the corporate base** inside your fork (adjust cluster contexts, namespaces, Datadog `baseUrl`/queries, `databases`, and `redactPatterns`):
   ```sh
   mkdir -p ~/.config/overwatch
   cp examples/corp-base.json ~/.config/overwatch/corp-base.json
   cp examples/personal-override.json ~/.config/overwatch/config.json
   ```
   *(In a real corporate fork, point `"extends"` in `~/.config/overwatch/config.json` directly at your fork's tracked base config — `~/` expansion is supported, e.g. `"extends": "~/src/corp-overwatch/examples/corp-base.json"` — so `git pull` updates shared rules automatically.)*

2. **Store secrets in macOS Keychain** (required for `launchd`; `overwatch install` inspects the merged `extends` config and refuses any remaining `env:` secrets, including inherited database `dsn` values):
   ```sh
   security add-generic-password -s overwatch -a mcp-token -w
   security add-generic-password -s overwatch -a opencode -w
   security add-generic-password -s overwatch -a dd-api -w
   security add-generic-password -s overwatch -a dd-app -w
   security add-generic-password -s overwatch -a checkout-ro-dsn -w
   security add-generic-password -s overwatch -a checkout-staging-ro-dsn -w
   ```

3. **Connect OpenCode & install the owner skill**:
   - Merge `examples/opencode-glm53.json` into `~/.config/opencode/opencode.json` (replace `REPLACE_WITH_OW_MCP_TOKEN` with your `mcp-token` value).
   - Copy `skills/overwatch/` into `~/.config/opencode/skills/overwatch/`.

4. **Validate, start, diagnose, and calibrate**:
   ```sh
   bin/overwatch check   --config ~/.config/overwatch/config.json
   bin/overwatch install --config ~/.config/overwatch/config.json
   bin/overwatch doctor  --config ~/.config/overwatch/config.json
   bin/overwatch trial --fixes --config ~/.config/overwatch/config.json
   ```

For the full fork & rebase architecture, per-environment policy cascade, `ow_db` safety boundaries, and corporate fork recipes, read [docs/forking.md](../docs/forking.md).
