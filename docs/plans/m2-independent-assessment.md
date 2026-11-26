# Independent assessment of milestone 2

**B− overall, up from C+ at `179ce74`. Return the page and kernel to the builder before accepting M2.** Assessed `21fdca3` on `simple-core`. All 21 original reproductions closed. On one different, executable probe per repair, **13 of 21 held and eight broke**. The cleanest improvement is the admission and ownership path. A SIGKILL, a predecessor owning the file, replay on the same saturated stream and shared provider identities across apps all have good evidence. The largest remaining risk for the owner is a convincing quiet display while a source is no longer measured.

## Section 11 grades

| Area | Previous → current | Evidence deciding the grade |
|---|---|---|
| Correct inside the limits | C+ → C+ | The original crash, two-way ownership and replay results held, and the page fences stale undo. Health still goes green over invalid input or a hung collector. A failed measurement can clear a real breach. Two real browser interactions can queue one draft twice, or replace a different tab's decision. |
| Honest beyond the limits | C → C+ | Both storms, the fresh post-storm admission, historical floor, incremental reclaim at three page sizes and explicit pause all worked. Losing the reserve on the failure branch still writes. Pressure removed all five cited trial handles. A page with an uncountable record was called complete. |
| Real | Incomplete → Incomplete | Real macOS processes, system Chrome, git and SQLite. All outside services and commands under observation were fixtures. The corporate proxy, actual launchd environment and a two-day sleep/VPN trace remain owner gates. The restored connection in Chrome is a local link experiment. |
| The model | C → B+ for the gate, private model incomplete | Changing model disables the gate. A passing model that subsequently fails loses approval even after restart. When both original peer sessions stay busy after their deadline, new attempts actually finish the five cases. The scripted trial and its fake peers establish mechanics. GLM 5.3 accuracy, the cost of its mistakes to the owner and responsiveness behind the private endpoint are unmeasured. |
| Useful | B− (kernel) → B (through M2) | The keyboard clears 200 rows, all three ways out undo, the finder opens a previously archived problem in under one second in the recorded timing run, and a focused question queues. Source focus, prompt feedback, stale sheets and the meaning of “new” all cost attention. Answer and copy are M3 requirements. |
| Simple | A− → A− | No runtime dependencies or build. A clean archive with no node_modules ran check and offline status. The browser code is small enough to trace from keystroke to write. A colleague's ten-minute setup through successful doctor remains unmeasured. |

The overall grade reflects usable progress over M1. It is still the grade at which the previous design stalled. Passing all tests written for the preceding build did not establish the cross-boundary guarantees.

## Reproduction

Use Node 23.11.0 or 22.13.0. Tests start the executable in temporary homes and configuration directories. The command below selects a separately archived compatible predecessor. It exercises current-first, predecessor-first and simultaneous first acquisition, including release after SIGKILL. No independently distributed release binary was available here.

```sh
prior=$(mktemp -d)
git archive 66004b1 | tar -xf - -C "$prior"
M1_LONG=1 M1_OTHER_BIN="$prior/bin/overwatch" codex-heavy -- \
  node --no-warnings --test --test-concurrency=2 accept/m1/*.test.mjs
codex-heavy -- node --no-warnings --test --test-concurrency=2 accept/m2/*.test.mjs
codex-heavy -- node --no-warnings --test --test-concurrency=2 accept/m3/*.test.mjs
codex-heavy -- node --no-warnings --test --test-concurrency=1 accept/m2/owner-timing.mjs
```

These shell functions expand every case reference below into its focused reproduction. N20 uses `node --no-warnings --test --test-name-pattern=65536 accept/m1/storage-edges.test.mjs`. Browser cases need the installed Chrome or CHROME_BIN.

```sh
probe() {
  case "$1" in
    N*) file=accept/m1/neighbours.test.mjs ;;
    P0*|P10|P21|P22) file=accept/m2/decision-edges.test.mjs ;;
    P*) file=accept/m2/page.test.mjs ;;
  esac
  M1_LONG=1 node --no-warnings --test --test-name-pattern="^$1 " "$file"
}
```

