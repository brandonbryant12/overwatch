# Independent assessment of Overwatch 2 at milestone 5

**B overall at `8663a38d6f69a5aef4ff2a2729c59cc5cdb0e079`.** I would run the inbox and read-only incident investigation daily. I would leave `apps.*.fixes` unconfigured on work repositories. Two independently observed outcomes decide that recommendation. Overwatch marked an incident Done after the workload rolled back to the regressed version. Its successful draft read-back did not obtain the PR's head commit from the PR host.

This is an improvement from M4's B− and a tie with M3's B. The two-consecutive-non-improvements stop rule has **not** fired. The case for continuing is narrow. The owner can start the watcher trial now. Another broad build-and-grade round has low value. There is a short list of product changes worth testing before trying publication on a scratch host.

## Grades and decision criteria

The letters are judgments. The counts below are observations. I graded the delivered four-milestone product within section 10. I counted owner control, exact host acknowledgement and visible uncertainty under **Correct**. Under **Useful** I timed the path to evidence for a correct decision, including why a task returned. Under **The model** I required a distinct exercised operation for each positive credit, an abstention control and a verifier capable of distinguishing the regressed and restored settings.

| Section 11 area | M3 → M4 → M5 | Evidence that decided M5 |
|---|---|---|
| Correct inside the limits | B− → C+ → B− | Counting within the storm limit, recovery, owner receipt replay and the cooperative Git handoff held, including two cuts inside the push. A rollback still led to automatic Done. A missing monitor measurement still produced quiet. PR identity and publication authority have limits detailed below. |
| Honest beyond the limits | B− → B− → B− | The storm and overlap limits have executable oracles. New probes found a quiet cell half a second beyond the provider query and a four-minute quota ETA calculated from seconds. Both are plausible-looking answers to questions the data could not answer. |
| Real | C provisional → C+ provisional → C+ provisional | macOS, SQLite, Git, sandbox-exec, Chrome and native OpenCode 2.4.1 ran. The corporate proxy and launchd account, actual banner, 48 hours through sleep/VPN and scratch hosting account still require the owner. |
| The model | B mechanics → B− mechanics → B+ mechanics | The native scripted run earned the two named operations and abstained on the negative. A separate bad negative control withheld the gate even with two verified positives. A focused question completed while a fixer occupied the other slot. Private GLM judgment and the quality of the owner's real semantic verifier remain unmeasured. |
| Useful | B+ → B+ → B | Three decisions had legible, readily retrievable evidence. The documented npm example failed with ordinary installed dependencies. The same verifier worked after explicit offline preparation. The page's suggested retry after recalibration acknowledged an old failure. A false recovery can remove the very incident the owner needs to see. |
| Simple | B+ → A− locally → B+ locally | 5,493 service lines of 5,500, zero runtime packages, direct execution and a quick isolated setup. Unit runs leave hundreds of directories, two product commands and an interrupted verifier retain scratch, and some advertised guarantees depend on each extension author. The colleague's ten-minute gate remains open. |

The history in Git contains nine commits in `c2a2166..8663a38`. The assessed acceptance tree matches `c2a2166` exactly. All results below concern product code from `8663a38`. The assessment changes acceptance fixtures, checks and this report.

## What the owner can act on

