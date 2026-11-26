# Independent assessment of milestone 1

**C+ as the kernel of a personal software productivity tool. Return M1 to the builder.** Reviewed `179ce74` on `simple-core`. SQLite ownership, atomic collection and handle-based evidence are genuine improvements over the previous build. The owner still gets an explicit “quiet” over an unmeasured metric, loses a new error after a storm, and can see a new model as approved without running its trial. These are ordinary operating conditions. Keyboard commands and briefs are later milestones.

## Rubric

| Section 11 area | Grade | Deciding observation |
|---|---|---|
| Correct inside the limits | C+ | All 38 measured mutation/commit cut points recovered both sources exactly; frozen-wall ordering and ownership in both directions passed. A Kubernetes EventSeries that reached seven was reported as one. One measured container cleared a breach while its sibling was unmeasured. Restore accepted an item whose sequence had never existed. |
| Honest beyond the limits | C | The isolated 250,000-record storm, 501st fingerprint, 21st pod, byte cap and 14-day gap all produced recognizable limits. An incident still claimed an exact total after observed loss. The first fresh record after saturation disappeared, a record inside the declared historical gap was counted, and over-budget collection continued. |
| Real | Incomplete | Real macOS SQLite, git, process kills and OpenCode 2.4.1 were exercised. The scripted check deliberately used fake cluster/launchd/registry dependencies and returned doctor exit 4. No owner proxy/launchd sign-in or two-day sleep/VPN observation. |
| The model | C for the gate; owner score incomplete | The real native adapter with a scripted endpoint scored 5 valid, 5 correct, zero false real/compliance, 2 concurrent, one try each. Changing the configured model kept automation on. No private GLM run was performed. |
| Useful | B− for M1 | CLI status, an inspectable event history in SQLite, backup, covered/uncovered intervals and the isolated trial are usable. Missing sign-in repair, stale “attention” after gauge recovery and overconfident coverage cost the owner decisions. Full page/search/brief rubric belongs to M2/M3. |
| Simple | A− | A no-dependencies clone ran check and offline status. Exactly 2,741 nonblank noncomment service lines, zero runtime dependencies and no build. Source/tool boundaries are easy to locate. The colleague's timed ten-minute setup through successful doctor remains unmeasured. |

## Reproduced baseline

- Verified the original acceptance tree matched `68b51e9` using `git diff 68b51e9 179ce74 -- accept`. Release on Node 23.11.0 before edits gave 42 passed, zero failed or skipped. Both the 50,000 and 250,000 storm tests passed. The mixed-source crash workload measured 38 writes including commits.
- Typecheck and 31 builder tests passed under Node 23.11.0 and 22.13.0. On the cached exact 22.13.0 executable from npx, the original routine suite passed 39 with the three long cases skipped by design. A temporary Node wrapper supplied the supported two-worker limit to the package test script. All full runs used the shared heavy command gate.
- Before exposing any development modules to the temporary clone, `bin/overwatch check --config smoke.json --json` returned `{"version":2,"watchers":1}` and offline status returned seq 0, live false, stale. The manifest contained `"dependencies": {}`. The line count excluded empty lines and lines starting with //, /* or * after whitespace.
- Archived the earlier runnable, schema-compatible `66004b1` into a temporary directory and used its own bin/src as M1_OTHER_BIN. Current-first, predecessor-first and simultaneous start on a new database each left a single owner. SIGKILL released the lock. This is a real checkout-to-checkout test; no separately distributed release binary was available.
- Ran `OPENCODE_BIN=<2.4.1> node --experimental-strip-types --no-warnings test/real/opencode.ts` from the clean clone, with an isolated home, XDG directories, temporary registry address and the script's local model. Output included `trial exit 0`, `valid:5, correct:5, falseReal:0, obeyed:0, peakSessions:2` and one try per case. Native, model, agent, MCP and skill diagnostics passed. Registry, enterprise credentials and launchd were intentionally unavailable. No install or real environment operation took place.
- The protected-content growth sample ran two normal trials in the same small database. Standalone backups grew from 229,376 to 294,912 bytes. Evidence rows went 58 → 116, message intents 10 → 20, findings 5 → 10 and events 49 → 95. This measures ordinary small-scale growth. The pressure tests below use the documented space control for the 1 GiB and free-space edges. File reclamation uses real SQLite files of roughly 24 MiB.

### Run the assessment suites

