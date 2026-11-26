# Independent assessment of milestone 3

**B overall, up from B− at `21fdca3`. Return M3 to the builder before enabling automatic drafts.** Grade for the delivered M1–M3 product at `4de1027e33c03ac52ddace59c8b0f45ce55cfa70`, using sections 10–11 of the simple-core plan. M4 is a prospective contract. Its red tests do not lower this grade.

The earlier 26 reds are closed. The owner can now find a past incident, ask a question, inspect a divided vote, correct the next investigation and copy an edited brief. On the new kernel probes, **17/21 fresh neighbours of the original defects held** and **4/8 additional neighbours of last time's failures held**. That is **21 held, 8 broke across 29 distinct probes**. A current-looking green cell over an old provider reading, a changed vote after a crash and two different briefs for the same historical interval are the deciding failures.

## Section 11 scorecard

| Rubric area | M2 → M3 | Deciding evidence |
|---|---|---|
| Correct inside the limits | C+ → B− | Two-way predecessor exclusion, collection kills, replay, protected citations and stale decision fencing survived. A reader or challenger can already have filed when the service dies. Restart runs that slot again and can change the outcome. A frozen brief reads today's disposition. |
| Honest beyond the limits | C+ → B− | Both storm sizes, byte limits, age/reclaim, disk refusal on new business writes and missing votes have direct coverage. A malformed logs result or unidentified monitor is reported as measured. An old successful provider point receives a new freshness horizon. |
| Real | Incomplete → C, provisional | macOS, SQLite, Git, system Chrome and native OpenCode 2.4.1 completed local journeys. Doctor could not certify the owner's service environment. The two-day sleep/network/launchd run and actual notification delivery remain open. C records partial evidence. The owner acceptance gate is incomplete. |
| The model | B+ mechanics → B mechanics, private endpoint incomplete | The same scripted model passed calibration and completed a real adapter investigation with dissent. Code counts the planned denominator and checks handle ownership. Three scripted readers and an agreeable challenger promoted a printer claim citing the same unrelated checkout line to observed real. A generated or misleading provenance label is especially costly here. |
| Useful | B → B+ | At 200 problems a focused ask acknowledged in 62 ms, a search opened in 146 ms and edited brief text reached the clipboard double in 81 ms. Missing votes are legible. An uncited categorical answer reads like a fact, a brief can change after the fence, and a temporary peer outage can permanently fail a question. |
| Simple | A− → B+ | 4,184 service lines, 945 page JS lines, zero runtime packages and a successful no-install demo. The setup now requires coordinating three agents, two different credentials, a skill and an MCP entry. Doctor checks one agent. The ten-minute clone-to-working-install gate remains unmeasured. |

Grades are reviewer judgements. The predecessor and process-kill results, observed responses, timings and counts below are measurements. I expect an A to be reachable on this design. The count, snapshot and vote functions do useful work. The next investment belongs in the small number of places that establish measurements, external intents and what the owner is allowed to infer from them.

## Reproduce the review

Use the repository root, Node 23.11.0 or 22.13.0, the installed development dependencies for the test runner and local Chrome. All acceptance rigs isolate HOME, OpenCode, Git, commands, provider ledgers and data. The predecessor is a separate archive with its own executable. Nothing was installed into launchd or the owner's OpenCode configuration.

```sh
prior=$(mktemp -d)
git archive 21fdca3 | tar -xf - -C "$prior"
export M1_OTHER_BIN="$prior/bin/overwatch" M1_LONG=1
gate=/Users/brandon/.local/bin/codex-heavy
for m in 1 2 3 4; do
  "$gate" -- node --no-warnings --test --test-concurrency=2 accept/m$m/*.test.mjs
done
"$gate" -- node --no-warnings --test --test-concurrency=1 accept/m2/owner-timing.mjs
"$gate" -- node --no-warnings --test --test-concurrency=2 test/real/{neighbour-probes,m3-probes}.mjs
OPENCODE_BIN=/absolute/path/to/opencode-2.4.1 "$gate" -- node --experimental-strip-types --no-warnings test/real/opencode.ts
```

