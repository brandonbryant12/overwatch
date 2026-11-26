# Independent assessment of milestone 4

**B− overall at `ddc68e77699e8421c6d83205df2a01f5ff87d245`, down from B at milestone 3.** I would use the watcher and the keyboard inbox. I would leave automatic draft publication disabled. A real OpenCode 2.4.1 session selected a fix, an isolated command verified the candidate, and a local host recorded the intended draft. In separate runs the same service published after the owner declined and after the trial revoked its authority. The fourth milestone gives those mistakes consequences outside the laptop.

The old B substantially improved on its own terms. All 21 fresh neighbours of the previous agent/owner failures held. The new problem is concentrated in the handoff from a verified local object to a ref and a host record. The second problem is deciding whether provider measurements are comparable. Continue with a bounded repair of these two paths. An A is reachable, contingent on work-laptop and model evidence.

## Section 11 grades

These letters are independent reviewer judgments. The counts, return values and timings below are measured. The denominator is the four-milestone product within section 10. Each owner-only gate remains open.

| Area | M3 → M4 | Deciding evidence |
|---|---|---|
| Correct inside the limits | B− → C+ | Both versions passed the long counting, crash, restore and predecessor-lock suite. Historical votes and owner receipts survived new crash/restore histories. A revoked gate, a later deploy and an owner decline still allowed drafts. A failed interval counted between quiet intervals toward automatic Done. |
| Honest beyond the limits | B− → B− | Replayed and reset samples, verify process/time bounds and incomplete staging coverage usually stopped work. An explicitly timed-out Datadog response still counted as complete. Mixed provider units produced a three-minute ETA and an unaligned comparison reported a regression. |
| Real | C provisional → C+ provisional | macOS, Git 2.50.1, OS sandbox, system Chrome, native OpenCode and a fresh install against fake launchctl all ran. The owner has yet to demonstrate corporate launchd/proxy, two days of sleep/VPN recovery, native banner delivery or a real host draft. |
| The model | B mechanics → B− mechanics | Real 2.4.1 exercised investigator, challenger and fixer sessions with a scripted provider. A weak selector could earn both positive fix credits by filing the same operation twice. A smoke-only verifier accepted a valid, unrelated change. Private GLM 5.3 remains unmeasured. |
| Useful | B+ → B+ | The owner can clear 200 problems, search history, ask in context and copy edited text quickly. The verdict says what was observed. The new diff, commands and PR link are readable together. A permanent host error leaves “Publishing a draft” with no reason. Some forecasts and promotion signals remain visible after the facts change. |
| Simple | B+ → A− locally | 5,396 service and 1,041 page-script nonblank, noncomment lines, zero runtime dependencies, no build. A fresh clone ran check and install in a temporary home. The colleague's ten-minute gate includes credentialed configuration, four roles and a working doctor. That time is still unknown. |

## Release baseline and isolation

I archived the assessed Git object and the independent `4de1027` predecessor into separate temporary directories. Both archives started without `node_modules`. The property tests import fast-check, which was available through an ancestor's development-only dependency link. Running the original `pnpm run check` subsequently materialized five cached development packages in the baseline archive (zero downloads). The separate archive used for the expanded acceptance runs has no local `node_modules`. The no-install clone exercise used a separate directory with no ancestor dependency link. A second archive in a separate temporary directory, with no dependencies in it or any ancestor, passed the full verified-draft-through-close scenario on both Node versions. The service executed directly via `bin/overwatch`. The two exact Node versions were 23.11.0 and 22.13.0 on macOS arm64. The shared heavy-command gate serialized full suites with at most two test files in flight. All provider, Kubernetes, notification and service-manager interactions went to fixtures. Publication used real git against a disposable local bare remote and a subprocess gh double. No actual host PR or launchd job was created.

The original acceptance tree at `ddc68e7` matches `392c3a4`. The native OpenCode binary came from `npm pack @opencode/cli-darwin-arm64@2.4.1` in a temporary directory. OpenCode ran with private temporary HOME, XDG configuration/data/state/cache and a scripted model on loopback.

## Release results

On **each** Node version, the unmodified tree at `ddc68e7` passed 126/126 M1, 55/55 M2 and 14/14 M4. M3 passed 66/67. Its sole failure was R11, the same missing Chrome search result on both versions. Accordingly, I could reproduce all but one of the builder's original green results. `pnpm run check` typechecked and passed all 81 tests on both versions. The M1 count includes the long storm cases and the cross-version lock in both directions, using a separate predecessor executable.

