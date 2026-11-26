# Seat 4: the operator

1. **Verdict: rewrite the core, keep the edges.** Rewrite the host, domain layer, collector persistence, and web app; keep and refactor only the parsers, command allowlists, and redaction in [kubernetes.ts](/Users/brandon/Development/overwatch/src/collect/sources/kubernetes.ts), [datadog.ts](/Users/brandon/Development/overwatch/src/collect/sources/datadog.ts), and [redact.ts](/Users/brandon/Development/overwatch/src/collect/redact.ts). Four gradings proved the defects live at framework seams: `@alchemy.run/domain`’s Durable Object emulator ([sqlite.ts](/Users/brandon/Development/overwatch/src/host/sqlite.ts)), lagging async views, millisecond clocks ignoring journal order, `@rolldown/binding-*` native binaries, and Foldkit’s `Stream.mapEffect` masking hung refreshes ([app.ts:1048](/Users/brandon/Development/overwatch/web/src/app.ts:1048)). Delete `alchemy`, `@alchemy.run/domain`, `rolldown`, `effect`, and `foldkit` for one zero-dependency Node ≥22.13 process (`node:sqlite` + `node:http`) with synchronous transitions and unbundled ES modules.

2. **Storage and state.**
One SQLite file (`~/.local/share/overwatch/overwatch.sqlite`, `WAL`, `synchronous=FULL`, `foreign_keys=ON`, `application_id=0x4F574348`, `user_version`). Drop `objects` and `pending_reports` ([collector.ts:372](/Users/brandon/Development/overwatch/src/service/collector.ts:372)): one `BEGIN IMMEDIATE` commits events, `incidents`, `source_cursors`, `seen_ids`, and `coverage` together. Tables surviving crash, sleep, and upgrade:
- `events(seq INTEGER PRIMARY KEY, at_ms, kind, subject, cmd_id UNIQUE, json)`
- `incidents(id PK, app, env, fp, severity, status, way_seq, count, count_exact, first_at, last_at, sample)` — indexed on `(app,env,status)`
- `source_cursors(watcher, source, cursor_at, fail_kind, streak, next_at, suspended_at, last_error, revisions, PK(watcher,source))`
- `seen_ids(watcher, source, id_hash BLOB, at_ms, PK(watcher,source,id_hash)) WITHOUT ROWID`
- `coverage(id PK, watcher, source, from_ms, to_ms, state, note)`, `runs`, `evidence_blobs`, `notifications`.

3. **Counting occurrences under replay, crash, late data and an error storm.**
Stream `kubectl logs` via `node:readline`—never `stdout += chunk` ([exec.ts:45](/Users/brandon/Development/overwatch/src/collect/exec.ts:45)) or `Math.max(...array)` ([collector.ts:276](/Users/brandon/Development/overwatch/src/service/collector.ts:276)). On `killed || code !== 0` or `4 MiB`, drop any unterminated trailing line. Floor `--since-time` to whole seconds and keep raw RFC3339Nano strings (fixing `Date.parse` ms truncation in [kubernetes.ts:504](/Users/brandon/Development/overwatch/src/collect/sources/kubernetes.ts:504)). Compute 16-byte `id_hash` pre-redaction: `sha256(pod\0container\0raw_nano_ts\0same_ts_ordinal\0sha256(line))[0..15]` (Datadog: `sha256(event.id)[0..15]`). Reject `at_ms > now + 5m` as `invalid_ts`.
Poll `[prev_cursor - overlap_ms, now]` (`2m` K8s, `5m` Datadog), oldest-first, max `50,000` occurrences (`~2.4 MiB` flat RAM; `<=500` fingerprints, extras -> `<source>:storm_overflow`). In one `BEGIN IMMEDIATE`: (1) deduplicate `[prev_cursor - overlap_ms, prev_cursor]` against `seen_ids` and `(prev_cursor, new_cursor]` via in-memory `Set`; (2) `INSERT OR IGNORE` counted `id_hash`es `>= new_cursor - overlap_ms` into `seen_ids` (cap `100,000` rows, `~4 MiB`/source); (3) `DELETE FROM seen_ids WHERE at_ms < new_cursor - overlap_ms`. Replaying 20,000 lines adds `0`. Hitting `4 MiB`, `50,000`/poll, or `100,000` `seen_ids` sets `count_exact=0` (`"50,000+ (capped)"`), marks `coverage='capped'`, and advances `cursor_at` so watchers never wedge.

