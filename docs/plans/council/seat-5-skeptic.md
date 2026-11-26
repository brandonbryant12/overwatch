# Seat 5: the skeptic

### 1. Verdict
**Rewrite—an 80% amputation salvaging only pure source parsers, `kubectl` allowlists, and redaction ([kubernetes.ts:500](/Users/brandon/Development/overwatch/src/collect/sources/kubernetes.ts:500), [redact.ts:1](/Users/brandon/Development/overwatch/src/domain/redact.ts:1)).** Keeping or refactoring preserves `@alchemy.run/domain`, `effect`, and `foldkit`, whose seams manufactured the defects. Real diagnosis (initial C+ rests on [redesign-brief.md:66](/Users/brandon/Development/overwatch/docs/plans/redesign-brief.md:66); the three B− rounds are verified in [assessment.md](/private/tmp/ow-review.Oz72DF/assessment.md:1), [assessment.md](/private/tmp/ow-third.VEiE7u/assessment.md:1), [assessment.md](/private/tmp/ow-fourth.tzGCYw/assessment.md:1), and `git log`): the team played distributed-systems cosplay in a sandbox to avoid reality. Across 71 commits and 21,293 lines, zero tests touched GLM 5.3, `launchd`, Datadog, clusters, or a corporate proxy (constraints resting on [redesign-brief.md:32-40](/Users/brandon/Development/overwatch/docs/plans/redesign-brief.md:32)). Instead, the builder simulated Cloudflare Durable Objects over SQLite beside 16 plain tables, promised unbounded universal guarantees, and patched point counterexamples ([AGENTS.md:38](/Users/brandon/Development/overwatch/AGENTS.md:38)). An adversarial assessor testing universal claims can falsify patches forever: removing the 200-item cap (`e610710`) exposed a 500-ID overlap cap ([signals.ts:90](/Users/brandon/Development/overwatch/src/collect/signals.ts:90)) and `Math.max(...arr)` stack overflow ([collector.ts:276](/Users/brandon/Development/overwatch/src/service/collector.ts:276)). A rewrite stalls identically unless bounded limits replace universal guarantees and reality gates precede code.

### 2. Storage and state
Delete `@alchemy.run/domain`, [sqlite.ts:56](/Users/brandon/Development/overwatch/src/host/sqlite.ts:56), event sourcing, async views, command receipts, and `pending_reports` ([tables.ts:49](/Users/brandon/Development/overwatch/src/service/tables.ts:49)). Use one `node:sqlite` connection (`0600`) with synchronous `BEGIN IMMEDIATE` transactions over six tables (`watchers`, `incidents`, `events`, `runs`, `shown_evidence`, `notifications`) plus FTS5. Committing checkpoints and incident updates together eliminates collector outboxes, lagging views, private-key scraping (`bf:q-lease` in [sqlite.ts:439](/Users/brandon/Development/overwatch/src/host/sqlite.ts:439)), and deploy receipt fan-out. SHA-256-hash client idempotency keys at HTTP entry instead of running `redactText` on caller IDs ([safe.ts:14](/Users/brandon/Development/overwatch/src/domain/safe.ts:14)).

### 3. Counting occurrences
**Guarantee:** Exact deduplicated counts up to `1,000` occurrences per fingerprint per poll, streamed without occurrence arrays or `Math.max(...arr)` ([signals.ts:85](/Users/brandon/Development/overwatch/src/collect/signals.ts:85)); above `1,000`, record `1000+ (capped)`. Store overlap hashes `(watcher, source, hash, at)` in SQLite, pruned strictly by `at < checkpoint - overlapMs` rather than slicing at 500 ([signals.ts:90](/Users/brandon/Development/overwatch/src/collect/signals.ts:90)).
**Refuse:** Exact counts past `1,000` or beyond the 4 MiB pod-log cap ([kubernetes.ts:556](/Users/brandon/Development/overwatch/src/collect/sources/kubernetes.ts:556)). Triage never changes between 20,000 and 39,500 lines.

### 4. Order and time
**Guarantee:** Internal causal order via `events.seq INTEGER PRIMARY KEY AUTOINCREMENT`. Store `deferred_seq` on incidents; a deploy wakes `later_change` rows only when `deploy_seq > deferred_seq`, updating `WHERE disposition = 'later_change'` instead of comparing milliseconds ([incident.ts:347](/Users/brandon/Development/overwatch/src/domain/incident.ts:347)) or scanning every historical incident ([service.ts:459](/Users/brandon/Development/overwatch/src/service/service.ts:459)).
**Refuse:** Cross-system timestamp ordering across skewed cluster, Datadog, and laptop clocks.