1. **Keep recovery under owner control.** The fixture observed a deployment containing the merged fix, then observed the original regressed revision again before the required quiet streak finished. The service emitted `released_quiet` and set the incident to Done. Make a containing deployment a continuing requirement for the entire streak. Removing automatic Done and showing “ready to close” would also improve the product today.
2. **Require a host-confirmed draft identity and a current policy verdict.** The Git remote showed the right branch in the cooperative case. The separate PR read after create requested number, URL, state, draft flag, branch names and body. It never requested the PR head OID or head repository. The configured Git remote and the repository selected by gh have separate resolution paths. An exact match of the commit on an earlier Git read cannot identify the object a PR currently references. The protection decision can also outlive the host observation. Keep automated publication off until both identity and policy are established end to end.
3. **Remove false quiet and unsupported ETAs.** A monitored pair with one OK replica and another reporting the provider's literal `Unknown` or `No Data` yielded `quiet`. A metric 500 ms beyond the requested end also yielded `quiet`. Six samples all expressed in seconds yielded a quota projection expressed in units. Preserve uncertainty through both status and outlook. Missing, unknown or incompatible units need an explicit disposition before division by a rate. Staging also kept saying “same release” after production caught up to staging, then deployed a third revision while staging stood still. The new production observation must invalidate a completed match as well as a regression.
4. **Give the owner a verification path that works for their repository.** A small, offline, lockfile-backed npm app distinguished the regression correctly on the owner's checkout. On the candidate it failed to load the first dependency. The fix panel shows the command and exit code. Its suggested recalibration-and-retry can return the original failed attempt without rerunning verification. Document the tested offline npm workflow or a standalone verifier, and surface the missing prerequisite beside the failed command.
5. **Close the operational gaps.** When the service manager could neither unload nor inspect a job, uninstall removed the plist and reported success. An unavailable status is a third outcome alongside loaded and absent. Reclaim demo and trial scratch on ordinary exits and the interrupted verifier's checkout after recovery. The builder should give its tests the same cleanup guarantee. Fix the work-laptop URL discovery recipe for valid default-directory configurations.

Closing these five items, with fresh independent checks and the owner evidence still missing, would support **B+ overall**. A− locally would require exact publication on the configured host and a representative verifier an owner can configure from the guide. Today the remaining distance to an A includes product work. Keep private-model automation off until its own trial passes. Treat a green monitor-only cell and an unvalidated capacity projection as prompts to check the provider.

## Publication, host acknowledgements and permits

The baseline still exercises owner decline, trial revocation, newer deployment, base movement, unavailable policy, wrong PR, timeouts, a conflicting pre-existing ref and restarts around the host lookup and create. I counted the following additional experiments independently of those reruns.

| New ordinary host history | Result |
|---|---|
| Kill the real service during git push, in the bare remote's pre-receive hook | Before the kill the attempt was publishing, the branch was absent and the PR ledger was empty. After restart it reached one draft, the exact verified head and the unchanged base. |
| Same cut in post-receive, before push completion and before the service's read-back | The branch already held the verified head, with no PR. Restart reconciled one draft. |
| gh creates a draft durably, then exits with failure before acknowledgement | One create invocation in the independent ledger, one draft after reconciliation. |
| Policy initially unavailable, then definitively protected | No candidate ref at the uncertain step. The positive protected verdict ended in refusal with no product ref write. |
| During a recorded policy outage, the owner declined, the trial gate closed, the workload rolled back, or a maintainer advanced the base in four separate runs | On resumed admission the states were declined, blocked, stale and stale. No candidate ref or PR in any run. |
| A positive policy observation is followed by a receive-time policy rejection on the bare host | The service surfaced the host refusal. The owner declined the retry. The remote and the PR ledger contained no candidate. |
| Owner declines a confirmed draft, restarts, and retries the same receipt | Same result, durable declined state, host draft identified, exactly one host record. |
| Inspect the PR facts requested in an otherwise successful publication | **Broke.** The application recorded `draft` without requesting the PR head OID. This observation establishes missing evidence. This fixture did not create a foreign PR. |

A local transaction can order an admission decision. It cannot order another team's remote policy change with the eventual acceptance of a network request. The implementation has three relevant boundaries.

| Boundary | What the implementation establishes | Outstanding evidence or limitation |
|---|---|---|
| Protection and push | The local gate reads the attempt version, disposition, both trials and latest deployment. For push it compares the supplied base tip and stored protection verdict. The Git push is non-forced. | A branch lookup reporting not found is treated as permission. A previously stored allowed verdict survives retries. Neither observation establishes effective namespace rules at acceptance. The base read and the remote write are separate. |
| Lookup and create | The create path takes a fresh base reading before requesting its host permit. The local gate runs on the host operations. A failed lookup has a bounded retry and a reason. | Base is optional at the gate. The read-back lookup does not receive a base OID. The confirmed PR predicate compares branch names, draft/open state and marker text. Repository and verified commit identity remain outstanding. |
| Acknowledgement and follow | Attempt state transitions use versioned updates. A later written decline cannot be overwritten by an old state update. The host can already have completed an admitted request. | The final transition does not recheck external facts after the last host response. Follow reads the PR by number with a smaller field set. Some metadata updates use an ID-only predicate. A local version does not freeze host policy, the remote base or the PR. |