4. **Order and time.**
- **`events.seq`** decides "before/after". `Later (until change)` saves `way_seq=seq`; a deploy at `deploy_seq` wakes `WHERE app=? AND env=? AND status='later_change' AND way_seq<deploy_seq`—fixing ms ties ([incident.ts:347](/Users/brandon/Development/overwatch/src/domain/incident.ts:347)) and O(history) fan-out ([service.ts:459](/Users/brandon/Development/overwatch/src/service/service.ts:459)).
- **`performance.now()`** drives timeouts, backoffs, and ticks. A wall-vs-monotonic jump `>15s` or `networkInterfaces()` diff waits `3s` for VPN/DHCP settle, then probes failing connections.
- **`Date.now()`** slices windows; if `Date.now()<cursor_at`, hold `cursor_at` (`"Clock behind checkpoint by Xs"`).

5. **One writer, upgrade, backup and restore.**
- **Lock**: Hold `PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS l(v); INSERT INTO l VALUES(1);` on `overwatch.lock.sqlite` (non-empty file closes [lock.ts:53](/Users/brandon/Development/overwatch/src/host/lock.ts:53)’s 0-byte bypass); also probe legacy `.lock`/`.writer` regardless of size. Write advisory `overwatch.holder.json`.
- **Upgrade**: `serve` refuses if locked (`"Overwatch 0.3.0 (pid 4182) owns overwatch.sqlite. Run 'overwatch restart'."`). `restart` runs `launchctl kickstart -k gui/$(id -u)/dev.overwatch.service` (or `SIGTERM` + 10s wait). Startup writes `pre-v<N>.bak` via `VACUUM INTO`, migrates forward, and refuses downgrades (`user_version > SCHEMA_VERSION`).
- **Restore**: Locks `overwatch.lock.sqlite`, stages copy, checks `application_id`, `user_version`, `integrity_check`, `foreign_key_check`, and **exact `sqlite_master` DDL** across all objects ([backup.ts:36](/Users/brandon/Development/overwatch/src/service/backup.ts:36)), removes `-wal`/`-shm`, and `renameSync`s.

6. **Evidence.**
Store redacted source/git outputs (`<=24 KiB`) in `evidence_blobs(sha256 PK, run_id, source, query, from_ms, to_ms, created_at, text)`, never brief/prompt/args. `file_finding` checks quotes solely against `(run_id, source)` blobs or files in the run’s immutable worktree SHA, embedding matched quotes + `sha256` + query in `events`. Expire unreferenced blobs at **14d**, open/`real` at **90d**, cap **200 MiB**.

7. **Code.**
Never touch the mutable checkout. Resolve `deploy.ref` via `git -C <checkout> rev-parse --verify <ref>^{commit}`, else `git -C <checkout> fetch --quiet --no-tags origin <ref>` (`15s`, `GIT_TERMINAL_PROMPT=0`, `FETCH_HEAD` only). Detach `dataDir/worktrees/<sha12>`, requiring `HEAD===sha` and `git status --porcelain --untracked-files=all === ""` ([worktree.ts:67](/Users/brandon/Development/overwatch/src/service/worktree.ts:67)); clean/reset on mismatch. Stamp `code_state`: `deployed_exact`, `rollout_mixed` (both SHAs), `fallback_origin_base` (`origin/<baseBranch>`, `"NOT deployed code"`), or `no_code`. New deploy SHA starts a new session/worktree (`<=10`, `7d` TTL).

8. **The agent protocol for GLM 5.3 through OpenCode.**
*(Guessing GLM 5.3 is slower and error-prone on nested schemas/tokens.)* Expose 3 flat MCP tools (`query_telemetry`, `git_history`, `file_finding`) bound by `_meta["ai.opencode/sessionID"]`, a 6-field flat finding schema (no confidence), and caps of `8` tool calls / `3` rejected filings. Concurrency `1` (`<=20` queued; excess non-prod -> `skipped_queue_full`). Offline OpenCode pauses queue without timeout decay under one `Needs you` item. Poll every `5s` (`5s` timeout; cursors `<=128` ASCII chars): `3m`/turn, `15m`/run while active; inactive without `idle` for `20s` post-restart gets one `RESUME` nudge, then fails.