For each code in the tables, `probe A07`, `probe R04`, etc. is the following exact focused command. For the transition cases, use e.g. `probe 'C challenge filed'`. Outputs below omit stack frames, random IDs and temporary filenames.

```sh
probe() {
  case "$1" in
    A20) file=accept/m1/storage-edges.test.mjs ;;
    A*|B*) file=accept/m1/assessment-neighbours.test.mjs ;;
    U*) file=accept/m2/assessment.test.mjs ;;
    R0*|R1[0-6]) file=accept/m3/assessment.test.mjs ;;
    R*) file=accept/m3/recovery.test.mjs ;;
    C*) file=accept/m3/transitions.test.mjs ;;
    E*) file=accept/m3/evidence.test.mjs ;;
    W*) file=accept/m3/owner-cuts.test.mjs ;;
  esac
  M1_LONG=1 node --no-warnings --test --test-name-pattern="^$1 " "$file"
}
```

### One new neighbour per original defect

| Command | Different experiment | Observed |
|---|---|---|
| A01 | Boolean between a numeric Datadog value and a measured zero | Held. Previous 4 retained with gap, then 0 recorded. |
| A02 | Fail one model, pass another, switch back | Held. Approval for the second did not enable the first. |
| A03 | First new log exactly on a saturated slice's exclusive end | Held. Old and new totals 50,000 and 1. |
| A04 | Network failure interrupts opening a breach | Held. The next good high left breach false, another high opened it. |
| A05 | Two event UIDs with the same title switch counter formats independently | Held. Final summed count 8. |
| A06 | Previous container identity becomes knowable after a gap | Held. Both instances counted once. The original lower bound survived. |
| **A07** | Monitor array contains a valid OK monitor beside an Alert without an ID | **Broke.** Coverage `['ok']`, expected `['gap']`. |
| A08 | Request a manual investigation below the reserve | Held. HTTP 503 and unchanged jobs. |
| A09 | Expire real evidence, restart and resolve the challenger's own cited handle | Held. Both the stored object and the job reference survived. |
| **A10** | Rate refusal, clock rollback, restart, first scheduler pass after the whole backoff elapsed | **Broke.** Failure remained `'rate'`, expected null. The first pass starts the monotonic bound anew. Last review's probe initialized the deadline with an immediate pass. |
| **A11** | Change only a completed work row's run reference in a detached backup | **Broke.** Restore exit `0`, expected `5`. |
| A12 | Both manual readers run past their deadline with an owner question waiting | Held. The responder completed while the original peer waits were still held. |
| A13 | Alert → Warn → Alert for the same monitor | Held. Error urgency and attention returned. See B13 for the count. |
| A14 | Refused Kubernetes adapter shares a watcher with a valid Datadog adapter | Held. The valid log counted once. |
| A15 | Registry throttles with 429 | Held. Proxy diagnostic failed, named 429 and gave a fix. |
| **A16** | Investigator correctly configured, both other required agent roles absent | **Broke as an M3 diagnostic.** `no missing-role diagnosis`. The investigator-only check meets the documented M1 scope. The affirmative diagnostic cannot establish installation of the M3 system. |
| A17 | Datadog floor equality with duplicate IDs spread across three pages | Held. Counts before floor / at floor were 0 / 3. |
| A18 | Two distinct IDs on a six-hour internal page/window boundary | Held. Count 2 before and after replay. |
| A19 | Credential refusal followed by rate refusal | Held. The second repair no longer asked for keys. |
| A20 | Change free-space pressure around a restart with 8 KiB SQLite pages | Held. Neither individual reclaim exceeded 16 MiB. |
| A21 | Demo renews a week later with an owner disposition already committed | Held. Seq advanced, Never stayed, zero peer calls. |