The boundaries below identify which interleavings received direct release or new test evidence. A stored change observed after an effect has finished and a change made while the host is processing that effect are different histories.

| Change | Direct observations at this revision | Still open |
|---|---|---|
| Owner stop | Decline before the proposal files, decline after a confirmed draft across restart, preserve Never through release observation | A stop concurrent with every admitted host write and its final read-back |
| Investigation or fix gate | An investigation gate withdrawn during the protection request stopped the original publication. Two correct positive operations with a failed negative control kept the fix gate closed. | Each gate changing independently inside each write and acknowledgement |
| New deployment | A newer deployment during proposal invalidated the frozen finding. A rollback during the post-merge quiet streak incorrectly closed it. | A newer workload at each interleaving of push, create and follow |
| Base movement | Moving the base during the policy request or during the post-push draft lookup invalidated the candidate in the release cases. | Base movement after the last read before each host acknowledgement |
| Host truth and availability | A lookup timeout, conflicting ref, nonmatching PR, malformed create output, a durable create followed by failure, and a receive-time policy refusal have executable checks. PR head identity was absent from the requested read-back fields. | Actual repository and OID agreement under a divergent host, and duplicate suppression for every lagging-read history |

The cross-product of these histories remains unverified. The assessor made no external requests to a hosting account and did not exercise permit substitution or fabricate a foreign object for adoption. Bind intents to an operation, repository, immutable head/base and attempt. Reconcile from the host after a possibly accepted request, including when the owner has since stopped the attempt. Show any cleanup still owed to the owner.

For permits the non-dispatching checks in `accept/m5-extensions.mjs` cover a second spend, rollback, a different effect **category**, and the serialized receipt read in a fresh process. The transaction issues the in-memory object only after commit. Spending clears its live flag. The process boundary carries receipt metadata. Source inspection supplies the important qualification: enforcement compares a broad kind such as host or peer. The concrete host operation, remote target, arguments and subject written in the intent are not parameters to `spend`. Same-category operation binding is **not established** by the passing checks. The single child-process entry point and build check make accidental new launch sites easier to catch.

## Thirteen assigned neighbours

Each row has one distinct primary oracle. Supplementary tests, host cuts, historical regressions and repeated runs on a second Node version do not increase this denominator.

| M4 defect | New experiment at M5 | Result |
|---|---|---|
| 1. Owner stop | Replay a decline receipt after restarting a confirmed draft | Held |
| 2. Protection/base uncertainty | Policy outage recovers to a protected verdict | Held |
| 3. Exact host object | Inspect post-create PR identity evidence on the successful path | Broke |
| 4. Verification inputs/isolation | Run the documented npm command with vendored packages, a lockfile and an outside cache | Broke on usability, closed safely |
| 5. Newer deployment | A containing deployment is replaced by the regressed revision before closure | Broke |
| 6. Calibration credit | Correct on both positives, wrong on the negative | Held |
| 7. Consecutive recovery | Recurrence in the released workload, then two and finally three quiet intervals | Held |
| 8. Private path | Ordinary draft with a synthetic mounted-volume path and a useful relative filename | Held |
| 9. False all-clear | Mixed OK and canonical No Data monitor states | Broke |
| 10. Capacity/comparison | Six consistent seconds measurements for a quota configured in units | Broke |
| 11. Same-poll onset | First event one millisecond before replica-set creation, then a later recurrence | Held |
| 12. Owner recovery | Repeat the page's suggested fix request after a new passing calibration | Broke |
| 13. Uninstall | Manager becomes unavailable after successful install, including for its own status read | Broke |

**6 held, 7 broke.** Across the other 26 new acceptance cases, 18 held and eight broke. The combined count is **24 held, 15 broke out of 39**. Each distinct named case is counted once. These deliberately chosen cases do not estimate a field failure rate.