### What survived one step away from the 21 original defects

Each row has one vote. “Held” describes this probe only. The original tests remain in the release suite and do not enter the denominator.

| M1 defect | Different condition | Result and observed output |
|---|---|---|
| 1. Null becomes a measurement | `probe N01`, valid numeric-string syntax but non-finite value `1e999` | **Broke**. Actual `[metric rows, quiet] = [1,true]`, expected `[0,false]`. The string branch does not recheck finiteness after conversion. |
| 2. Untested model approved | `probe N02`, same model passes, fails a new trial, service restarts | Held. Automation switched from true to false and remained false. |
| 3. First fresh occurrence after saturation lost | `probe N03`, fresh record in the original stream after SIGKILL inside the overlap lifetime | Held. Storm and fresh totals were `[50000,1]`. |
| 4. Unmeasured sibling clears breach | `probe N04`, a failed pod-list canary between low samples | **Broke**. `breach:false`, expected true. The missing sample passed through source failure and bypassed the streak reset. |
| 5. Kubernetes EventSeries cumulative count | `probe N05`, deprecated counter 4 → 2 → 8 alongside legacy count 1 | Held. The recorded total was 8. |
| 6. Container identity missing | `probe N06`, current instance exists, prior restart is known, previous identity absent | Held. `["gap",1,false]` for coverage, count and exactness. |
| 7. Loss leaves an exact total | `probe N07`, next Datadog page contains a timestamped row for the active problem without a stable ID | **Broke**. `["ok",true]` instead of `["gap",false]`. Silently dropping the row can hide missing arrivals. |
| 8. Reserve lost mid-read | `probe N08`, space falls while a pending read ends in rate refusal | **Broke**. `[paused,seq increase,checkpoint]=[null,1,1768910400000]` instead of `["disk",0,1768910400000]`. Failure writes take a different path from slice admission. |
| 9. Persistent size pressure | `probe N09`, pressure after a successful trial has aged eight days | **Broke**. `0 !== 5` cited handles survived. Deleting the referencing findings just before deleting the evidence does not meet the owner's retention decision. |
| 10. Suspended retry after clock rollback | `probe N10`, confirmed Datadog sign-in failure, restart one day behind, five minutes elapsed | Held. The suspended source recovered and cleared failure. |
| 11. Invalid restored references | `probe N11`, a detached backup's hourly row points to a nonexistent incident | **Broke**. Restore returned exit 0 with `seq:1`, expected exit 5. The new rate table is outside the reference checks. |
| 12. Deadline holds both slots | `probe N12`, keep both original sessions busy through completion of the replacements | Held. Five valid filings, seven peer sessions, exit 0 before releasing the original peer waits. This establishes driver progress, not forced cancellation of remote inference. |
| 13. Recovered gauge keeps health in attention | `probe N13`, an existing Datadog monitor falls from Alert to Warn | **Broke**. `[1,"error","attention"]`, expected `[1,"warn","quiet"]`. It retains the highest past severity even with a measured lower state. |
| 14. Shared endpoint repeatedly refused | `probe N14`, two credentials on one Datadog site share the API key but use different application keys | **Broke**. Failures `["signin","signin"]`, expected `["signin",null]`. The second application's valid credential never gets its read. |
| 15. Registry diagnosis certifies refusal | `probe N15`, 503 at registry ping | Held. Proxy check failed and named 503. |
| 16. Doctor passes unusable investigator | `probe N16`, matching wildcard allow followed by a deny of just filing | Held. Agent check failed and named the filing tool. This measures the specific last-match case. |
| 17. Overlap enters declared gap | `probe N17`, Datadog's five-minute overlap at fourteen days plus one minute | Held. Counts before and at the floor were `[0,1]`. |
| 18. Inclusive end | `probe N18`, provider returns end inclusively, restart and two replays | Held. Counts `0 → 1 → 1`. |
| 19. Missing repair | `probe N19`, Datadog repair after restart and after credentials recover | Held. Fix named DD_APP_KEY while failed, then became null. |
| 20. Reclaim spends too many bytes | 65,536-byte SQLite pages, 24 MiB disposable padding | Held. Positive reclaim at or below 16 MiB in the first pass, subsequent progress or exhausted freelist. |
| 21. Demo renewal has no event position | `probe N21`, renew after moving wall time back a day | Held. Sequence advanced, QA remained signed out, zero external calls. |