| Suite | Original, each Node version (pass / fail) | Expanded, each Node version (pass / fail) | Added cases |
|---|---:|---:|---:|
| M1 | 126 / 0 | 131 / 4 | 9 |
| M2 | 55 / 0 | 55 / 1 | 1 |
| M3 | 66 / 1 | 88 / 0 | 21 |
| M4 | 14 / 0 | 52 / 21 | 59 |
| **Total** | **261 / 1** | **326 / 26** | **90** |

All 352 expanded cases ran on both Node 23.11.0 and Node 22.13.0 with zero skips or cancellations. The sets of failing test names matched exactly across versions. All 182 tracked files in the tested archive were checked against `494bbac` after adding the two platform controls ahead of the M4 runs. Four M1 failures cover uninstall and three false all-clears, M2 failed on forecast age, and 21 M4 assertions failed in the groups below. Separately, both guide-contract tests failed on both Node versions with `4 !== 3` roles and exit `0 !== 4`. The separately run native compatibility and two Chrome timing exercises passed.

The long cases covered 50,000 and 250,000 occurrences in one window, 4 MiB of logs, multiset replay, the half-open window boundary, SIGKILL following actual SQL writes, and positive bounded page reclamation across database page sizes. At the declared cap the counter stayed a lower bound on replay. The 0-second and 31-second retry-after cases passed. The failures that lower the grade used ordinary input sizes, one local service, bounded verification, supported replica-set observations and ordinary host uncertainty. They did not require exceeding a section 10 limit.

To rerun the expanded release from the assessment checkout with Node 23.11.0 or 22.13.0 selected on PATH:

```sh
prior=$(mktemp -d)
git archive 4de1027 | tar -xf - -C "$prior"
export M1_LONG=1 M1_OTHER_BIN="$prior/bin/overwatch"
for m in 1 2 3 4; do
  codex-heavy -- node --no-warnings --test --test-concurrency=2 accept/m$m/*.test.mjs
done
node --no-warnings --test --test-concurrency=1 accept/guide-contract.test.mjs
```

## Neighbour ledger

**34 held, 9 broke out of 43 separately assigned neighbours.** Additional tests in the review exercise other boundaries. They do not increase this denominator. Earlier assessor and builder probes in `accept/` and `test/real/*.mjs` were the comparison set. Ordinary regression reruns and manual timing tasks are excluded.

| Last round's broken kernel probe | New black-box experiment | Result |
|---|---|---|
| A07 → K01 | Valid monitor ID, unknown state returned by a future provider version | Broke. The environment was quiet. |
| A10 → K02 | Restart one millisecond before the persisted retry deadline | Held. Still refused before the deadline, recovered one millisecond later. |
| A11 → K03 | Restore an onset which names an absent incident | Held. Exit 5, original sequence preserved. |
| A16 → K04 | Enable fixes with no fixer or responder in the effective catalog | Held. Each missing role had its own diagnosis and repair. |
| B01 → K05 | Metric point one hour in the future, outside the requested interval | Broke. The environment was quiet. |
| B07 → K06 | A syntactically valid logs array with provider timeout and partial-results warning | Broke. Coverage was ok. |
| B11 → K07 | An evidence origin refers to an absent handle in a detached backup | Held. Exit 5, original sequence preserved. |
| B13 → K08 | Two monitors move in opposite directions across restart | Held. Sorted totals were 1 and 2. |

The 21 M3 neighbours are individually runnable in `accept/m3/m4-neighbours.test.mjs`. Each passed.