| Additional test shapes | Held | Broke |
|---|---:|---:|
| Pre/post-receive crashes, accepted create with lost acknowledgement, existing Never disposition through the release streak | 4 | 0 |
| Receive-time policy refusal, and four changes before readmission after a recorded policy outage | 5 | 0 |
| Previously quiet log provider reports a completed page with a warning, restarts and later recovers | 1 | 0 |
| Offline npm preparation inside the verifier, interrupted verification checkout after successful retry | 1 | 1 |
| Literal Unknown monitor state, near-future metric, production diverges again after matching staging, local expiry of an almost-old forecast | 1 | 3 |
| Owner question while a fixer holds a slot | 1 | 0 |
| Temp storage after ordinary watching, a verified draft, demos, trials and the builder's fake-manager test | 2 | 3 |
| Acceptance worker failure and SIGKILL with a live service, plus SIGKILL with a real Chrome profile | 3 | 0 |
| Work-laptop discovery with the default data directory | 0 | 1 |

The maintenance mutations, non-dispatching permit checks, native scripted trials, timed UI decisions and deliberately delayed reconnect control have their own results below.

## Verification and owner decisions

The fixture installs a real two-package npm dependency graph using local tarballs. The app calls the validator, which calls the scalar package. Its lockfile and tarballs are tracked. Its installed tree is ignored. npm populated a private cache outside the checkout with networking disabled. `npm test` exited 0 for timeout 30 and 91 for the deployed timeout 3. The derived candidate restored 30. The macOS verifier started npm, then exited 1 with `Cannot find module 'fixture-validator'`. The host ledger remained empty. The JSON contains a Node stack trace, and the owner-facing reason is “npm test exited 1”. A normal checkout with its prerequisites installed can therefore behave differently from the candidate Git archive. The setup guide explicitly requires verification to pass from a fresh checkout without untracked dependencies. Its illustrated npm command therefore has a prerequisite. The candidate failure alone gives no working repair for this case.

A second npm configuration provided a working repair with the same semantic check. Its tracked test entry point copied the lockfile, manifest and both local tarballs to the verifier's private temporary folder, ran offline npm ci there, and launched the check with those installed modules on its search path. The owner checkout still passed the restored setting and rejected the regressed setting. The service ran npm test successfully, recorded exit 0 and opened one local draft. No registry or shared cache was required. This is a viable pattern for a repository prepared for offline verification. A stock install in the owner's checkout alone remains insufficient.

The local native OpenCode 2.4.1 binary spoke to a scripted loopback model and the service's own MCP tools. It scored 5 valid, 5 correct, zero false-real, zero planted-marker compliance and peak concurrency 2. The choices were revert, setting, abstain and then setting for the incident. Both positive candidates verified. The independent local host recorded one draft on main. The simple Node verifier exited zero. This establishes one working end-to-end feature path with a standalone verifier.

I opened the actual demo and drove the three decision paths in system Chrome. For the fleet, six source fixtures produced 200 incidents and the page response fixture represented **all 15 fix states**, including unresolved. The fleet fixture supplies display states; a separate case exercises the actual host lifecycle. Elapsed time runs from opening keyboard search to the matching focused panel, required evidence text and scrolling that panel into view. These are input-to-evidence times. A human reader's comprehension time remains for the owner.

| Question and item | Answer supported on screen | Elapsed |
|---|---|---:|
| Is the demo's exhausted pool fix ready for human review? | Draft #412. Three readings and upheld challenge, change from 5 to 20, npm verification exit 0. Review the diff. The seeded demo does not certify the npm runner for the owner's app. | 1,202 ms |
| Why did the staging cache warm-up return? | A new investigation filed a not-real finding since Later. The warning is longstanding. A returned row does not itself establish a new regression. | 1,006 ms |
| What is the fleet's worker ab item waiting for? | Host still has not confirmed the draft after five attempts. Wait for host recovery, then request another attempt. | 317 ms |

These times are from one final Chrome run and include scrolling to each required piece of evidence. I also opened a genuinely fix-enabled item with an active draft. Chrome showed the draft panel and hid Propose fix. The owner can see a reason and the next observation together. A fetch that hangs cannot by itself keep the green strip live. A nearly expired forecast also disappeared on the page's next tick while the independently sampled service clock stayed fixed. The strongest remaining UX issue is a plausible next action that cannot change the state.

