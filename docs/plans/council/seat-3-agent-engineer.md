# Seat 3: the agent engineer

### 1. Verdict
**Rewrite the agent and orchestration layer; keep only collector parsers, redaction, and safe `git`/`kubectl` builders.** `@alchemy.run/domain` ([mcp.ts:13](src/service/mcp.ts:13), [policies.ts:14](src/domain/policies.ts:14)) splits one job across lagging views and three aggregates while `toMcp` drops `_meta["ai.opencode/sessionID"]`. Worse, substring-matching model-copied quotes ([citations.ts:49](src/collect/citations.ts:49)) against mutable worktrees ([worktree.ts:40](src/service/worktree.ts:40)) was bypassed four ways and punishes open-weights GLM 5.3 whenever punctuation drifts while passing cherry-picked words. Replace both with a synchronous `node:sqlite` job state machine, service-minted evidence handles, checkout-free git-object reads, and parallel ensemble-plus-challenger runs powered by free local tokens.

### 2. Storage and state
Plain `node:sqlite` tables owned by one state machine:
- `agent_jobs(job_id PK, subject_id, kind, status, target_seq, repo, commit_sha, deployed, result_json, created_seq, updated_seq)` — `kind: triage|ask|fix|brief`; `status: queued|running|settled|parked`.
- `agent_runs(run_id PK, job_id, role, slot, session_id UNIQUE, prompt_msg_id, status, steps, tries, output_json, error, sent_at, finished_at)`.
- `evidence_atoms(atom_id PK, job_id, session_id, handle, kind, source, commit_sha, deployed, locator, content, sha256, at, UNIQUE(session_id, handle))` — immutable `telemetry|git_blob|git_history` chunks assigned `E1..En` *before* reaching the model.
- `findings(finding_id PK, job_id, subject_id, finding_json, created_seq)`, `owner_asks(ask_id PK, subject_id, job_id, ask_json, status, answer)`, `fix_attempts(job_id PK, branch, head_sha, verify_ok, pr_url)`.

### 3. Counting occurrences
Agents never count or deduplicate. Briefs pass exact SQLite integers (`window_count`, `total_count`, `rate_per_min`); `ow-scribe` rejects drafts containing digits absent from input facts.

### 4. Order and time
Order jobs, deploys, and dispositions by monotonic `journal_seq INTEGER PRIMARY KEY AUTOINCREMENT`, never milliseconds. Pin `target_seq` and `commit_sha` when queuing `agent_jobs`; if a newer deploy lands before settlement, code flags `superseded = true` and forces fresh follow-up sessions. Count timeouts from `sent_at`, excluding offline queue wait ([worker.ts:170](src/service/worker.ts:170)).

### 5. One writer, upgrade, backup and restore
Only the lock-holding daemon dispatches runs, persisting deterministic `session_id`, `prompt_msg_id`, and branch `overwatch/fix-<subject>-<sha8>` before I/O. After crash or upgrade, `sent` runs reconcile via `opencode.message.list` ([opencode.ts:125](src/service/opencode.ts:125)); partial fix worktrees are wiped and rebuilt. On `restore`, `sent` jobs enter `reconcile_only`, checking OpenCode messages and `gh pr list --head <branch>` before re-sending so sessions and PRs never duplicate.

### 6. Evidence
Delete substring quote matching ([citations.ts](src/collect/citations.ts)). Agents never supply quotes or source names. Read tools split redacted output into bounded records, insert `evidence_atoms`, and return `[E1] ...`, `[E2] ...`. Owner questions, Overwatch summaries, prior conclusions, and tool arguments mint **zero** atoms and have no handle to cite. Agents submit handle IDs (`["E3","E9"]`); code resolves `(session_id, handle)` into:
```ts
type Atom = { id: string; kind: "telemetry"|"git_blob"|"git_history"; source: string; sha: string|null; deployed: boolean; loc: string; text: string; sha256: string };
type Finding = {
  verdict: "real"|"not_real"|"unsure";
  basis: "observed"|"inferred"; // code-set: real + upheld + verified atoms
  agreement: { runs: number; matched: number; challenge: "upheld"|"disproved"|"weakened"|"skipped" };
  cause: string;
  claims: Array<{ statement: string; atoms: Atom[] }>;
  dissent: string|null;
  ruledOut: string[];
  notChecked: string[]; // code-unioned with collector coverage gaps
  nextCheck: string;
  product?: { impact: string; affected: string; since: string; status: string };
};
```
Unknown handles fail validation with valid `E1..En` listed.

