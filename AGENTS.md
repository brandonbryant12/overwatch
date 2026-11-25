# Agent guide

Overwatch is an OpenCode 2 plugin (one package, server part only). Read `README.md` for what it does and
`docs/configuration.md` for every option.

## Setting Overwatch up for someone

Configuration lives only in the user's own OpenCode config, never in this repository. Do not commit names, paths,
contexts, queries or credentials from anyone's environment.

1. Find the user's global OpenCode config (`~/.config/opencode/opencode.json` or `.jsonc`). Show them the change before
   writing it, and keep everything else in the file as it is.
2. Ask which apps to watch. For each, get the local checkout path (`git -C <path> remote -v` confirms it), the base
   branch, and the commands that prove a change is safe (`verify`). Leave `verify` empty if they do not want draft
   pull requests.
3. For each environment, find the sources:
   - Kubernetes: `kubectl config get-contexts` and `kubectl --context <c> get deploy -n <ns> --show-labels` to pick the
     context, namespace and pod selector. Read-only commands only; never apply, delete, scale or exec.
   - Datadog: the log query and indexes the user already searches with, and monitor tags. Monitor definitions often
     live in the app's repository; read them to pick tags. Ask the user to store the API and application keys in the
     keychain themselves (`security add-generic-password -s overwatch -a datadog-api-key -w`) and reference them as
     `keychain:overwatch/datadog-api-key`. Never ask for, print or write a key.
   - CI: `gh run list` inside the checkout shows whether `gh` is logged in and which workflows exist.
   - How the deployed commit can be read: an image tag that is a commit, a pod label, or a version endpoint
     (`deployedCommit`).
4. Add one watcher per app and environment they care about, with `every` and any skills they use for debugging (list
   skills with the OpenCode skill picker or look in `~/.config/opencode/skills`, `~/.claude/skills`,
   `~/.agents/skills`).
5. Validate: in a session run `/overwatch`. Configuration errors are listed there. Then `/overwatch-run <app/env>` and
   read the coverage lines; a source that cannot connect says why.
6. If a skill needs a shell command the investigator is not allowed to run, add a narrow rule under
   `permissions.investigator` rather than widening anything else.

## Working on the code

- Node 22.6 or newer and pnpm. `pnpm install`, then `pnpm run check` (typecheck and tests) before every commit. Both must
  pass. Bun is not a dependency of anything here: the plugin, the tests and the scripts use only Node's standard
  library, and people who use this cannot install Bun. Do not add `bun:` imports, `Bun.*` calls or a `bun.lock`.
- Tests run on Node's built-in runner; `test/harness.ts` supplies `describe`, `test` and `expect`. Source is TypeScript
  that Node can run by stripping types, so no enums, namespaces or parameter properties (`erasableSyntaxOnly`).
- `OPENCODE_BIN=<opencode 2 binary> pnpm run smoke` loads the plugin into a real, isolated OpenCode server. Run it after
  changing anything in `src/index.ts`, `src/investigate.ts`, the prompts, or how the plugin uses the OpenCode API.
  The npm package `@opencode/cli-<platform>` carries the binary.
- Target the OpenCode 2 plugin API as documented for the release in `package.json` (`@opencode/plugin`). Import only
  types from it; the plugin has no runtime dependencies.
- Keep the design small: no daemon, no database of its own (use plugin storage), no UI, no framework.
- Rules that must hold, with tests that pin them:
  - Kubernetes is reached only through `kubectl get|describe|logs|top` with the configured context and namespace.
  - Limits and capacity are read from the cluster, never assumed.
  - No spend tracking or caps; only timeouts and concurrency limits.
  - Watchers query since their checkpoint, never a fixed window; checkpoints advance only past successful slices; the
    lookback cap is reported when it truncates.
  - One breach, one incident.
  - Report limits are enforced by `validateFinding`, not only described in the prompt.
  - Pull requests are drafts, opened by plugin code after verify passes; agents cannot push or call `gh`.
  - An investigator's directory is a worktree of its own or an empty directory, never the app's checkout.
  - A source that fans out (one call per pod) bounds its calls and its time and reports what it left unread; one
    unreadable pod never fails a slice, and nothing a slice does can stop its checkpoint from ever moving.
  - JSON from `kubectl` and Datadog is read through `src/tolerant.ts`; a missing or mistyped field costs that field.
  - Stored records go through `readRecord` and `writeRecord` in `src/store.ts`, which carry the schema version.
    Changing a record's shape means bumping `SCHEMA_VERSION` and adding a migration.
  - Citations are checked by `src/citations.ts`, not by a model, before a finding is stored.
  - Text that reaches an agent or a report is redacted, by name and by how random the value looks.
- Tests use fakes for `kubectl`, `gh`, Datadog and the model. Never call a real cluster, Datadog or repository host
  from a test.
- Sources are added by implementing `SourceType` in `src/sources/` and registering it in `src/sources/index.ts`.