## Extensions an ordinary author might make

Run `codex-heavy -- node --no-warnings accept/m5-extensions.mjs` from this checkout. It changes only a disposable archive of the assessed commit.

| Extension | Observed result | Potential owner consequence |
|---|---|---|
| New reference named `related_case` with its parent declared | Detached restore refused the missing parent | Caught before the restored data goes live |
| Otherwise identical semantic reference named `owner_case` declared only as data | Restore returned `owner_case: 'missing'`. The column-declaration check passed | Restore can lose the association between a decision and its subject, potentially losing that decision from the owner's view. This experiment restored a synthetic row. |
| New column in SQL omitted from the column declaration | The build check rejected the disposable table | Caught before release |
| New transaction under the space guard, then reuse of its writer | Admission and the expired writer both refused | Caught at the attempted write |
| New observation constructor supplied the wall clock | Typechecked, produced state `ok` | A future adapter could report stale coverage as fresh, producing a false all-clear |
| New source kind without collection/identity/failure policies | Typecheck exit 2 with TS2741 and TS2322 | Caught before release |
| New POST outside the keyed route table records a local note | Same key, two responses with sequences 1 and 2. Typecheck and keyed-router check passed | Duplicate acknowledgements or owner decisions. A route with an external consequence would need additional protection. This experiment wrote only notes. A write-only route does not itself grant a host publication permit. |
| New unused module imports a process launcher | Build check rejected it before it was called | A release check catches this ordinary launch site before dispatch. Same-category target binding still matters for an unwanted publication. |

The experiment printed the orphan row, the two acknowledged event sequences, the wall-derived reading and the typechecker diagnostics. No genuine owner decision or remote publication was made in those extension cases. The shared session driver also carried an owner question to completion during an active fixer selection with peak concurrency at most two. Receipts, references and provider times each carry useful information once the caller supplies it. The mutation results describe what a future extension could introduce. The 15 red acceptance cases exercise behavior already present in the assessed checkout, including the guide and test hygiene.

## Coverage of the builder's other repair claims

| Reported change | Evidence and boundary |
|---|---|
| Central process launcher and permit | A new launcher import failed the build guard. The non-dispatching permit checks refused reuse, rollback and a different category. Restart preserved receipt metadata only. A passing import check cannot identify the correct repository for a host call. |
| Router receipts | The real decline receipt survived restart and replay. An extension outside the declared router acknowledged the same key twice. |
| Schema and restore | The declared parent worked with a new nonstandard column name. Omitting a column failed the build check. A semantic reference declared as data survived an invalid restore. |
| Provider coverage and units | A completed log page with a provider warning withdrew quiet until a complete poll recovered it. Missing monitor data beside OK and a near-future metric still yielded quiet. Changing units and incompatible but consistent units are separate cases. |
| Staging and deployment time | The release skew case rejected nonaligned intervals. The new comparison survived too many deployments. The one-millisecond onset case kept an ineligible attempt off the host. |
| Closure and forecast age | A recurrence restarted the three-interval streak. A changed workload escaped that condition. The real page timer withdrew a forecast while the service's descriptor clock stood still. |
| Verifier and calibration | The prior suite exercised a changed verification input and links. The new independent npm tree established the candidate's actual dependency prerequisite. Two positive selections plus a failed negative did not earn the gate. Completeness of dependency discovery for arbitrary repository build systems remains unverified. |
| Outbound text | A normal draft preserved a reviewable relative filename while the final title and body omitted the synthetic mounted-volume path. |
| Owner page and common session driver | The 200-item fixture displayed all 15 expected next steps, the demo labeled the staging comparison, a genuine open draft hid Propose fix, and the focused question completed beside an active fixer. Repeating the suggested action after verifier failure acknowledged an old attempt. |

## Work-laptop runbook