```sh
prior=$(mktemp -d)
git archive 66004b1 | tar -xf - -C "$prior"
M1_OTHER_BIN="$prior/bin/overwatch" M1_LONG=1 codex-heavy -- \
  node --no-warnings --test --test-concurrency=2 accept/m1/*.test.mjs
codex-heavy -- \
  node --no-warnings --test --test-concurrency=2 accept/m2/*.test.mjs
```

## Reproduce the defects

Run from the repository root. These shell functions expand each reproduction in the table to its exact focused Node test. Use the release and two-worker command for the full sweep. Output below is the observed value, with the contractual value stated separately when needed.

```sh
one() { M1_LONG=1 node --no-warnings --test --test-name-pattern="$2" "accept/m1/$1-edges.test.mjs"; }
collect() { one collection "$1"; }
storage() { one storage "$1"; }
adapter() { one adapter "$1"; }
```

| Owner impact, in priority order | Reproduction | Observed output and consequence |
|---|---|---|
| 1. Unmeasured Datadog looks healthy | `collect 'Datadog null point'` | A null point produced `[1,true]` for [metric rows, health is quiet]; expected `[0,false]`. Conversion to Number turns null into zero. |
| 2. Untested model inherits permission | `adapter 'passing trial for one model'` | After a passing trial for model A and restart with model B, automation remained `true`; expected false. Approval lives in a single metadata value. |
| 3. Fresh error lost after storm | `collect 'fresh arrival after a saturated'` | With 50,001 prior records replayed and one new arrival, the new problem counted `0` instead of 1. The prior count stayed at 50,000. Skipped records still consume this pass's admission counter. |
| 4. Partial usage clears a real breach | `collect 'one measured pod'` | Two low samples from only one of two pods produced `["attention",false]` for health/breach; expected `["partial",true]`. The highest reported pod cannot speak for the missing pod. |
| 5. Cumulative Kubernetes events undercount | `collect 'EventSeries'` | A series at 4, replay, restart, then 7 gave `1 !== 7`. The parser reads legacy count but misses series.count. |
| 6. Log identity failure reports complete coverage | `collect 'without a container instance'` | Running pod, declared container, absent container ID: logs coverage `"ok" !== "gap"`. No instance was read. |
| 7. Confirmed rotation leaves an exact total | `collect 'observed loss downgrades'` | Two identical entries became one inside the overlap. Gap was recorded and count stayed 2, but after restart `exact:true`; expected false. |
| 8. Disk reserve lost during a read | `collect 'reserve falling'` | With a pending Datadog read, free space fell below 256 MiB. Actual [pause, checkpoint, added] was `[null,1768910460000,1]`; expected `["disk",1768910400000,0]`. |
| 9. Persistent size pressure allows growth | `storage 'persistent pressure'` | Same actual and expected triples as #8 while size remained above 1 GiB after compaction. Compaction alone cannot remove protected data or guarantee reserve. |
| 10. A recovered endpoint remains suspended in practice | `storage 'wall clock moves backwards'` | After restart, wall clock one hour behind, healthy peer and 300,001 elapsed ms, failure stayed `"unreachable"` instead of null. No bounded live deadline was reconstructed. |
| 11. Corrupt business sequence accepted on restore | `storage 'inconsistent incident sequence'` | An otherwise valid detached backup placed an incident beyond its event high-water. Restore returned exit `0` and `seq:2`; expected exit 5 with the old rows intact. Integrity and SQL column constraints passed. |
| 12. Run timeout strands both work slots | `adapter 'five-minute deadline'` | `expired sessions still occupy both slots`. After 300,001 elapsed ms an idle message was still required from the nonresponding sessions. Denying their next tool call does not release the workers. |
| 13. Recovered gauges keep the environment in attention | `collect 'two measured samples open'` | Both memory and pods-not-ready reached `breach:false` after two good samples, but health was `"attention" !== "quiet"`. Snapshot counts every historical error as open. |
| 14. Repeated sign-in for one failed cluster | `collect 'shared cluster'` | Two sources on one context generated `2 !== 1` failed kubectl calls in the same interval. |
| 15. Registry diagnostic certifies rejected credentials | `adapter 'registry refuses'` | A fixture 401 gave `ok:true`, detail “registry … answered; proxy …”. A successful connection cannot establish that the registry accepted the credentials. |
| 16. Investigator diagnostic passes with zero tools | `adapter 'no enabled tools'` | Deny-all alone gave `ok:true`, “ow-investigator denies everything but the Overwatch tools”. There was no usable tool. |
| 17. Overlap reaches into declared missing history | `collect 'older-than-14-days'` | A record one millisecond before the floor counted `1 !== 0`; the record at the floor also counted. The reported gap overlaps the admitted window. |
| 18. Slice end is inclusive | `collect 'half-open'` | At the exact upper boundary, first/next totals were `[1,1]`; expected `[0,1]`. No double count, but the first slice claims a future interval's record. |
| 19. Status omits the promised recovery command | `collect 'documented repair'` | Signed-out snapshot contained `failure:"signin",streak:1` and no `kubectl --context lab` fix. The stored repair is omitted from the snapshot. |
| 20. Byte limit on incremental reclaim is inaccurate | `storage 'reclaim is positive'` | A 4,096-byte page file shrank 16,797,696 bytes in one pass; a 16,384-byte page file shrank 25,182,208. Advertised maximum 16,777,216. The smaller discrepancy includes SQLite pointer-map pages. |
| 21. Demo renewal has no event position | `adapter 'demo reading renewal'` | Staging became quiet and QA stayed signed out, with zero peer calls, but “renewal changed health at the same sequence 5”. Consumers cannot order the renewal by seq. |