### One additional neighbour per prior broken neighbour

| Command | Different experiment | Observed |
|---|---|---|
| **B01** | A finite point from four minutes ago is returned again to a one-minute watcher | **Broke.** `quiet over four-minute-old point`. Chrome independently rendered `quiet` in U02 after a reload. |
| B04 | An incomplete high sample between two fleet-wide high samples, across restart | Held. The first complete high did not open a breach. The second did. |
| **B07** | Successful HTTP response with an unexpected logs envelope and no result array | **Broke.** Coverage `'ok' !== 'gap'`. |
| B08 | Refuse a correction for space, restore space, resend its original key | Held. One durable correction. This is a different boundary from dying after the correction commits. |
| B09 | Expire, back up and restore a challenger's disproof and its citation | Held. The citation row survived. |
| **B11** | A notification in a detached backup refers to a nonexistent incident | **Broke.** Restore exit `0`, expected `5`. |
| **B13** | Alert, three OK readings, Alert again | **Broke.** Active and total were `[true,1]`, expected `[true,2]`. The baseline is keyed by monitor and state forever. Severity can recover while the recurrence count remains wrong. |
| B14 | Different queries on the same site and credentials are both refused | Held. Two sign-in states from one remote request. |

### Do the rules hold when another caller is added?

I added a disposable table, write site, consumer and source kind to a *temporary archive*. No product change from this experiment is in the branch. The table contained one incident-reference column. The consumer accepted a structural Sample. The new source used its own kind. The following were actual results of running that archive:

```text
new consumer true false
new source endpoint ["datadog",null,null,null]
new table recovered [Object: null prototype] { incident: 'absent' }
new ordinary write refused
maintenance-labelled event 2
```

- The Sample constructor rejects a nonfinite value. The pair above means the deliberately constructed consumer input had `measured === true` and `Number.isFinite(value) === false`. The real B01 is more consequential: its value *is* finite. Coverage freshness is established from poll success separately from the point's timestamp. B07 establishes empty coverage without any Sample.
- The new table had a plain reference column and no entry in the restore list. Creating it in the table declaration was sufficient for backup and restore to copy an orphan. Actual M3 work and notification rows reproduce this through the CLI. The SQL restriction on a **declared citation** held through expiry, backup and restore. A registry of references makes review easier. It still depends on the table author adding a row.
- An ordinary new transaction hit the disk guard. A caller passing the maintenance boolean committed the same kind of event. M3 startup uses this exception for work and notification reconciliation. The public store also exposes its SQLite connection. The maintenance exception is a convention with a legitimate use. It cannot prove that every future business write checks space.
- A third source kind in owner configuration is rejected before any collection (R23). In the extension experiment, adding a type-level reading catalog entry did not select an endpoint policy. The non-Kubernetes branch returned the Datadog identity above. Today's credential combinations passed A14/B14. A future adapter needs an exhaustive identity and freshness policy.
- The interval function held for both opening and closing streak interruptions. It consumes per-reading coverage set by the adapters, so A07/B07 enter through a misclassified interval. The two-way decision fence survived an ABA sequence: review the original disposition, change it, undo back to the same visible state, submit against the old seq. U01 got 409. The page can age correctly reported timestamps independently, and U02 demonstrates what happens when the service sends a newly refreshed reading for old data.

## Owner impact and new defects

The order reflects decisions the owner might make incorrectly or have to repeat. Each identifier expands to the command above.