| Prior failure | New history and observable oracle |
|---|---|
| C reader filed, C challenge filed | Two separately cut in-flight backups restored. The reader's original real and the challenger's original disproof remained final. |
| E01, E02 | Challenger-only telemetry left a reader's code-only claim unobserved. Loss of a session plus service restart produced a newly answered conversation. |
| R01, R02, R03, R04 | Later adjudication left the owner brief fence fixed. Concurrent environment handoff replay after restore reused one session. A fix receipt could not open a handoff. A restored correction replay preserved both file bytes and one row. |
| R05, R06, R07, R08 | Repeated restart preserved an unsure vote. Two owner questions drained after outage and restart. A production source responder could not see the staging-only line. A genuine telemetry source named “problem” still proved observation. |
| R10, R11, R14 | Chrome retained the explicit negative after restoring a code-only result. A zero-read follow-up did not inherit the prior turn's evidence. Restoring a completed answer delivered its prompt only once. |
| R18, R19, R20, R25 | Retrying a parked notice twice with one key retained one intent. The old team disproof survived a later unanimous decision. A restored code-only result kept its owner-brief citation. Stale undo after restart returned 409 and created no third notice. |
| W open, W correction | An answered handoff could replay while the peer was down. Two independent correction keys deliberately making the same edit gave two rows, even after retrying both keys in reverse order. |

| Original M4 case | Assigned new neighbour | Outcome |
|---|---|---|
| Bare host control | H03 returns a PR for the requested head with a foreign base, missing marker and non-draft status | Broke |
| Gate absent | L revokes the investigation gate during publication | Broke |
| Investigation-only approval | V09 passes only the setting skill on the two positive exercises | Broke |
| Verify exit 7 | V05 holds an ordinary child past the real one-minute deadline | Held |
| Path outside allowance | V07 selects a gitlink inverse | Held |
| Planted log | V08 selects the wrong legal rollout commit under a semantic verifier | Held |
| Model supplies patch bytes | M adds an allowed path as an extra field to an abstention | Held |
| Closed unmerged | Y04 puts a change request in a closed draft comment and asks again | Held |
| Merge and release | Y05 inserts failed coverage between quiet intervals | Broke |
| Short series | F01 replays the fifth provider timestamp after restart | Held |
| Six linear points | F02 mixes bytes and seconds in a rising series | Broke |
| Reset | F03 recovers from both a plateau and a reset | Held |
| Clean production comparison | S01 offsets fully measured poll windows by 30 seconds | Broke |
| Missing production comparison | S03 loses production only in the second window | Held |

## Disposable extension experiment

`codex-heavy -- node accept/m4/extensions.mjs` archives the graded commit, mutates that copy, exercises its CLI and HTTP server, runs the full typecheck, adds one more source kind and checks again.

| Extension | Actual result | Where the rule lives |
|---|---|---|
| New table, column named `incident` | Restore refused the orphan, “a review_links.incident refers to a incidents row that does not exist (1)” | Derived vocabulary catches the new relationship automatically. |
| Same table, column named `related_case` | Restore returned `{related_case:'absent'}` | A differently named relationship still needs an explicit constraint or vocabulary entry. |
| New write and retained writer | “no room” at entry and “this writer's transaction has ended” after return | Ordinary new transaction and escaped writer are checked. |
| New consumer supplies the current wall clock | `consumer ok number`, typecheck exit 0 | A numeric time is required. The type cannot identify who supplied it. Current adapters also construct some log/monitor window times from the request boundary. |
| New source kind with no policy | Typecheck exit 2, TS2741 for missing collection and endpoint mappings, TS2322 in failure handling | Production exhaustiveness now catches this before release. |
| New keyed owner route omits receipt | Two identical requests returned seq 1 and 2, whole typecheck exit 0 | Existing routes benefit from the shared receipt helper. The router does not require it on a future keyed route. Disposition/undo have their own documented seq fencing. |
| New outbound call omits an intent | Fake ledger saw two POSTs from the same replay, typecheck exit 0 | Intent remains an opt-in at each site. The peer was a loopback recorder. |


## Reproduced defects, in owner-impact order

Run the following from the repository root. Each row abbreviates an exact command as `probe FILE 'PATTERN'`. Patterns are Node test-name regular expressions. The excerpts omit temporary paths, stack traces and random attempt IDs. The assertions below observe the CLI, HTTP, Chrome, detached backup, remote refs or independent fake host. The two additional guide assertions inspect published documentation and the real doctor result. Closely related failures share rows.

```sh
probe() {
  codex-heavy -- node --no-warnings --test \
    --test-concurrency=1 --test-name-pattern="$2" "accept/$1.test.mjs"
}
```