The 21 rows produce 23 failing tests because both gauge rules and both SQLite page sizes are tested separately. Partial, ambiguous and stale observations are different cases. An invisible replacement of identical log records, network filesystem locking, owner replacement of a live inode and loss of remote history outside its retention period were outside the grade.

## Acceptance results on the assessed product

| Run | Pass | Fail | Skip |
|---|---:|---:|---:|
| Original M1 release, Node 23.11.0 | 42 | 0 | 0 |
| Original M1 routine, Node 22.13.0 | 39 | 0 | 3 long cases |
| Builder typecheck and tests, each Node version | 31 | 0 | 0 |
| Expanded M1 release with predecessor, Node 23.11.0 | 52 | 23 | 0 |
| Added M1 tests, Node 23.11.0 and separately Node 22.13.0 with predecessor | 10 | 23 | 0 |
| M2 contract on the M1 product, installed Chrome present | 2 fixture controls | 28 product requirements | 0 |

For M2, GET / and /v2/inbox returned 404; the freshness module was absent; check rejected problemPatterns; status still combined trial jobs with real jobs; telemetry returned 50 but nextCursor was undefined. An informational “emergency contact updated” also produced attention under the old matcher. The latter conflicts with the newly fixed default word list. The rendered-product tests report the missing HTML entry before testing UI assertions; no product-side keyboard or staleness success is claimed.

## Which checks hold