1. **A fresh-looking quiet strip can hide missing observations.** B01/U02 returned and rendered quiet for an out-of-window point. A07 discarded an unidentified alert. B07 silently turned an unrecognized provider response into an empty, fully read window. A10 can add a full retry delay after a delayed first pass. These occur on valid configurations.
2. **A committed reading or challenge can change on restart.** R05 filed `not_real`, killed the service before the peer returned to idle and made the replacement say `real`. The recorded slot was `'real' !== 'not_real'`. The transition sweep independently found `Replacement reading` and `Replacement challenge` where the committed originals should stand. A program that already has a valid filing has enough information to finish its transaction locally.
3. **An answer can look certain with no evidence.** R11's whole rendered turn was `Is checkout fixed? / All orders recovered.` after zero reads. R07 obtained `0 matching environment evidence pieces` on the same environment whose problem had a checkout line. The responder is given an empty evidence set for environment and source focus. R10's code-only verdict showed `Real / 1 of 1 said real · challenger upheld`. The positive “observed” badge disappears, but the owner needs a direct statement of what was checked. E01 got `observed:true` for a reader and challenger citing only the service-generated monitor title, exposed as an epoch-dated `problem` piece. R08 configured a real telemetry source named `history`. Verdict was real, observed was `false !== true`. Source labels are doing work that requires a typed evidence origin.
4. **A question can disappear into failure or reach the model twice.** R06 produced `failed: no answer: OpenCode answered 503 for /api/session` and failed to deliver after recovery. R14 killed after the peer received the prompt, restarted, and got **two deliveries** for one question. The job and its message receipt need the same durable identity across the uncertainty window. E02 closed a previously answered peer session, then sent an auto follow-up. It got `no answer: OpenCode answered 404 for /api/session/…/prompt` and parked instead of opening a new conversation. The queue priority itself held under ten automatic investigations in R16. A separate accelerated day drained 72 automatic investigations and 24 owner questions over 24 simulated hourly arrivals, with a SIGKILL halfway and peak peer activity no higher than two. This measures scheduler progress rather than a day of real inference latency.
5. **Historical briefs change after the chosen fence.** R01 froze a team brief containing `1 problem still open`, marked the item Done, then requested the identical fence. “Still open” and “Impact” changed to `None recorded.` The opening/closing disposition and count need an as-of representation. R19 got `it is not a real problem` without disclosing that *all* readers said real and the challenger overturned them. R20 returned `no canonical evidence reference` despite available cited handles in the owner brief. The team brief omitted commands, raw text and session IDs in the tested inputs.
6. **Owner writes have an idempotency gap.** R04 killed on the commit of a correction before the request receipt committed. Retry produced **2 corrections instead of 1**. In R02 two simultaneous identical handoffs returned the same result but created **2 peer sessions**. R03 reused the key for another subject and got **HTTP 200**, expected 409. The exhaustive request-write sweep took real SIGKILLs: `probe "W ask"` held at all 6 cuts; `probe "W open"` made 2 peer sessions at cuts 1, 2 and 3 of 4; `probe "W correction"` made 2 correction rows at cuts 3 and 4 of 5. A fresh database transaction cannot undo a peer session that has already opened.
7. **Some local notifications stay lost after the documented repair.** R18 installed the fake helper and restarted as instructed. The prior notice remained `parked`, expected `delivered`. R25 did Done and Undo on a production error, verified the item was back in Needs you, then saw **1 notification instead of 2**. R17 killed during helper delivery and observed two invocations with the same group, one final delivered intent. One audible signal per crash is outside the contract.
8. **Restore validates only declared relationships.** A11 and B11 each changed one reference in a detached backup. Both restored successfully. A closed set of table/column constraints would make the limitation honest. Business-state references stored inside JSON results also need an explicit ownership decision.
9. **Smaller decisions still cost the owner work.** B13 lost the second monitor occurrence after recovery. U03 edited the brief while the new audience request was outstanding. The eventual template replaced the edit. A16 left two missing agents for the installer to discover during use.

## What the model and page actually establish

R09 combined one real, one not-real and one missing vote and rendered each count in the verdict area. The aggregate read “Undecided” and included “1 did not file”. Distinct rows name each slot. An upheld real majority with dissent still carries its numbers. The code-only and zero-read cases above need visible negative information.