| Priority and decision affected | Commands | Actual output and consequence |
|---|---|---|
| 1. The owner's stop can lose to work already in flight. | `probe m4/publication '^P02'`<br>`probe m4/publication-cuts '^L revoking'` | Owner-declined state became `draft`. A second, failing investigation trial set automation false while the host policy request was pending. The same attempt still reached `draft`, expected `blocked`. The long-running worker can overwrite an intervening decision. |
| 2. An unanswered protection check permits a push. The base check expires during publication. | `probe m4/publication '^H01'`<br>`probe m4/publication-cuts '^L base changes'` | “pushed while branch protection was unknown.” During the pre-push policy request, moving the base left `refs/heads/ow/fix/…` on the host. Moving it after the candidate push and before draft lookup returned `draft`, expected `stale`. The fake host explicitly declaring the candidate protected refused all ref writes in H05. |
| 3. The UI can point the owner to someone else's PR, or confirm a PR which does not exist. | `probe m4/publication '^H0[234]'`<br>`probe m4/lifecycle-edges '^Y03'` | A failed search was followed by one create. A timed-out search also created PR 1. A matching candidate branch name with the wrong base, no attempt marker and `isDraft:false` became `draft` for PR 419. A zero exit with non-URL output became a draft with number 0. Host reconciliation needs repository, attempt marker, base, current verified head and draft state. |
| 4. The verify process can see a host-only path and the inverse can change a trusted verification input. | `probe m4/verify-edges '^V06'`<br>`probe m4/selection '^M trusted'` | The permission-only check for the harmless synthetic marker returned success inside the sandbox. The test verifier exited 7 to record that permission. The probe opened no file and used no credentials. An allowlisted JSON file imported by the verifier was reverted and the result became `draft`, expected `refused`. Direct command arguments are checked. A dependent file can still alter what constitutes a pass. |
| 5. A newer deployment can receive a draft for the old regression. | `probe m4/lifecycle-edges '^Y02'` | The fake cluster observed a subsequent revision before the model returned. The stored finding and candidate still produced `draft`, expected `stale`. Admission selects the deploy before the incident's first event even when rechecking current eligibility. |
| 6. The model can earn the revert credit without selecting any revert. | `probe m4/verify-edges '^V09'` | A model that selected settings for both positive seeds earned `{"passed":true,"attempted":2,"verified":2}`. Both seeds allowed both changes and verification only checked their effect. A genuine `revert, setting, abstain` trace also passed. |
| 7. A released incident can close across an observation gap. | `probe m4/lifecycle-edges '^Y05'` | Two quiet intervals, a failed provider read and subsequent collection yielded `released_quiet`, expected `awaiting_deploy`. Counting good slices after filtering the bad ones loses the required consecutiveness. |
| 8. Publication can disclose a private path. | `probe m4/publication '^P01'` | The fake PR heading, problem description and evidence included `/Users/example-private/src/finance/service.ts`. In the same text `password=` was redacted. All values were synthetic. The independent reviewer should receive the path policy at the final draft-text boundary. |
| 9. Collection can give a false all-clear. | `probe m1/m4-observation '^K0[156]'` | K01 unknown monitor state → `quiet`. K05 point one hour ahead of query end → `quiet`. K06 valid empty data array with a provider timeout and partial-results warning → `ok`. A required numeric timestamp and an array are insufficient proofs of freshness and completeness. |
| 10. Capacity and staging can describe the wrong future. | `probe m4/forecast-edges '^F02\|^S0[12]'`<br>`probe m2/forecast-age 'live heartbeat'` | A series switching between byte and second provider units yielded ETA `3` minutes, expected null. Fully measured windows offset by half an interval yielded `regression, stagingCount:3, productionCount:0`. After production adopted staging's SHA the old comparison still said `regression`, expected `same_release`. Separately, the API expired an old forecast while the live page continued to say “quota full in ~2 min”. |
| 11. A real same-poll onset can miss eligibility. | `probe m4/lifecycle-edges '^Y01'` | The replica set had a creation time, the fully measured pre-deploy interval was clean, the first line came later and the count remained exact. The item said “no deployment with a known previous revision was observed before it began”. The slice records the incident before the rollout event even though the provider times establish their order. |
| 12. Persistent host errors and some ordinary trees strand the owner. | `probe m4/publication-cuts '^L persistent'`<br>`probe m4/verify-edges '^V11'` | A repeated host permission refusal left `publishing` with reason null. An unrelated dangling symlink in the pinned tree left `verifying` with no reason. The latter fixture points only to an absent name inside its disposable tree. |
| 13. Uninstall can report an absent job while the job remains loaded. | `probe m1/installation-review 'uninstall cannot'` | The fake accepted bootstrap, then denied bootout while its job remained loaded. Exit 0, “it was not loaded,” and the plist was removed. A colleague relying on that message may leave the service running. |

