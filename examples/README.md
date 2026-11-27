# Starter Configurations

Ready-to-adapt templates for forking Overwatch into a corporate environment with local GPU inference (OpenCode + GLM 5.3).

| File | Purpose |
| --- | --- |
| [corp-base.json](corp-base.json) | Shared corporate base config committed in your internal fork: `redactPatterns`, Datadog slow-`spans` detection, `commitWatch`, 5-angle local GPU `opencode` tuning (`concurrency: 4`, `toolCalls: 16`, `genUi: true`), human-in-the-loop `fixes.mode: "propose"` for production, and opt-in human-on-the-loop `fixes.mode: "draft_pr"` for a staging worker. |
| [personal-override.json](personal-override.json) | Per-engineer laptop config using `"extends": "./corp-base.json"` to override local `checkout` paths, `dataDir`, `mcpToken`, and personal `watchers`. |
| [opencode-glm53.json](opencode-glm53.json) | OpenCode 2.4.1 configuration wiring a local GPU GLM 5.3 provider, Overwatch's four least-privilege agent roles (`ow-investigator`, `ow-challenger`, `ow-responder`, `ow-fixer`), and the remote `/mcp` server (`ow`) for both background agents and your own interactive OpenCode sessions. |

## Quickstart (5 Minutes)

1. **Copy and adapt the corporate base** inside your fork (adjust cluster contexts, namespaces, Datadog `baseUrl`/queries, and `redactPatterns`):
   ```sh
   mkdir -p ~/.config/overwatch
   cp examples/corp-base.json ~/.config/overwatch/corp-base.json
   cp examples/personal-override.json ~/.config/overwatch/config.json
   ```
   *(In a real corporate fork, point `"extends"` in `~/.config/overwatch/config.json` directly at your fork's tracked `corp-base.json` path so `git pull` updates shared rules automatically.)*

2. **Store secrets in macOS Keychain** (required for `launchd`):
   ```sh
   security add-generic-password -s overwatch -a mcp-token -w
   security add-generic-password -s overwatch -a opencode -w
   security add-generic-password -s overwatch -a dd-api -w
   security add-generic-password -s overwatch -a dd-app -w
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

For the full fork & rebase architecture, custom source adapters, and proxy/airgap details, read [docs/forking.md](../docs/forking.md).