Separately, `node --test --test-name-pattern='shared provider IDs' accept/m1/neighbours.test.mjs` gives both apps counts `[1,1,4]` on identical Datadog ID, Kubernetes log identity and Kubernetes event UID after a kill and replay. This confirms the additional source-scoping repair outside the 21-case denominator.

## Owner-impact order and page defects

For a combined fix queue, I would use this order. The N rows above and P rows below give commands and outputs.

1. False reassurance during ordinary operation (P11, N01, N04, P01, P02).
2. Lost or overstated evidence for a decision (N09, N07, P06).
3. Lost owner intent or a missed return (P15, P03, P12, P13).
4. A healthy data source suppressed or a recovered monitor still urgent (N14, N13).
5. Evidence retention, restore and disk admission (P09, N11, N08, P07). N11 requires a damaged detached backup. N08 preserved the checkpoint in this experiment.
6. Inaccessible subjects, missing search results and stale question history (P17, P08, P21, P18).
7. Unusable narrow layout, misleading event or interaction labels (P14, P05, P19, P20).

| Priority | Command | Trigger and observed consequence |
|---|---|---|
| 1 | `probe P11` | Start with measured quiet. Hang a Datadog read, advance the service beyond source freshness, then independently observe a fresh SSE heartbeat. GET status says `stale`; Chrome's strip still says `quiet`. A live transport cannot certify fresh measurements. It stays wrong until another business snapshot. |
| 2 | `probe P01`, `probe P02` | Three replay-only polls at one wall position made `active:false`. Two empty intervals, a six-hour catch-up, then one interval also made `active:false`. Expected true in both. The first path increments a streak on a repeated window, the second carries a streak across sleep. |
| 3 | `probe P15` | Tab B opens Later; tab A confirms Never; B confirms its old sheet. Stored way is `later`, expected `never` pending a renewed decision. Current undo fencing protects a different operation. This test makes the stale-confirmation policy explicit. |
| 4 | `probe P03` | Put away with Done, set wall back, restart, pass the elapsed grace, admit a new observation. Count rose to 2; `returned?.code` was undefined instead of `again`. Lazy deadline reconstruction starts the delay at the first relevant arrival. |
| 5 | `probe P12`, `probe P13` | Two physical Enter submissions while focus lookup waits produced **two** asked events for one draft. Separately, hold a successful ask response, type the next draft, release the response: the bar contains `""` instead of `"second draft"`. Keying the API alone cannot protect either browser race. |
| 6 | `probe P06` | Remove one of two identical retained occurrences before Later/worse. Its baseline is known incomplete. Five new records returned the item, clearing its way (`undefined` instead of `later`). The observed lower bound cannot establish the denominator of the ratio. |
| 7 | `probe P17` | Click the listed source inside an environment. Focus remains `env:shop/prod` instead of `src:shop/prod/pods`. The API has a source subject; the page cannot ask about it directly. |
| 8 | `probe P09`, `probe P07` | With ample space, a mature uncited real piece still had one search hit instead of zero; the cited control remained searchable. At 31 days the historical hourly rows were `[[491363,1],[492106,1]]` instead of just the newer bucket. Replay/catch-up attributed the new log to its actual hour and counted it once. Age policies currently depend on size pressure. |
| 9 | `probe P08`, `probe P21` | A lowercase search for café returned `[]` for a stored CAFÉ title. For a literal query matching 51 distinct titles, only 50 subjects were reachable. There was no next cursor. |
| 10 | `probe P18` | With an incident already open, asking produced a success toast and a durable event. The same stage timed out with “queued question absent from open history”. A fresh detail GET has the question. Incident occurrence seq is an insufficient invalidation key for detail. |
| 11 | `probe P14` | A log title with literal `<em>`, a tab and a long word remained text; the heading gained no em element. The focused document grew to **1,343 px at a 756 px viewport**. The layout failure is independently observable from the correct text rendering. |
| 12 | `probe P05` | The action event described its new way with `seq:0` while the stored way had `seq:3`. An event reader cannot reuse the purported disposition position as an undo fence. |
| 13 | `probe P19`, `probe P20` | A regrouping with zero arrivals displayed `1 new\nr`. Enter from no focus selected the dock textarea instead of opening the finder (`matches('[data-search]') === false`). The first is an owner-facing label change to an otherwise specified buffering rule; the second contradicts the guide. |