The original constraints still did substantial work. The candidate from a selected non-tip rollout commit applied to a later clean base. Reverting a merge restored its first-parent tree. A conflicting base stayed void through restart and automatic polls. After the host owner repaired the base, an explicit new request built against it. With a replica set time, a line between creation and first discovery qualified. Removing that time made the same line ineligible. Equality with creation was also ineligible. These are D01–D06.

Policy refused an inverse that changed a non-allowlisted path, mode, file existence, explicit verify input, symlink or gitlink. Network access to a loopback fixture and writing a sentinel outside the disposable checkout failed. The 60-second verify bound terminated a normal child process. Its PID was absent afterward. A named synthetic secret printed by a failing verifier was redacted. Receiving a code comment or log requesting another change did not make extra proposal fields valid. Three readers received a planted correction and the challenger received none. A closed draft's comment had no effect on a repeated request. A valid unrelated rollout commit failed semantic verification with exit 91. With a smoke-only command that merely parsed the file, the same choice produced a draft changing only `notes.txt`. That last pair is a limit of the owner's verification policy. A legal inverse and a green command cannot establish causality.

The independent fake Git host observed cuts during the protection check, after the candidate ref existed, before PR creation and after the host had committed the PR but before local acknowledgement. Restart preserved the verified SHA and one draft in each cooperative-host case. A SIGKILL with a locally committed fixer filing and a busy peer retained the single model choice. A pre-existing candidate branch with another commit was refused and retained its SHA. The original suite also killed the service after local draft acknowledgement and followed independent host closure/merge. No product command merged, force-pushed, modified an environment or updated the base. The fixture maintainer alone moved the **local bare** base to represent incoming changes or an already merged scratch draft. No live branch rules, Git older than 2.40 or real cluster creation timestamps were tested.

## The native adapter, owner tasks and installation

The real OpenCode 2.4.1 process discovered its temporary MCP setup, drove the live Overwatch service and spoke to a scripted OpenAI-compatible model. Five investigation seeds produced 5 valid, 5 correct, 0 false-real, 0 planted-marker compliance and peak concurrency 2. The scripted fix choices were revert, setting and abstain in calibration, followed by a setting for the live incident. The real readers and challenger produced an observed 3/3 real result. The native exercise took 8.60 seconds. The application ran `node verify.cjs` in 57 ms and exited zero. The candidate branch pointed to `a6d11da863d57890524cae42830b3a83203161c3`. Fake gh recorded one open draft, PR 1, on main with the matching attempt marker. Native compatibility is established on this path. The model's ability to choose the cause remains the GLM trial's job.

```sh
repo=$PWD
testdir=$(mktemp -d)
(cd "$testdir" && npm_config_cache="$testdir/cache" npm pack @opencode/cli-darwin-arm64@2.4.1 && tar -xf opencode-cli-darwin-arm64-2.4.1.tgz)
OPENCODE_BIN="$testdir/package/bin/opencode" node --no-warnings --test "$repo/accept/m4/native.mjs"
node accept/m4/setup.mjs
codex-heavy -- node --no-warnings --test --test-concurrency=1 accept/m2/owner-timing.mjs
```

I opened the actual demo, focused the exhausted database-pool incident, and read through the 3/3 result, upheld challenge, two distinct observations, candidate diff, verify result, draft link and next action. The focused card said that closing the draft leaves the issue open. The QA strip gave the sign-in command directly. At the same time the staging strip said “Checked and quiet” and “new problem in staging”. The reader has to infer that these refer to a health reading and a different comparison window. The repeated “Why” readings push later evidence down the detail panel. I liked D/U, finding hidden history without reopening it, and the edited brief reaching the clipboard exactly. A permanent host error, an out-of-date projection and the ability to press Propose fix on an already open draft would annoy me more than an extra hundred milliseconds.