The setup exercise cloned locally, detached at the assessed SHA, copied the guide's literal configuration examples and used a stateful launchctl double. From clone start the config passed at 1.989 s, install returned at 2.388 s, restart at 2.579 s and uninstall at 2.770 s in the final isolated run. Both original guide checks passed. The optional fixer diagnosis and exit-zero exception now agree. The install exercise certifies the generated plist and command sequence. The ten-minute colleague criterion includes reading, credentialed setup and passing live diagnostics.

| Runbook step | Assessment |
|---|---|
| 1. Install and establish baseline | Commands and individual check requirements are concrete for the example configuration. All applicable rows must pass, including optional-role rows in an exit-zero report. Genuine proxy, Keychain, launchd and remote credentials remain owner evidence. |
| 2. Two days of sleep and network changes | Minute-by-minute samples and transition timestamps make gaps and recovery visible. The status trace cannot count provider disagreements on its own. Ground truth and human observation during outages are needed. |
| 3. Banner | The helper, incident and before/after intent checks describe an observable pass. URL discovery assumes the raw JSON has an explicit dataDir. Valid configuration also supports a default. The new runbook test exercises the literal command. Native presentation remains unverified. |
| 4. Private model | The thresholds and three-operation SQL check are concrete. A credentialed private GLM run is still required. A native scripted success earns local adapter credit. |
| 5. Scratch draft | The owner is asked to inspect real candidate rules, PR OID, marker, base, verified commit and return after closing unmerged. This demands stronger host evidence than the product collects independently. A missing eligible incident or unknown protection keeps this step open. |
| 6. Independent colleague | Start, end and ten-minute limit are specified. Prompt-style `read` commands assume zsh on macOS. The local automated clone time does not measure this gate. |

## Storage and acceptance hygiene

The machine initially had 5.8 GiB free. The upstream task reported removing about 61,600 old temporary directories occupying 16 GB and restored the Data volume to 21 GiB free. That historical count is attributed to the upstream task. I measured the following within isolated, initially empty directories.

- One original `pnpm run check` on **each** Node version left 875 top-level directories. Of these, 874 had Overwatch prefixes, including one product demo directory, and one was Node's compilation cache. The 23.11 check occupied 286,544 KiB after completion and the 22.13 check 286,520 KiB. The dominant counts on each were 280 `ow-agents-test`, 174 `ow-class-test`, 150 `ow-health`, 125 `ow-boundary` and 100 `ow-receipt`. The builder should give each test run a private root and reclaim it, including on failed runs. The assessor did not edit `test/`.
- Normal serve, three polls and graceful stop left **zero** product scratch directories. Two completed investigation trials left **two** seed Git repositories, 120 KiB each. Two normal demo exits left **two** data directories, 328 KiB each, measured by allocated disk blocks on this filesystem. A successful calibrated fix left the investigation seed only. No verifier checkout, candidate temporary blob, fix-calibration repo, worktree or PR-body directory remained after that successful operation. Killing the service inside the verifier left its first checkout behind even after restart, a successful retry, and normal shutdown. That directory held a copy of the candidate repository. The screenshot driver wrote 19 requested PNGs and its initially empty scratch directory was empty again on exit.
- The acceptance helpers already cleaned most ordinary successful tests. Cleanup registered after setup could miss early failure, and a killed worker cannot invoke its hooks. A private worker root is now watched by a detached process holding the read end of a lifetime pipe. A kill with a real Chrome profile exposed a second race: the browser could recreate files after the first deletion. The service and persistent peer supervisors now hold the pipe open until they finish. The kernel releases the last descriptor, then the watcher removes the root. The normal hooks still release individual resources promptly. Chrome, test services and the native peer follow the test process's lifetime. Independent tests killed or failed a worker with a running service and verified both the absence of its directory and exit of its service. Concurrent startup of the current binary and predecessor also uses the lifetime-bound launcher. Each helper removes only its own private directory. The measured disk burden of repeating the full builder checks is much larger than that of running a demo or trial. These samples do not establish a 48-hour growth rate for an owner's real workload.

## The reported intermittent page test

**Fixture race.** The original full Node 22.13 release run reproduced the failure at the final live-state assertion. All its other 55 M2 cases passed. The original Node 23.11 release and six isolated Node 23 repeats passed. In a disposable copy I delayed socket closure after reconnect by 900 ms. The original test then reached stale, removed quiet, reached down and disabled actions. It failed only at `fresh snapshot restores live state`. Its single six-second virtual-time budget could be exhausted before the real proxy finished closing sockets and Chrome scheduled the next reconnection timer.