For R12 I had every reader file the same printer diagnosis on the same checkout log, and a challenger agree on that line. Four independent sessions returned identical evidence text with separate handles. The result was `["real",true,3]` for verdict, observed and real votes. That meets the current adjudication table. It demonstrates exactly why “observed in telemetry” is too strong for a causal claim. A label such as “the readers cited telemetry” and the number of distinct underlying observations would convey what code checked. Handle validity does not measure relevance. The verdict must not by itself authorize a repository change.

Two complete valid filings from one reader do not count twice (R21). A challenger trying to file a reader vote was refused before its valid challenge. Retired sessions lost both filing and owner capabilities after restart (R22). The ordinary owner session positive control succeeded, the unknown session and the previously valid session with OpenCode down were denied (R13). The peer, SQLite backup, notification argv, answer, correction, brief and playbook probes used named synthetic credential markers (R24). All were clean, with a positive control that the new notification and answer actually existed. Rebuilding from SQLite removed an edited playbook and preserved a multiline correction as one JSONL object (R15). E03 refused a retired attempt's evidence in a replacement reader and accepted its own fresh handle. E04 put inert requests for another playbook entry into deployed code, owner guidance and the owner's question. All reached the intended inputs, and the durable playbook still contained only the owner's single correction. These observations concern the tested formats and peer protocol. A scripted respondent establishes program behaviour and has no bearing on whether the owner's model follows planted instructions.

## Keyboard use on this iMac

One run per fixture in system Chrome, 1280 × 800. Values are elapsed milliseconds from actual key input to verified visible completion, including requests and rendering. They exclude a person's reading and decision time. The clipboard was replaced inside the temporary browser. The copy driver verified the exact edited bytes. The shared preview opened the demo but returned “The browser is not producing screenshot frames” on both capture attempts.

| Task | Demo (5 problems, 3 environments) | Fleet (200 problems, 6 environments) |
|---|---:|---:|
| Done / Undo | 640 / 841 | 95 / 81 |
| Later, confirm / Undo | 804 / 1,016 | 78 / 78 |
| Never, confirm / Undo | 568 / 1,110 | 72 / 63 |
| Find, Enter, correct result focused | 550, archived “search index rebuild” | 146, “worker ab” |
| Focus bar, type, queue acknowledged | 578 | 62 |
| B, edit, Tab to Copy, confirm edited bytes | 136 | 81 |
| Clear every visible row with D, verify committed empty inbox | 2,319 for 4 | 11,155 for 200 |

The fleet collected 34/34/33/33/33/33 actual problems from namespace-specific fake logs. It contained completed unanimous, divided and missing-vote investigations, queued and actively held investigations, and a parked unanswered job. An exhausted investigation normally **completes as unsure**; “parked” in this fixture is an answer. The state checks ran before opening the browser. To measure the full clear, the driver expanded folded groups before starting its timer. The fleet contains the same worker label in multiple environments. The finder timing proves reaching a selected match. The archived demo lookup checks the distinctive historical query.

At 1280 px all six fleet health cells fit across the top, although “Needs a look” wraps in every cell. On the focused divided result, an amber panel contained all three individual votes and the challenger’s quoted line above the bottom bar. The “2 of 3” count was considerably quieter than the bright “Real” word and telemetry badge. In the demo, the QA sign-in repair was visible above the strip without opening a menu.

I would enjoy doing a morning pass this way. Search found an archived issue without reopening it. D/U made a mistaken dismissal inexpensive. Working stayed expanded after reload in both fixtures. Enter with no focus opened the finder directly. One seen row after navigating the fleet was a better signal than eagerly marking each row crossed. The question stays on its item and the edited brief can leave on the clipboard without sending anything to colleagues. What would annoy me is having to inspect small omissions to decide whether “Real” means code inspection or actual telemetry, and having to reconstruct a frozen brief after someone tidies the inbox. Attractive keyboard timings do not buy back a mistaken all-clear.


## Reproducing the builder's claims