9. **The page.**
Run an independent `1s` `performance.now()` timer beside `fetch("/status", { signal: AbortSignal.timeout(4000) })` every `5s` ([app.ts:1048](/Users/brandon/Development/overwatch/web/src/app.ts:1048)). Past `15s` unsettled, strip green `"Checked, quiet"` badges for amber `"Stale: last heard Xs ago — health unknown"`. Past `30s` or 2 failures, show red `"Service down on 127.0.0.1:7450 — run: overwatch status or launchctl kickstart -k gui/$(id -u)/dev.overwatch.service"`, dim cached rows, disable dispositions, and save drafts in `localStorage`. Stuck rollouts (`>15m` or `Progressing=False`) show `"Rollout stuck (X/Y pods)"`.

10. **Dependencies, locked-down install, and `launchd`.**
Zero runtime npm dependencies, zero native binaries: strip browser TS via Node 22.13’s `module.stripTypeScriptTypes` (no `rolldown`). `launchd install` reads `$KUBECONFIG` `users[].user.exec.command` *(guessing EKS/GKE/OIDC helpers like `kubelogin`/`gcloud`)*, pins absolute paths for `kubectl`, auth helpers, `git`, `gh`, `security`, `osascript`, and copies `PATH`, `KUBECONFIG`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`. Spawn CLIs with `stdin:"ignore"`, `GIT_TERMINAL_PROMPT=0`. Probe **one canary `kubectl` call per `context`** before pod fan-out so expired SSO never pops 20 browser tabs; suspend after 1 retry. Rotate `service.log` in-process (`10 MiB × 3`).

11. **Declared operating limits.**
- **Fleet**: `<=15` envs, `<=40` sources, poll `>=60s`, `2` watchers / `4` `kubectl` calls concurrent -> `check` rejects.
- **Pod logs**: `<=20` pods, `4 MiB`/pod, `30s`/call, `120s`/slice -> `coverage='capped'`, `count_exact=0`, `"Checked (capped)"`.
- **Bursts**: `<=50,000` occurrences/poll (`~3 MiB` RAM), `<=100,000` `seen_ids`/source (`~4 MiB` DB), `<=500` fingerprints -> `storm_overflow`, `count_exact=0`, advance cursor.
- **Lookback**: `<=72h` in `6h` slices -> older span becomes `coverage='gap'`.
- **Datadog 429**: inline `<=30s` (2 tries); else `next_at=now+reset` (`<=30m`), cursor unmoved.
- **Disk**: DB `<=1 GiB`, blobs `<=200 MiB`, logs `<=30 MiB`, free `>=256 MiB` (`statfsSync`) -> prune blobs/worktrees; `<256 MiB` pauses writes (`"Disk low (<256 MiB): collection paused"`).

12. **What to cut, and the smallest A-grade product.**
Cut Alchemy, Effect, Foldkit, Rolldown, auto-fix PRs/background tests, Jenkins/GitHub sources, rule builders, challenge sessions, spans, playbooks, and model confidence. **Smallest A-grade product**: honest K8s + Datadog watching, truthful fleet strip, `Done/Later/Never` inbox with undo, citation-verified read-only GLM 5.3 investigations on exact deployed worktrees, and instant OpenCode handoff.

13. **The method.**
- **Gate 1 (offline)**: `<4,000`-line SQLite core passing property + `SIGKILL` tests across real limits (`0`, `501`, `50,000`, `250,000` lines; same-ms deploy/defer; 0-byte/legacy locks; canonical DDL restore; hung `/status` clock).
- **Gate 2 (`overwatch doctor` on the real Mac)**: Verifies proxy install, `launchd` `PATH` + kubeconfig `exec` helpers, keychain under `launchctl`, live `kubectl`/Datadog, `osascript` exit code, sleep/wake, and `overwatch restart`.
- **Gate 3 (`overwatch trial`)**: Scores 15 seeded incidents on live GLM 5.3 before enabling `autoInvestigate`.

14. **Single biggest risk in this proposal.**
**Cry-wolf staleness ("perpetual amber")**: on clusters lacking `metrics-server` (`kubectl top` 403/404) or noisy pods hitting `4 MiB`, strict `"never green when incomplete"` leaves the strip permanently non-green unless unsupported metrics are opt-out per environment and `"Checked (partial)"` looks distinct from `"Stale/Down"`.