### 5. One writer, upgrade, backup and restore
**One writer:** Guarantee via one permanent `<db>.lock` SQLite file tested solely by `BEGIN EXCLUSIVE`—never renamed across versions and never byte-sniffed (checking `"SQLite format 3"` on a 0-byte uncommitted lock caused the live split-brain in [lock.ts:53](/Users/brandon/Development/overwatch/src/host/lock.ts:53)).
**Upgrade:** Guarantee forward `PRAGMA user_version` SQL migrations only; refuse newer schemas cleanly.
**Backup/restore:** Keep `VACUUM INTO` backup; **refuse to build `overwatch restore`** ([backup.ts:57](/Users/brandon/Development/overwatch/src/service/backup.ts:57)). Validating hostile SQLite schemas (extra `NOT NULL` columns, inline `UNIQUE` autoindexes with `sql IS NULL`) wasted three rounds on `launchctl bootout && cp`.

### 6. Evidence
**Promise:** Provenance-tagged verbatim substring match: quote `Q` (≥12 chars, **no `...` ellipses**—ellipses caused missing-negation bugs in [citations.ts:41](/Users/brandon/Development/overwatch/src/collect/citations.ts:41)) appears verbatim in output `S` recorded from source `X` in run `R`.
**Refuse:** Promising that matched quotes prove causality or calibrated confidence. Delete `causeBasis: "observed"` ([citations.ts:142](/Users/brandon/Development/overwatch/src/collect/citations.ts:142)); display the matched raw line beside the hypothesis.

### 7. Code
**Promise:** Verify every cited `path:line` and quote via `git show <commit>:<path>` directly against the local repo's object store—**delete investigator worktrees** ([worktree.ts:40](/Users/brandon/Development/overwatch/src/service/worktree.ts:40)). Worktrees caused empty-dir `deployed=true`, untracked-file verification ([worktree.ts:67](/Users/brandon/Development/overwatch/src/service/worktree.ts:67), [citations.ts:111](/Users/brandon/Development/overwatch/src/collect/citations.ts:111)), and mid-session dirty files.
**Refuse:** Promising resolved tags match mutable cluster images, or letting an unproved weak model author auto-fix PRs.

### 8. The agent protocol for GLM 5.3 through OpenCode
The build assumes an unrun model (per [redesign-brief.md:38](/Users/brandon/Development/overwatch/docs/plans/redesign-brief.md:38)) copies `owt_...` tokens into every call ([worker.ts:73](/Users/brandon/Development/overwatch/src/service/worker.ts:73)), satisfies nested `FindingInput` schemas ([mcp.ts:76](/Users/brandon/Development/overwatch/src/service/mcp.ts:76)), quotes verbatim, and stops on command. Stop assuming:
1. Benchmark real GLM 5.3 in OpenCode on 10 seeded incidents *before* writing worker code.
2. Bind run tokens in per-run MCP URLs (`/mcp/<token>`), removing `token` from tool inputs.
3. Pre-fetch pod/log/commit excerpts in code; expose three flat tools (`read_logs`, `read_git_blob`, `submit_triage` with four flat fields).

### 9. The page
**Over-built:** 4,849 lines ([app.ts:1](/Users/brandon/Development/overwatch/web/src/app.ts:1), [views.ts:1](/Users/brandon/Development/overwatch/web/src/views.ts:1), [style.css:1](/Users/brandon/Development/overwatch/web/src/style.css:1)) bundled into `602 KB` minified JS ([app.js](/Users/brandon/Development/overwatch/web/dist/app.js)) running Foldkit/Effect in Chrome, duplicating routing ([app.ts:631](/Users/brandon/Development/overwatch/web/src/app.ts:631)), health rules ([app.ts:376](/Users/brandon/Development/overwatch/web/src/app.ts:376)), and ID generation (`crypto.randomUUID()` in [entry.ts:53](/Users/brandon/Development/overwatch/web/src/entry.ts:53) failed [safe.ts:14](/Users/brandon/Development/overwatch/src/domain/safe.ts:14) under UUID redaction).
**Must never do:** Compute health, mint domain IDs, advance clocks only when requests settle ([app.ts:978](/Users/brandon/Development/overwatch/web/src/app.ts:978)), or need a bundler. Stream server-computed state via SSE to ≤400 lines of plain JS with an independent `1s` `setInterval` staleness check (`Date.now() - lastOkAt > 30_000`).