The original acceptance files were byte-identical from `a7f0bac` to `4de1027`. On each of Node **23.11.0** and **22.13.0**, the original suites produced M1 **97/97**, M2 **52/52** and M3 **24/24**, with zero original cases skipped. The M1 run included both storms, all measured collection write cuts, a separate `21fdca3` executable and both directions of writer contention. Counts refer to the original test names when run alongside additions. Typecheck and all **67/67** builder tests passed on both exact versions. The two manual builder probe files passed **38/38** on Node 23, including the current Unicode folding case. The past intermediate failure is the builder's account. The current corrected behaviour is independently verified.

A dependency-free `git archive 4de1027` accepted the setup guide's sample config, printed `{"version":2,"watchers":1}`, and returned offline `live=false, seq=0, stale`. Its demo served the application from the isolated temporary home. Counting nonblank lines apart from lines starting with a comment marker gave **4,184** in src and **945** in the web JS modules. The separate `test/real/snapshot-size.ts` benchmark made 20 snapshots per fixture. At 200 problems and six environments I measured **88,736 bytes, median 3.2 ms, p95 5.1 ms**. At 500, **216,459 bytes, median 7.6 ms, p95 14.7 ms**. Those are serialized ASCII fixture sizes and whole-snapshot construction times, distinct from the Chrome task times.

The native OpenCode 2.4.1 binary, with a temporary config, scripted loopback model and fixture tools, produced **5 valid, 5 correct, 0 false-real, 0 planted-marker compliance, peak 2** on the trial. A 2-real/1-not-real investigation finished real, challenger upheld, observed true. An actual constrained responder returned an answer. A correction was committed and reached all three logical slots on the following investigation. Native catalog, MCP connection and investigator permission checks succeeded. Doctor exited 4 because fixture dependencies such as launchd and deployment discovery intentionally lacked real installations. The original real-adapter driver let doctor's registry ping reach the public npm registry on the first run. I corrected the harness to serve that ping on loopback and repeated it. No model, incident, or playbook content was sent to the registry. The strengthened acceptance result uses the loopback run.

Use `/Users/brandon/.local/bin/codex-heavy -- node accept/review-extensions.mjs` for the disposable extension experiment. One important qualification to the runtime result: the **full typecheck rejected the third kind** in `test/classes.test.ts` with TS7053 because the property test's identity policy had no `capacityFixture` key. That test is a valuable build-time signal. It did not reject the structurally non-finite Sample or the schema omission. Current production configuration rejected the unknown kind outright.

## Setup and customization as a fork maintainer

| Guide claim or step | What I could establish |
|---|---|
| Get to a demo without installing packages | Yes. A normal config is required even for `demo`. The documented JSON and absolute config flag worked in the clean archive. Demo uses seeded local data. |
| Configure the three agents, owner tools and skill | The setup guide gives complete role names and distinguishes MCP action names such as `ow_ow_finding` from tool names. The skill names inbox, get, search, act and undo. A temporary native peer exercised the three constrained roles. The owner's independent fake session read and acted via the same MCP endpoint. Doctor's `agent` result checks the investigator only, which the guide discloses. A16 shows exactly what is left for a fork to inspect manually. |
| Supply the OpenCode password | The guide distinguishes the OpenCode Basic password from the MCP bearer token. Its explicit `opencode.url` example also supplies an environment reference for the password. Existing acceptance exercises both explicit and registration-file discovery. |
| Customize readings and playbooks | Configured 1/2/3-reader cases use the planned denominator. A correction survives restart. Later readers see a frozen per-app snapshot. File edits are discarded at rebuild. The guide gives examples the owner can actually enter. The interface forbids exposing “playbook commentary” to the challenger while the guide explicitly gives the challenger guidance. The implementation appends it. Specify whether owner guidance is part of the challenger's inputs. I favour withholding it to keep the challenge independent. |
| Trust the interval and the notifier repair | The using guide describes a brief built between two event positions. R01 shows mutable state leaking across that fence. The notification's suggested install-and-restart can help future notices, while R18 shows the parked one lacks a retry action. State which notice will be recovered and let the owner retry it. |
| Reach a working install in ten minutes | The guide gets a prepared colleague to a foreground service. The shipped command list has no install, restart or uninstall. The guide asks doctor to inspect an existing launchd job but gives no end-to-end installation of that job. Neither a clean demo nor a working foreground fake establishes clone-to-installed-service time. |