The other temporal controls matter. P04 saw exactly one ordered deadline return after a restart with a clock rollback, then a 409 on stale undo. P22 checks replay of a seen fence at the same sequence and a positive admission with old source time after Done's grace. Distinct committed events cannot occupy the same SQLite integer primary key. The relevant same-position input is a replay, not two invented commits with identical seq. P10 sent concurrent identical API requests and found one event, no named sentinel in stored tables, history, search, status or recorded peer requests. M2 dispatches no prompt externally. The M3 suite separately requires redaction at actual responder delivery and answer rendering. The original Chrome row-position/draft test still passed. P16 independently forced a failed status response and a late successful response with a wall-clock sleep jump; both left the strip unknown and the page down while disconnected.

## Using the page

System Chrome with its own temporary profile at 1280×800, one sequential timing run per fixture. Times below run from keyboard input to verified visible completion, including local request and rendering time. These are automation timings on this machine, without human reading or typing time. They are single observations, not percentiles. The fleet uses 34/34/33/33/33/33 problems across six independently configured namespaces. It is collected from the fake provider through the normal service. The demo has five seeded problems, including one already archived.

| Task | Demo | 200-problem fleet |
|---|---:|---:|
| D on focused row / U to restore | 558 / 799 ms | 138 / 110 ms |
| L, Enter / U | 823 / 960 ms | 62 / 66 ms |
| N, Enter / U | 643 / 841 ms | 60 / 64 ms |
| Slash, type query, Enter, correct result focused | 923 ms, archived “search index rebuild” | 160 ms, “worker ab” |
| P, type, Enter, queue acknowledged | 334 ms | 144 ms |
| Clear every inbox row with D; verify committed empty inbox | 3,243 ms for 4 | 14,164 ms for 200 |
| B, edit and copy a brief | No editor | No editor |

The last row belongs to M3. The ask timings end at queue acknowledgement. The mass-clear test validates machine feedback and target selection while the previous row leaves; a person still has to decide on each incident. The shared preview could navigate but twice reported “The browser is not producing screenshot frames.” The timing and rendered tests used installed Google Chrome over its debugging pipe. Neither environment used a real cluster.

- **Working and Quiet folded** is a reasonable default for a crowded inbox. Losing the expanded Working group at every reload is annoying for someone tracking a question. Both runs reopened it and observed `aria-expanded=false` after reload. It is a preference gap, not a violation of the original contract.
- **“N new”** holds the row steady as promised. It also asks the owner to interrupt reading for an apparent arrival when the only change is that an old row went quiet. P19 separates that misleading signal from the valuable position freeze.
- **Queued prompts** have a toast and a “Queued for an agent” row in Working. Those are useful immediate cues. After the toast fades the group may be folded and the open history can omit what was just sent. A durable question and an explicit queue state on the focused stage would earn trust even before answer delivery.
- **Enter with no focus** has a reasonable find intent. The actual first Enter focuses a textarea, and the finder opens only after entering a query and submitting it (or with slash). This adds a mode the label does not explain.
- **J marks passed rows seen.** The service correctly shares those marks. J/J while looking for a target and automatic focus after a way out both count as viewing. The demo ended with three seen rows and the fleet with four before mass clear. “Seen” can be useful navigation history; as an unread-work signal the dot is too eager.