The repaired case measures the actual 15/30-second thresholds against one outstanding real status request. It gives the one-second repaint interval its original margin. Both the browser timers and the loopback proxy run on elapsed time through reconnection. It still requires the stale and down text and colors, zero quiet cells, disabled actions, no event sequence change on Enter, the original focus and draft, and recovery to live within ten seconds. The same delayed transport passed on **both** Node versions. The first full expanded Node 22 M2 run found the new killed-Chrome profile race while all 57 other cases passed. The fixture-lifetime change addresses that separate harness failure. The separate CDP test that exercises virtual-time advancement while status hangs remains intact. The independently reproduced provider false all-clears above still count against Correct.

## Release ledger and reproductions

The original release used two fresh Git archives, one for the product and one for the separately extracted `ddc68e7` predecessor. Neither contained `node_modules`. Property tests resolved the pinned development packages through a temporary ancestor link. A separate no-dependency archive passed the complete verified-draft-through-close case on both Node versions. Typechecking and builder tests ran in separate archive copies with development dependencies available. A small wrapper supplied Node's supported two-worker limit to the package's unbounded test script. The shared heavy-command gate serialized the suites. Each original release suite used an empty private TMPDIR. The release supervisor sampled disk every three seconds with a 20,000,000,000-byte stop threshold. The lowest sample was 22,066,847,744 bytes (20.55 GiB). All ten original milestone/guide processes finished and each left its isolated scratch root empty. The final two full 58-case Chrome runs also left empty roots.

For the expanded counts, the assessor overlaid the acceptance changes on a fresh archive and checked that its `src/` and `web/` were byte-identical to the original. Counts combine the original full globs with the independently executed added cases and the replacement reconnect case. This distinguishes a measured release baseline from a sum of distinct regression results. Owner timings, experiments and the optional native run are outside the milestone globs.

Counts below are individual passes / failures. Expanded M1, M3, M4 and guide totals combine the original release with distinct supplementary cases. M2 also has complete post-repair runs. All listed runs had zero skips and cancellations. Optional native and owner-timing controls have their own denominator.

| Suite | Original Node 22.13.0 | Original Node 23.11.0 | Expanded Node 22.13.0 | Expanded Node 23.11.0 |
|---|---:|---:|---:|---:|
| M1, with long cases and predecessor | 135 / 0 | 135 / 0 | 139 / 7 | 139 / 7 |
| M2, system Chrome | 55 / 1 | 56 / 0 | 58 / 0 | 58 / 0 |
| M3 | 88 / 0 | 88 / 0 | 88 / 0 | 88 / 0 |
| M4 | 73 / 0 | 73 / 0 | 91 / 7 | 91 / 7 |
| Guide | 2 / 0 | 2 / 0 | 2 / 1 | 2 / 1 |
| **Acceptance total** | **353 / 1** | **354 / 0** | **378 / 15** | **378 / 15** |
| Builder typecheck and tests, separately | 84 / 0 | 84 / 0 | 84 original tests | 84 original tests |

Separate ordinary limits from stress quantities. The failing health probes used two monitors or one metric point, one minute of time and a single watcher. The release failures after a rollback or third rollout also used routine-sized histories. The two long M1 runs exercise storm saturation and replay, crash/restart and cross-version ownership. They enable `M1_LONG=1` and set `M1_OTHER_BIN` to the predecessor's absolute entry point. The concrete release commands are:

```sh
(
  set -eu
  repo=$(git rev-parse --show-toplevel)
  release=$(mktemp -d)
  trap 'rm -rf -- "$release"' EXIT
  mkdir "$release/product" "$release/prior" "$release/tmp"
  git -C "$repo" archive 8663a38 | tar -xf - -C "$release/product"
  git -C "$repo" archive ddc68e7 | tar -xf - -C "$release/prior"
  test -d "$repo/node_modules/fast-check"
  ln -s "$repo/node_modules" "$release/node_modules"
  cd "$release/product"
  export TMPDIR="$release/tmp" M1_LONG=1 M1_OTHER_BIN="$release/prior/bin/overwatch"
  gate=codex-heavy
  node --version
  failed=0
  for m in 1 2 3 4; do
    "$gate" -- node --no-warnings --test --test-concurrency=2 accept/m$m/*.test.mjs || failed=1
  done
  "$gate" -- node --no-warnings --test --test-concurrency=1 accept/guide-contract.test.mjs || failed=1
  exit "$failed"
)
```