| Check | Verdict | Evidence and boundary |
|---|---|---|
| Second clean in the writer | Sound at the tested persistence boundary | Parameters cross one normalizer; JSON keys and values are cleaned recursively. The generated sentinel run inspected tool replies, peer request bodies, errors, status, every table, backup and raw DB bytes, including row import. CLI/HTTP/peer output and temporary files are separate boundaries. A type cast by itself offers no protection. |
| Run budgets | Seam | Charging synchronous tool admission before validation makes the eight-call limit work, including rejected arguments. Five-minute expiry is checked on entry, while the driver waits on a different real-time deadline. Two stuck sessions reproduced #12. |
| Citation membership | Sound for active M1 filings | Unique run/session mapping, scoped evidence lookup, unpredictable handles, canonical stored bytes and the terminal-state update with the finding in one transaction. Mixed, unknown, retired and invented citations failed, and the staged checkout differed from the pinned object returned. The marker trial penalized compliance. A citation establishes delivery, not the truth of the model's interpretation. Restored logical relationships require separate validation. |
| Skip inside a saturated interval | Seam | It protected the previous lower bound from inflation, but replay exhausted fresh admission capacity (#3). Keep the interval with the watermark, exclude old/duplicate work before charging new admissions and preserve half-open endpoints. |
| Application ID, version and integrity before restore | Seam | Foreign, future, text and negative-count copies preserved original rows. The owned target transaction and trusted destination constraints are sound, but identity and physical integrity do not validate business references (#11). Validate coherent sequence watermarks, referenced handles, sessions and gate provenance in a stable input snapshot before commit. |
| In-memory set of trial jobs being driven | Sound for its narrow one-owner purpose | Two live jobs and three queued survived a scheduler pass and concurrent trial requests; both callers received the same report, with five sessions and five messages. The set only coordinates work in the live process. Stored intent IDs and peer reconciliation provided the separate restart protection in the active-backup test. |

## Acceptance changes and decisions

The redaction test originally chained `db.prepare(...).iterate()`. On 23.11.0 a forced GC immediately after scanning the first row reproduced `ERR_INVALID_STATE: statement has been finalized` in the original full test. With the same forced GC the repaired test passed. It now prepares the per-table SELECTs into an array held through iteration. Every table, row, secret shape, file, output and restore assertion is preserved. The existing rig also accepts a separate executable at startup for reverse contention. The redaction, reconciliation and concurrent-trial checks read trial rows from the M2 trial namespace when present and the original root on M1. The M2 suite separately requires disjoint real and trial rows; the original row-level assertions remain intact. Added fake inputs are opt-in and model ordinary provider results.

The new M1 tests cover all four post-suite features through the executable. Positive controls include discarding an identity change, recovering the previous instance exactly once, 56 Kubernetes catch-up slices after the horizon with interrupted/read-resumed work, a SIGKILL inside the second catch-up transaction that exposed only the first complete slice before replay, memory streak reset on a wholly missing sample, legacy startup migration without business changes, both Basic credential sources, location-scoped catalogs, newest-first requests, object-form model selection, concurrent startup and trial driving. Checks against the real binary also exercised prefixed MCP tool permissions.

M2 now has a server contract, pure ES-module clock test and system-Chrome page tests. The tests cover shared seen marks, stable rows, focus/drafts, three actions and undo after restart, deadline/recurrence/deploy/rate returns, automatic Quiet and recurrence, scoped search, prompt routing/idempotency, trial isolation, classification, pagination and stale/down/reconnect while a status request hangs. Tests stop at absent interfaces on M1. The separate Chrome harness controls prove real keyboard input, stream disconnect and timer progress with a pending request. M2 checks the staging demo’s Later → finding → return history and separately checks that unrelated trial filings leave real work deferred. End-to-end delivery of a live real-work filing arrives in M3.

The assessor chose three complete measured intervals for automatic Quiet, literal per-app word lists, server-issued request keys, a stable telemetry cursor and a dedicated trial namespace so the top-level jobs and findings contain real work only. The rate/grace thresholds come from the previous design. M2 queues prompts, with real agent execution reserved for M3. Datadog gauge thresholds depend on units and app semantics; the specification supplies no generic threshold. The current build samples Datadog metrics but applies the two built-in hysteresis rules only to Kubernetes.

## Documentation review and requirements for an A

README and the setup guide correctly describe the no-build entry, loopback use and the 2.4.1 credential modes. The public guarantee language in README, AGENTS and design-philosophy overstates exactness and complete coverage (#3–7). In using/customizing, “the database stays within 1 GiB”, “at most 16 MiB”, gauge closure and lower-bound labels disagree with observed status or file size. Using says signed_out requires two failures; status showed it on the first, with suspension on confirmation. Setup sends the owner to a missing status repair and implies a successful doctor proves the configured tools can execute. The sample uses an explicit OpenCode URL; a plain serve also needs the documented password setting. The legacy design guide describes a Foldkit page; its keyboard and visual design are retained references for M2. The historic council and command-center documents describe previous proposals, not running behaviour.

1. Close the collection and health regressions first. Charge only distinguishable new admissions, correct event series and interval bounds, carry coverage uncertainty into totals, and derive health from active problems and all expected measurements.
2. Bind the model gate to the tested model/configuration. Interrupt or park an expired job independently of peer replies. Make doctor demonstrate a usable tool and successful dependency checks, and expose actionable sign-in repair.
3. Validate restore relationships and watermarks; rebuild bounded restart deadlines. Apply the disk floor during admission and after compaction, enforce the byte-based reclaim limit and define a retention policy for unreferenced trial/evidence/message and coverage history. Protect referenced evidence.
4. Fix the statements contradicted above. Make the expanded release suite green on both Node baselines, including the cross-version option. Resolve the M2 return and compatibility decisions before building the page.
5. The owner and a colleague supply the remaining A evidence: doctor from the actual launchd environment through the real proxy, two days with sleep/VPN health transitions, the configured GLM trial or positively disabled automation, and a timed clean setup. The page keyboard tasks, measured search latency and brief copying belong to their own later milestones.

Three specification tensions deserve a decision. A 1 GiB cap needs an explicit treatment of protected history already above it; pause is safer than discarding cited evidence. Eight calls with pages of 50 allow at most seven full telemetry pages before a required filing; 400 pieces is a storage ceiling, not a promise that an agent can read and cite 400 in one run. Finally, owner handling and measured recovery need separate state: archiving a live fault cannot establish quiet, and a resolved gauge cannot keep the strip in attention forever.