### 7. Code
Delete investigation worktrees ([worktree.ts](src/service/worktree.ts)). Read-only sessions need **no repo filesystem**: set OpenCode `location.directory` to one empty `0555` directory `<dataDir>/sandbox` (avoiding per-directory `Location`/MCP instances and 60-minute unloads, [command-center.md:743](docs/plans/command-center.md:743)) and deny built-in `read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `cd`. MCP reads immutable objects via `git --git-dir=<repo>/.git` (`git grep <sha>`, `git show <sha>:<path>`), stamping `deployed = (sha === deployed_sha)`. Untracked files, dirty checkouts, `pods` filename collisions, and mid-session drift cannot exist inside a commit object. Only `ow-fixer` gets ephemeral detached `<dataDir>/fix/<job_id>`, removed on completion.

### 8. The agent protocol for GLM 5.3 through OpenCode
- **Auth**: Drop `owt_*` prompt tokens ([worker.ts:71](src/service/worker.ts:71)). OpenCode injects `_meta["ai.opencode/sessionID"]` ([client.ts:942](/private/tmp/claude-501/-Users-brandon-Development/68b623d9-d83a-4e8e-a030-6fae89e4c754/scratchpad/src/opencode/packages/core/src/mcp/client.ts:942)); MCP authorizes the active `agent_runs` row for `sessionID` (*guessing* GLM 5.3 corrupts echoed tokens across multi-step turns).
- **Roles & tools** (hard-capped by OpenCode `Agent.Info.steps`, [llm.ts:266](/private/tmp/claude-501/-Users-brandon-Development/68b623d9-d83a-4e8e-a030-6fae89e4c754/scratchpad/src/opencode/packages/core/src/session/runner/llm.ts:266)):
  - `ow-investigator` (`steps: 8`): Runs **$3\times$ in parallel** (telemetry-first, diff-first, benign-cause-first). Tools: `ow_read_telemetry({ source, since?, until?, args? })`, `ow_search_code({ pattern, pathPrefix? })`, `ow_read_code({ path, fromLine, toLine })`, `ow_read_git({ op: "log"|"show"|"blame"|"diff", ref?, path?, fromLine?, toLine? })`, `ow_submit_finding({ verdict, cause, claims: [{ statement, evidenceIds }], ruledOut, notChecked, nextCheck })`.
  - `ow-challenger` (`steps: 6`): Triggered when $\ge 2/3$ vote `real`; attempts falsification via `ow_read_*` and `ow_submit_challenge({ outcome: "upheld"|"disproved"|"weakened", counterEvidenceIds, reason })`.
  - `ow-scribe` (`steps: 2`, no read tools): Applies `local/glossaries/<app>.json` via `ow_submit_product({ impact, affected, since, status })`.
  - `ow-fixer` (`steps: 12`, worktree): OpenCode `read`/`glob`/`grep`/`edit` + `ow_run_verify({})` + `ow_propose_fix({ summary })`.
- **Retries & synthesis**: Bad schemas/handles return exact field errors (`2` retries); idle-without-submit gets `1` nudge; $\ge 2$ finished explorers settle in code (`2+/3 real` + `upheld` $\to$ `real`; `disproved` with counter-atom $\to$ `not_real`; `2+/3 not_real` $\to$ `not_real`; else `unsure` keeping `dissent`).
- **Owner & fixes**: `ow_ask_owner({ question, options, recommended, holdsUp })` (max `1` open/subject) escalates contested severe triage. Owner sessions get `ow_inbox({})`, `ow_incident({ id })`, `ow_search({ text })`, `ow_act({ id, disposition, correction? })`, and `ow_start_fix({ id })`, seeded with code-built handoffs. Auto-fixes attempt *only* clean deploy reverts or single-file config/guard regressions with `deployed: true` atoms; service code enforces $\le 3$ files / $\le 120$ lines (denying `.env`/CI/auth), runs `verifyCommand` itself, pushes, and opens a `--draft` PR.
- **Trial (`overwatch trial`)**: Blinded 25-seed live benchmark (bugs, benign noise, pre-deploy errors, missing code, log prompt-injections). Auto-triage unlocks at $\ge 95\%$ valid-submit, $0\%$ injection compliance, $\le 10\%$ false-`real`, $\ge 80\%$ verdict accuracy; auto-PR unlocks at $100\%$ verify-clean diffs across 10 fix seeds.

### 9. The page
Omit model confidence words. Display empirical provenance (`3/3 agreed · Challenger upheld · 3 atoms @ a1b2c3d deployed`, `Split 2/3`, `Disproved`, `HEAD fallback`), expandable verbatim `evidence_atoms`, live stage (`Exploring 2/3 · step 5/8`, `Waiting for OpenCode`, `Parked`), **Open in OpenCode**, and **Correct finding** (`local/playbooks/<app>.md`).

### 10. Dependencies and installation
Delete the JS plugin ([index.ts](src/plugin/index.ts)). OpenCode 2 natively loads `~/.config/opencode/opencode.json` `mcp.servers.overwatch` (`type: "remote"`, `oauth: false`, `codemode: false`), `~/.config/opencode/agents/ow-*.md` (`steps` + deny-by-default `permissions`), and `~/.config/opencode/skills/overwatch/SKILL.md` ([normalize.ts:288](/private/tmp/claude-501/-Users-brandon-Development/68b623d9-d83a-4e8e-a030-6fae89e4c754/scratchpad/src/opencode/packages/core/src/config/normalize.ts:288)). Zero `@opencode/plugin` coupling; loads identically everywhere.

### 11. Declared operating limits for agent work
- **Concurrency**: `2` active jobs (`6` sessions); excess queues by `(tier, severity, journal_seq)`; post-sleep bursts >`10` incidents collapse into one digest.
- **Turns/retries**: `8`/`6`/`2`/`12` steps by role, `2` submit retries, `1` nudge, `1` fresh-session retry $\to$ `parked`.
- **Time**: `180s`/run (`600s` fixer) from `sent_at` $\to$ `session.interrupt` + fail.
- **Sizes**: `16 KB` / `100` atoms per call (`400`/session), `6 KB` brief, `3` files / `120` diff lines $\to$ truncation marker or refused fix.

### 12. What to cut, and what the smallest A-grade product is
**Cut**: `@alchemy.run/domain`, `toMcp`, JS plugin, quote matching, investigation worktrees, `owt_*` tokens, model `confidence`, general bug PRs, merge-review agents, self-editing rules. **Smallest A**: `3x ow-investigator` + `ow-challenger` + `ow-scribe` over `evidence_atoms` and git-object reads, `doctor` + `trial` passed on GLM 5.3, static OpenCode MCP/skill config, playbook corrections, and verify-gated revert draft PRs.

### 13. The method
Dev machine: `fast-check` properties proving untagged text never enters `Finding.claims`; an adversarial OpenAI-compatible mock ([scripted-provider.ts](test/pending/scripted-provider.ts)) fuzzing malformed JSON, bogus handles, step-cap rambling, prompt-injected logs, and OpenCode restarts; plus smoke runs on a local small open-weights model (*guessing* similar tool-call quirks). Work laptop: `overwatch doctor --json` and `overwatch trial --cases seeds.json --json` gate automation.

### 14. The single biggest risk in your own proposal
**Private GLM 5.3 endpoint queuing and tool-parser fragility under $4$-session ensembles** (*guessing* shared vLLM/SGLang hardware may serialize concurrent calls or mangle tool JSON). **Mitigation**: `overwatch trial` measures parallel p95 latency and invalid-call rate first; if bottlenecked, degrade via config to `1 investigator + 1 challenger (on real)` unchanged.