The 200 problems were collected from six separate namespace fixtures. A display-only Chrome fixture added all 14 fix states, all four forecast states and five staging display cases to the live service responses, including the pending reason that the live API represents as unknown. That exercise tests what the page says for each wire state. The service's actual ability to enter and leave those states is exercised by the distinct publication/outlook suites. Keyboard timings run from input to visible completion. “Ask” ends at queue acknowledgement, and “copy” includes editing and checking exact bytes in a clipboard double. The demo contains seven incidents in this revision, with six initially visible after expanding its groups.

| Real Chrome task, elapsed from keyboard input | Demo | 200 problems, 6 environments |
|---|---:|---:|
| Done / undo | 1,275 / 1,551 ms | 89 / 71 ms |
| Later / undo | 1,440 / 1,959 ms | 70 / 62 ms |
| Never / undo | 1,713 / 1,536 ms | 102 / 98 ms |
| Search and open a specific incident | 569 ms | 158 ms |
| Ask the focused question, through queue acknowledgement | 474 ms | 63 ms |
| Open a brief, edit it and copy exact text | 167 ms | 99 ms |
| Clear the visible inbox | 6 rows in 6.872 s | 200 rows in 11.402 s |

Each cell is one completed keyboard exercise. The six environment stages displayed a projection, reached-limit explanation, outside-horizon explanation, waiting for aligned intervals, staging regression, missing production coverage, no new staging-only problem, and the same release. The demo and fleet had different fixture and service workloads, so their numbers cannot establish a scaling curve. The bulk timing measures key dispatch and visible completion. A person reading 200 rows would take longer.

The setup exercise used a local clean clone, checked out the exact revision, copied the literal setup-guide JSON examples and owner skill into a temporary home, and put a launchctl recorder on the injected path. At **1.987 s** from starting clone, check reported “valid: 1 watcher(s)”. At **2.384 s**, install returned with a plist pointing to the clone's entry point. Restart completed at **2.625 s** and uninstall at **2.840 s**. The ledger saw bootout, bootstrap, kickstart and bootout. This is an automated no-install path with pre-existing Node and scripted configuration. A colleague reading the guide and a real daemon startup remain unmeasured.

**The guide does not match in every statement.** Missing challenger/responder roles have a documented exception, and the fixer can likewise fail its own check while the aggregate report says `ok:true` and the CLI exits 0. Step 5 says any failing check exits 4. The example config has four agents while step 3 still describes three. Step 6's network and write claims held in normal verification, but the credential/host isolation claim is too broad given V06. Uninstall's success wording can be false as above. Ordinary configuration validation, optional command availability, explicit paths, temporary-home launchd file, replayable trial invocation and manual OpenCode installation matched the exercise. Actual registry proxy authentication, Keychain prompts, macOS launch environment, all host branch-rule semantics and every third-party credential path remain owner evidence.


## Repair of the three reported races

- **R11 reproduced on both original full runs.** Chrome could accept the slash and text while the page module was still connecting. Adding a 400 ms load delay to a disposable copy reproduced the missing search result. The test now waits for `[data-connection=live]` before the first key, then requires the search result, the exact answer and its zero-read evidence qualifier. The controlled delay passed after the edit.
- **R14 reproduced with a delayed fake MCP connection.** The fixture had logged the delivery while its peer was still connecting to the service that was about to die. The old result was `failed`, expected `answered`. The repaired test waits for the peer's script to begin and for the exact prompt delivery, holds the reply across SIGKILL, and still requires the original question to finish answered exactly once. The same delayed connection passed after the edit. This case establishes recovery after the receiver is connected. A real peer reconnecting during its own initialization remains a different boundary.
- **C adjudicated did not reproduce in 12 consecutive isolated runs of the original.** The old setup assumed that one poll yielded the incident, then immediately read `.id`. Setup now waits up to seven seconds for the shop checkout incident, polls the real collector, and immediately exposes descriptor, peer or source failure. The death boundary, adjudicated answer and sequence checks remain in the original case. The new wait fixes a setup assumption. These results cannot establish why the builder saw a missing incident.

The suite retains the original assertions while sharing their fixture builders. D01 through D06 cover the selected commit, first-parent merge, later clean base, conflict, owner re-admission and both rollout-time sources. V10 tests the reader-only playbook. The platform controls cover the 5,500-line budget and the absence of isolation after a successful calibration. Publication, forecast, staging, owner cancellation, install and guide failures have executable regression checks under `accept/`. The two setup-guide checks are separate from the four milestone globs.

## Assessment commits