## Milestone 4 handoff

Revision 5 in `simple-core-interfaces.md` contains the decision table, allowed changes, isolated verification and bounds, draft payload, publication/recovery rules, forecasting method and staging comparator. The prospective suite enters via CLI configuration, trials, real collection and investigations, and observes Git refs, the fake gh host and public API. Its positive fixture control can run before implementation. The product cases currently stop at configuration admission. Their later assertions are executable specifications and have not passed against an M4 product.

The open choices I settled were:

- Opt in by app. Require the selected GLM 5.3 investigation trial and a separate two-positive-case fix trial with a refusal control. Require three of three real readings, upheld challenge, observed exact onset and a pinned, directly reversible deployment. An investigation-only pass has a zero fix denominator.
- The model selects a single-parent inverse or a single existing JSON scalar to restore. Code derives bytes from the previous commit and checks the entire tree, mode, scope and size. No free-form patch or shell tool. A clean isolated runner executes the app's trusted argv. Failure or a moving base invalidates the candidate before any remote ref changes.
- Draft against the configured base on a dedicated unprotected head. Persist a stable attempt identity. A closed unmerged PR leaves the issue open. Merge must be followed by an observed deployed descendant in the same environment and three new fully measured quiet intervals before automatic Done. A newer owner disposition wins.
- For time-left, require six fresh, distinct, consistent observations of used capacity and a fixed ceiling. Use the median pairwise slope, explicit units and a 24-hour display horizon. A shortage of data yields an explanation and null ETA.
- Compare two aligned fresh intervals after a staging rollout against unchanged production. A new staging-only fingerprint present in both intervals with at least three admissions is a regression signal. Incomplete production coverage is unknown. The comparison has no promotion authority.

## What stands between this and an A

1. Preserve one receipt per owner intent and one binding per committed role/slot filing. Finish locally from the committed vote on restart. Reconcile a prompt, interactive handoff and notification against the same ID before issuing another. A temporary OpenCode outage should visibly pause work and resume it. Repeat C, R02–06, R14, R17–18 and the mixed queue tests.
2. Give every reading a validated shape, provider observation time, window and completeness. Carry those same values into coverage, health and the browser. Register current relationships with enforceable keys or verify their completeness against the schema. Count transitions into an alert independently of the highest count historically observed in that state. Repeat A07/A10/A11 and B01/B07/B11/B13 with the failure assertions intact.
3. Give evidence an origin separate from its display name. Say “no telemetry confirmation” for code-only findings and “no evidence cited” on an unsupported answer. Make the responder's actual scope match the selected environment/source. Keep distinct observations, code provenance, minority readings and challenger disproof visible. A panel should never require remembering what an absent badge would have said.
4. Make a fenced brief historical, preserve owner edits in flight and repair notification recovery. Keep the speed, keyboard behaviour, shared seen state and exact clipboard bytes established here. Verify all three configured agent roles and finish the installation path.
5. Pass the prospective M4 tests before enabling publication. Then collect the owner's corporate proxy/launchd doctor, two days through sleep and network change, actual local delivery, the configured GLM trial results or a verified disabled gate, and a colleague's timed clean install. Neither independent fake peers nor accelerated clocks can supply those results.

**Design verdict.** Continue the rewrite. SQLite, stable keys, local Git objects and a single owner-facing screen are still a small enough foundation. The two repeatedly failing boundaries now have names: time/provenance at observation and receipts across process boundaries. An A requires those to survive ordinary restart and a misleading model. Increasing the number of readers alone will not get it there.