Use separate clean archives and select the stated Node version on PATH. The command runs the release from the assessed Git object. From the assessment checkout, the same milestone globs and the top-level guide glob include the new red regression cases.

### Reproducing the failures

```sh
probe() {
  codex-heavy -- node --no-warnings --test --test-concurrency=1 --test-name-pattern="$2" "accept/$1.test.mjs"
}
```

| Run from the assessment checkout | Deciding output, shortened to omit variable IDs and paths |
|---|---|
| `probe m4/m5-lifecycle 'workload rolled back'` | `{"state":"released_quiet","way":{"kind":"done",…}}` after reverting the deployment |
| `probe m4/m5-lifecycle "PR's verified commit"` | `Host PR fields requested after creation: number,url,state,isDraft,baseRefName,headRefName,body` |
| `probe m1/m5-observations 'a provider reporting'` | Both Unknown and No Data yielded `reading:"monitors", state:"ok"`, environment `quiet` |
| `probe m1/m5-observations 'half a second'` | A point 500 ms past the requested end yielded `reading:"metrics",state:"ok"`, environment `quiet` |
| `probe m4/m5-measurements 'seconds'` | `state:"forecast",unit:"units",samples:6,etaMinutes:4,ratePerMinute:10` |
| `probe m4/forecast-edges '^a third production revision'` | After the third rollout, `state:"same_release",reason:"production now runs the staging revision"` |
| `probe m4/npm-verify 'documented npm'` | `verify_failed`, npm exit 1, `Cannot find module 'fixture-validator'` on Node 23.11.0 |
| `probe m4/m5-owner '^the next action'` | Page offered `Next: a passing overwatch trial --fixes, then f.` Passing the trial and submitting the request did not start another proposal. |
| `probe m1/m5-observations 'uninstall keeps'` | `it was not loaded`, exit 0, plist removed after the manager became unavailable |
| `probe m1/m5-temp 'two demos\|two completed investigation trials'` | Two `overwatch-demo-*` and two `overwatch-trial-*` directories survived successful exits |
| `probe m4/m5-verify-storage "interrupted verification"` | `completed retry retained 1 verification checkout(s)` following a service kill, recovery and orderly stop |
| `probe m1/m5-temp "builder's fake launchd"` | The builder test passed and left four `ow-launchd-*` homes |
| `probe m5-guide 'default data directory'` | Literal runbook command failed with `Cannot read properties of undefined (reading 'replace')` |

Independent controls are runnable with `node --no-warnings --test accept/m2/m5-decisions.mjs`, `node accept/m4/setup.mjs 8663a38` and `OPENCODE_BIN=/absolute/path/to/opencode-2.4.1 node --no-warnings --test accept/m4/native.mjs`. The last requires the macOS executable and the fixture's loopback scripted model. With the final peer supervisor installed, both versions passed the two worker-lifetime controls and the optional native trial again. The real work-laptop and private-model checks remain in the owner runbook.

## Assessment commits

| Commit | Change |
|---|---|
| `9be9d8e` | Initial fixture lifetime handling and real-time reconnect assertions |
| `78d5101` | Independent release neighbours, owner decisions, storage probes and extension experiments |
| `8147bc3` | Keep scratch until the browser and other persistent fixture processes exit, including on worker SIGKILL |
| `3c99013` | Normal host refusal and four readmission cases, offline npm verification, interrupted verify storage and the extra schema and measurement controls |
| `6414e2e` | Give archived extension subprocesses and the setup runner their own temporary directory via TMPDIR |

The assessment itself is the next local commit on this branch. The assessed service, web assets and builder tests are byte-identical to `8663a38`.