### 10. Dependencies and installation
Dependencies bloated `node_modules` to **329 MB**. Beta `@alchemy.run/domain` (`2.0.0-beta.87`, undocumented host API) pulled `alchemy` and native `@rolldown/binding-*` binaries ([setup.md:48](/Users/brandon/Development/overwatch/docs/setup.md:48)), risking corporate-proxy blocks (per [redesign-brief.md:32](/Users/brandon/Development/overwatch/docs/plans/redesign-brief.md:32)) and forcing 759 lines of custom host/lock code ([sqlite.ts:1](/Users/brandon/Development/overwatch/src/host/sqlite.ts:1), [lock.ts:1](/Users/brandon/Development/overwatch/src/host/lock.ts:1), [connection.ts:1](/Users/brandon/Development/overwatch/src/host/connection.ts:1)). Cut `alchemy`, `@alchemy.run/domain`, `effect`, `@effect/platform-browser`, `foldkit`, and `rolldown` ([package.json:41-55](/Users/brandon/Development/overwatch/package.json:41)). Use Node 22 built-ins (`node:sqlite`, `node:http`) plus `@opencode/client` (or `fetch`): zero native binaries, zero build step.

### 11. Declared operating limits: the rubric
**Limits:** 1 user; macOS; ≤20 environments; ≤50 sources polling ≥60s; ≤1,000 counted occurrences/fingerprint/poll; ≤4 MiB logs/pod; one installed version; trusted local disk (`0600` SQLite; scrubbing covers standard `Bearer`/key-value/token shapes, not adversarial steganography).
**Checkable A rubric (within limits):**
- *Reality:* `overwatch doctor` passes behind the corporate proxy and under `launchd`; 48h laptop run survives sleep/wake and VPN drops with zero stuck watchers or false-green banners.
- *Model:* Real GLM 5.3 completes ≥8/10 seeded trials in ≤2 tries and names the seeded cause in ≥7/10.
- *Invariants:* Property + `SIGKILL` tests prove zero lost/duplicate incident transitions, monotonic `seq` order, exact counts ≤1,000, and staleness warning within 31s of hung `/status`.
- *Budget:* ≤3,500 LOC (`src/` + `web/`), zero native modules.

### 12. What to cut, and the smallest A-grade product
**Cut completely:** Auto-fix draft PRs, self-learning interviews/rule-proposals ([command-center.md:397](/Users/brandon/Development/overwatch/docs/plans/command-center.md:397)), second-session disproof ([challenge.pending.ts:1](/Users/brandon/Development/overwatch/test/pending/challenge.pending.ts:1)), `overwatch restore`, cross-environment clustering, investigator worktrees, and custom theme builders.
**Smallest A-grade product:** `launchd`-safe poller (`kubectl`, Datadog, GitHub deploys) → single SQLite file → truthful environment strip + keyboard inbox (`Done`, `Later`, `Never`, Undo, FTS5 search) → context-packed OpenCode/GLM 5.3 triage + focused prompting → copyable plain-English status brief.

### 13. The method
**Key change:** Reality-first gating and frozen bounds before feature code—end unbounded adversarial testing against fakes.
**Order/size:** Pass 0 (≤300 LOC): `doctor` + 10-case GLM 5.3 `trial` on the real laptop. Pass 1 (≤900 LOC): SQLite store, collectors, CLI status. Pass 2 (≤700 LOC): zero-build SSE page. Pass 3 (≤800 LOC): OpenCode worker, MCP, briefs.
**Tests/acceptance:** Before each pass, the assessor writes bounded property tests strictly within §11's limits; out-of-bounds inputs need only fail safely without crashing. Builder codes until green; zero mid-pass additions. **Stop:** Halt if Pass 0 fails on GLM 5.3/proxy, or two consecutive gradings stall.

### 14. The single biggest risk in my proposal
Pass 0 may prove on Day 1 that GLM 5.3 (unrun per [redesign-brief.md:38](/Users/brandon/Development/overwatch/docs/plans/redesign-brief.md:38)) cannot reliably triage incidents even with pre-fetched excerpts and flat tools—forcing Overwatch to demote agents to optional chat helpers and disappointing the owner's autonomous-triage vision ([redesign-brief.md:10-14](/Users/brandon/Development/overwatch/docs/plans/redesign-brief.md:10)) immediately.