**Design judgement.** The retained reticle, dark surfaces, hairlines, distinct strip glyphs, keyboard hints and always-visible prompt target work together. My fleet screenshot showed all six health cells at 1280 px, a clear production priority and recognizable focus; six cells also force “Needs a look” and its count onto several lines. The rail uses up to 400 px against the design guide's 380 px, and the 24 px overview title exceeds its four-step 18 px scale. The decision mock-up gives a reason and grouping context prominent space. The live public page provides that context for returns and findings, but a new error row can offer little beyond title, count and a tiny sparkline. The full history/queue state and narrow long titles matter more than the cosmetic differences. I would enjoy the shell and shortcuts for a daily pass. I would still cross-check green and verify an unanswered question manually before leaving it open all day.

## Verification and acceptance ledger

The original acceptance tree was byte-identical to `3fc29ad` at the assessed commit (`git diff --exit-code 3fc29ad 21fdca3 -- accept`). Baseline release on Node 23.11.0 was M1 **75/75** with M1_LONG and M1_OTHER_BIN, M2 **30/30** with Chrome. The 50,000 and 250,000 storm cases and kill after each measured mutation/commit passed. The predecessor test ran in both ownership directions. `pnpm run check` passed typecheck and **50/50** builder tests on each exact Node 23.11.0 and 22.13.0. A temporary wrapper supplied Node's supported two-worker flag only to its test runner. No package install or monorepo build was needed.

A clean `git archive 21fdca3` with no node_modules returned `{"version":2,"watchers":1}` and offline `{"live":false,"seq":0,"health":"stale"}`. The manifest has zero runtime dependencies. With the builder's convention (skip blank lines or lines beginning with //, /* or * after whitespace), src has **3,342** lines and the JS modules have **705**. The claimed **366** HTML/CSS lines describe index.html plus page.css. Including the **120** additional nonblank, noncomment lines in the linked tokens.css gives **486**. The unused older style.css, logo asset and tests are outside that delivered HTML/CSS count.

| Run on assessed product | Pass | Fail | Skip |
|---|---:|---:|---:|
| M1 expanded release, Node 23.11, predecessor | 89 | 8 | 0 |
| M1 expanded release, Node 22.13, predecessor | 89 | 8 | 0 |
| M2 expanded acceptance, system Chrome, Node 23.11 | 34 | 18 | 0 |
| M3 pre-implementation acceptance, Node 23.11 | 1 | 23 | 0 |
| Separate timed owner journeys, two fixture sizes | 2 | 0 | 0 |

M1 adds 21 neighbour cases and one cross-source control. M2 adds 22 cases with positive controls, plus the timed driver outside its standard glob. The former stale test checked general body text and an attribute. I kept the held-request, age, draft, focus, disable and reconnect assertions, and added checks on the **actual header indicator's visible caption and computed color** in live, stale and down; the separate down banner must say “Service not answering”. Its green result now tests the displayed indicator. During development I corrected a case-sensitive fixture title lookup and sorted the rollback probe's fake log stream in provider order. It now requires a count of two before asserting the missing return. Neither fixture error is scored.

M3 has a green notification-executable control. The other tests are intentionally red on M2: missing routes, absent owner skill/tools and keyboard handoff/brief controls, no eligible automatic investigation or responder dispatch. An early missing interface prevents the downstream assertions in that test from running. This is a prospective acceptance suite, not 23 demonstrated regressions in M2.

## Documentation and decisions for the builder

The setup guide's isolated demo, configuration/check flow, no-build start, tool names and distinction between diagnostic checks and the trial are usable. The README correctly dates agent answers to M3. The using guide correctly distinguishes sign-in on first refusal from suspension on confirmation, documents the three ways out and describes ordinary source-scoped counts. The absolute language overstates what the current build can do:

| Where | What a colleague would infer | What to change |
|---|---|---|
| README, AGENTS, design philosophy | All unknown data is visibly incomplete, every relevant write checks space and the page can do everything on the keyboard. | Resolve N01/N04/N07/N08 and P11/P17 before promising those guarantees. Doctor's permission evaluator checks named actions in the catalog; an end-to-end trial remains a separate proof. |
| using/customizing | Three full quiet intervals, rate comparisons with known history, restart-bounded grace, 14/30-day expiry and permanent cited evidence. | Match P01–03, P06–09, N09. Distinguish normal age-based eligibility from pressure-triggered physical deletion. Hourly resolution is an explicitly rounded day. |
| setup | Any impossible restored value is refused. The disk-paused troubleshooting row appears twice, once naming only the free-space floor. | Narrow the restore assurance until N11 is closed. Consolidate both space limits into one repair. |
| using and the wire contract | Enter finds, open history includes prompts, source focus is actionable, broad searches reach every matching subject. | P17–21 give a quick fork smoke test. An open sheet's old decision needs its own fence. The revision 3 Done table names source event time; the binding owner decision uses admission time. |
| design.md and mock-ups | References to web/src, Foldkit, a build script and dist look current to a new contributor. | Label the historical implementation paths. Retain the visual tokens and examples. Historic council and command-center plans are evidence of design intent. |

**M3 choices made here.** Revision 4 fixes the strict majority of *planned* slots, a visible missing category, independent evidence sets, one fresh challenger and an explicit undecided result when it fails. A minority that obeys an instruction remains a visible vote. Code verifies delivery and adjudicates agreements; a valid handle cannot certify the truth of a causal claim. The owner's ordinary OpenCode session can use four scoped tools. An answered conversation remains eligible on the same subject and pinned deployment, and explicit New, changed attribution or a failed/closed conversation starts another. O opens an interactive owner session with context. A correction becomes one dated JSONL record per app, rebuilt from the database, and the next job snapshots the latest 20. Briefs are fenced, editable, copy-only, technical or plain-language. Notifications use a durable local group ID, exit-code acknowledgement, two bounded retries and a visible parked reason. A crash can replay an audible signal. A replacement identifier does not prove exactly-once sound. These are implementation choices to review before building; no product code was added.

## What stands between this and an A

1. **Eliminate false quiet at both clocks.** Make the service publish or otherwise age measurement freshness while commits are idle. Make non-finite measurements, incomplete identity and interrupted consecutive samples flow to the same health and count decisions. A frozen or catch-up window must not establish three new complete intervals. Test the status value and the rendered cell while the peer remains hung.
2. **Protect the owner's decision and evidence across time.** Bind an open confirmation to the reviewed state, reconstruct deadlines on startup, distinguish unknown rate baselines, represent real monitor recoveries, and give every disposition one consistent event position. Protect cited material across every retention class; validate rate references on restore. Apply reserve and identity rules to failure branches and both Datadog credentials.
3. **Finish the usable page loop.** A double submit produces one intent; a delayed reply preserves the next draft; source, incident and environment focus all work; the open stage shows the queued text. Make the search traversal complete, clarify regrouped rows and contain long text at narrow widths. Keep the successful timing and screenshot checks.
4. **Close the expanded red suites at their actual interfaces.** Repeat both Node release baselines with the independent predecessor. Repeat live Chrome health, two-tab decisions and the 200-row keyboard tasks. Implement M3 against the prospective suite, including the challenger, a correction reaching future model inputs, an answered turn, editable brief copy and retrying local delivery.
5. **Collect the owner-only evidence.** Record successful doctor in the actual corporate proxy/launchd environment, two days with sleep and a VPN cycle, watcher deadlines and health transitions, and the configured GLM trial or positively disabled automation. Have a colleague time clone through a working setup. Predictive monitoring and verified draft PRs belong to M4 before grading the full section 3 product.

## Delivery commits

- `4bddd7c` adds the M1 and M2 probes, repairs the freshness assertion and records the keyboard timing driver.
- `b1437f3` adds revision 4, the pre-implementation M3 tests and opt-in peer capabilities.
- The final commit, **Record independent milestone 2 grade and reproduction ledger**, adds this assessment. `git log --oneline 21fdca3..HEAD` prints all three identifiers.

Only assessor tests, fixtures and planning documents changed. All commits are local.