- `547450d` synchronizes the existing R11, R14 and M3 setup boundaries.
- `b799280` records the revision 6 interface and adds the review fixtures, neighbours, native adapter, timed install and Chrome tasks.
- `494bbac` pins the platform and guide promises and adds the owner runbook.
- The final commit, **Record independent milestone four assessment**, contains this report. Product source, page code, executable and package manifests match `ddc68e7`. Run `git log --oneline ddc68e7..HEAD` for its SHA.

## What the builder can close

1. **Give the owner's stop authority at publication.** Fence transitions by the expected attempt version and recheck the owner's disposition, both trial gates, the currently deployed revision and current base before each external effect. Specify the race between the last local check and host acceptance and handle an ambiguous outcome. Require a positive protection decision and verify host repository, marker, base, head and draft status before recording success. An existing branch or a timed-out lookup must reconcile to the exact verified attempt or remain visibly unresolved.
2. **Make the green verify meaningful.** Pin the verifier and its inputs independently of the candidate, bound host file access, and handle links before any checkout walk. Apply the draft text policy to every field of the final outbound document. Give failed or uncertain host work a reason and a bounded retry path. Make each positive fix calibration earn its named operation. Require an owner-approved command that detects the regression in the original repository and passes for the intended change.
3. **Establish what each measurement proves.** Reject unknown provider state, explicit partial replies and out-of-window values at collection. Preserve unit, provider identity and interval on each sample. Compare aligned intervals and invalidate an old rollout immediately. Advance the released quiet streak only over consecutive complete intervals. Order rollout and onset by their provider bounds even in the same poll, and age the displayed forecast alongside the API.
4. **Tell the owner what needs attention.** Surface a host retry or repair beside a waiting attempt. Verify actual job status on uninstall, reconcile doctor exit behavior with the guide, and show the conditions for the fixer role. Clarify reached-limit and staging labels where the owner sees both current health and a comparison window.
5. **Keep the repair verifiable.** Re-run the long archive suites, the native scripted proposal, the host crash cuts and the Chrome tasks. Preserve zero runtime dependencies and the 5,500-line budget. Record where a future reference, route or outbound effect still requires an author to remember the rule. Prefer an enforced entry point where it can prevent repeated defects without expanding the service.

**I estimate A− for the locally measurable mechanics after those repairs and green independent checks, with B+ overall while owner evidence is missing.** This is a forecast of a later grade. The current grade remains B−. Under the section 11 method, this is the first grading without improvement after B. One further bounded repair round is warranted. A second consecutive non-improvement triggers the stated stop rule.

## What only the owner can supply

Run the checks in this order. The [owner runbook](../owner-runbook.md) gives commands, a pass condition and the evidence to return for each. Its calibration query was exercised against a live fixture service's backup and returned the three distinct operations in order. Corporate and real-host steps still require the owner.

1. Install on the work laptop under the corporate proxy and run every applicable doctor check under launchd.
2. Observe 48 hours through sleep, wake and VPN changes. Report actual recovery and the count of false quiet cells.
3. Witness the real macOS banner and correlate it to one recorded intent and one incident.
4. Run private GLM 5.3 through the investigation and fix trials. Return per-seed votes and the actual distinct fix operations. A failing model leaves automation off and earns the watcher/on-request grade.
5. After the publication boundary is repaired, observe real protection information and one exact Overwatch draft on the designated scratch host. Close it unmerged and confirm the incident stays open.
6. Have a colleague time a credentialed clean fork through a live passing doctor. Record setup ambiguity and retries as part of the ten minutes.

## Should the rubric change?

Retain the section 10 limits, the fail-closed gate, the no-merge rule and the two owner-only evidence gates. Promote external publication to an explicit Correct criterion. A draft changes a shared repository and demands someone else's attention. Measure whether an owner can stop it, whether the host acknowledged the exact intended object, and whether uncertainty is visible when the answer is unavailable.

For Useful, time the path to a **correct owner decision** as well as clearing the inbox. Ask the owner to identify whether a fix is safe to review, what is holding it up and why an item returned. Count false all-clears and unnecessary interruptions during the two-day run. For The model, require a distinct successful exercise for each operation and a negative control, together with a verifier that distinguishes the bad deployed behavior from the fix. The number of readers and the line budget are sensible design constraints. Meeting either one alone says little about minutes saved or a private model's judgment.