## Test ledger and limits of the review

| Suite on the unchanged product | Pass | Fail | Skip | What the denominator includes |
|---|---:|---:|---:|---|
| accept/m1 | 118 | 8 | 0 | 97 existing cases and 29 fresh neighbours. Long release mode with predecessor |
| accept/m2 | 53 | 2 | 0 | 52 existing page/API cases and U01–03 |
| accept/m3 | 46 | 21 | 0 | 24 existing cases, 25 R cases, four E cases, ten investigation cuts, three exhaustive request-write sweeps, one accelerated day |
| accept/m4 | 1 | 13 | 0 | One independent host/remote control; 13 prospective product cases |

The M3 total includes one vote for each write sweep and one for the whole accelerated day. For reproducibility, the final Node 23 M3 run comprises 45 pass / 19 fail for 64 cases and 1 pass / 2 fail for the three W sweeps. The controls in A/B and R/E test particular histories. Multiple reds can have the same root cause. There were two passing timed owner journeys outside these totals. Both versions ran the original suites. The extended Node 22 run also reproduced all eight M1 reds and both M2 reds.

**Test repairs.** The old owner timing driver reported whether a brief editor existed immediately after pressing B. I replaced that diagnostic with a wait for real text, keyboard editing, focus checks on the textarea and Copy button, and exact clipboard comparison. The actual native adapter smoke previously accepted an empty reader sample because `every()` on no prompts is true. It now requires slots 1, 2 and 3, the returned answer and the upheld outcome. The registry ping is local. R01 advances the owner state *after* obtaining a historical fence. Simply repeating a read after restart with no business change had been too weak. R21 tries two **valid** filings with the same valid handle. Refusal of malformed arguments alone would not establish one vote per slot. I corrected E01 during the review: a telemetry piece prefixes the text with its timestamp. Removing that prefix before comparing the title exposed the false positive. R09/R10 now open the actual item after stream readiness. Early keypresses had tested navigation timing instead of the verdict.

One repeated Node 23 Chrome run stalled in the prior page test file and I stopped that file process. A first retry applied a 45-second timeout to the **whole file**, cutting off its last cases. That run is excluded. The full Node 23 retry with a 120-second file timeout finished 53/55 with only U02 and U03 red, matching the full Node 22 run. The M1 process kill sweep covers each measured collection write. The M3 C/W sweeps cover the named public investigation transitions and actual writes for the three owner operations. Answer dispatch, notification delivery and completed-transaction restarts have separate cuts. This is finite coverage of external failure orderings, with no claim about all filesystem, host and network interleavings.

**Contract changes worth making before release.** A handle proves which bytes a session received. “Observed in telemetry” currently claims more than that proof supports. “Challenger disproved” should distinguish disproving a proposed cause from disproving the underlying symptom. A verified monitor sample should have an origin independent of its user-chosen source name. The epoch-stamped fallback title has neither a sample identity nor an observation time. A parked notice's repair should specify what happens to *this* notice. Finally, clarify the interaction between the challenger's independence and owner playbook commentary, and spell out whether an explicit owner Undo should notify. R25 tests the current transition-based notification contract.

## Delivery commits

- `d9c9bab` adds the M1–M3 black-box probes, process cuts, owner timing and reproducible extension experiment, and strengthens the real adapter harness.
- `431dd02` adds the prospective revision 5 contract and M4 acceptance, including the local bare Git remote and gh ledger.
- The closing commit, **Record independent milestone 3 assessment and release ledger**, contains this report. `git log --oneline 4de1027..HEAD` gives its identifier alongside the two above.

All changes are local to simple-core. Corepack initially added its local package-manager pin while running the builder check. I restored the manifest and lockfile and disabled auto-pinning for subsequent checks. The assessed product code, manifest and lockfile match the assessed commit.
