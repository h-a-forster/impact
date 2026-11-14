# Lessons log

Only things that actually happened while building this are listed.

| # | Case | Observed result | Reason | Change made |
|---|---|---|---|---|
| 1 | Installing Graphify with `uv tool install graphifyy` | Install failed: `tree-sitter` tried to compile and needed Microsoft C++ Build Tools. | `uv` picked a Python version with no prebuilt `tree-sitter` wheel. | Pinned Python: `uv tool install graphifyy --python 3.12`. Recorded in README and in the setup error message. |
| 2 | **Stale evidence.** Graphify export for a snapshot of sample commit `ae08cfb` | The export said `built_at_commit: 2d33f34`. That is this project's commit, not the sample's. | Graphify stamps the Git HEAD it finds above the folder. The snapshot sits inside this project's worktree. | The adapter drops that field. Each export is saved with the SHA the snapshot was taken from. Evidence is joined by that SHA only. |
| 3 | Graphify on the test files | Warning: "3 code file(s) yielded no symbols". No per-test nodes, only file-level import edges. | Tests are anonymous callbacks inside `test(...)`. The extractor models named symbols. | Added a labelled rule-based test mapper that parses `test(...)` blocks and matches imported names. Shown under "Index coverage and gaps". |
| 4 | Graphify call edges | Export is `directed: false`. Nodes have a start line but no end line. | Format of the code-only export. | Adapter orients each call by where the call site is. End lines come from brace matching, labelled as such. Eval `map integrity` re-checks the call site in real source at each commit. |
| 5 | **Overclaimed coverage.** Test map for `import: a row with the wrong column count is rejected` | The map said this test reaches `applyDiscount()`. The independent AI reviewer pointed out it throws in `parseOrderRow()` at line 12, before `applyDiscount()` runs. | Reach is static: a call path exists. It does not prove the line executed. | No route impact, because evidence also needs a requirement ID and that test has none. The app now labels this "Static reach (call paths that exist, not proof each one ran)". Candidate eval: a requirement-tagged test that throws before the call must not count. Real fix later: per-test coverage data. |
| 6 | **Possible missing callers.** Author claim "applyDiscount() has no callers other than Checkout and Order Import" | Index found exactly those two. The AI reviewer still listed it under "could not decide" on both commits. | The index cannot see dynamic calls or other repos. | Claim is labelled **Inferred**, never Verified. It is copied into the sign-off record as unchecked. No missing caller was actually found in this sample. |
| 7 | AI review on commit 2 | Reviewer noted "the ledger source was not provided". | The review input only includes changed and affected files. | Kept as is. The limit shows up as a "could not decide" item, which is the intended behaviour. |
| 8 | AI review on the High `ledger-note` PR | Two "Needs evidence" findings (note text untested). Route stayed **Human review required**, not Waiting. | By decision, only required checks and required per-workflow evidence can block. AI findings are advisory. | None. Documented as a trade-off in the concept card. The findings are shown to the engineer and listed in the sign-off record. |
| 9 | Policy self-patch PR | The AI reviewer independently flagged the policy edit as **Action required**. Rules had already set High from the base policy. | Both layers caught it for different reasons. | None. Kept as an eval (`policy-self-patch`). |
| 10 | Evals for altered evidence (wrong-revision run) | The saved AI review was marked "unavailable". | Its saved input hash no longer matched the evidence. | Intended. A recorded review only counts for the exact inputs it saw. |
| 11 | Joining the GitHub replica: live status call | The PR page kept showing "queued". | Two causes. The replica's server called `localhost`, which Node resolved to IPv6 `::1`, while this app listened on IPv4 only. And each model build took about 1.1 s (many git calls on Windows), over the timeout. | App now also listens on `::1`; replica config uses `127.0.0.1`. Read-only git calls are cached per process (summary: 1.1 s first call, 5 ms after). |
| 12 | Opening the replica's Impact Map tab on a real Tieto PR | Would have shown the shop PR with the same number. | The link carries a PR number, and both repos have a PR #1. | The app checks the `repo` in the link. Unknown repo: "No impact analysis for this pull request yet". Nothing is claimed. |
| 13 | **Overclaimed coverage, measured.** Planted fault F3 (the range check in `applyDiscount()` loosened) | Escaped the suite on both commits, while the map said `applyDiscount()` was Supported. | "Supported for the tested case" was read as "supported". No test covers the range check. | Kept as a recorded miss in `evals/expected.json` (`plantedFaults`), shown in the app's Track record card. Candidate rule: show which lines of a supported function no asserting test reaches. |
| 14 | Planted faults F5, F6 (Order Import) on commit 1 | Escaped a 5/5 green suite. The map had marked `importOrder()` Unverified. Caught on commit 2. | This is the walkthrough's gap, now measured. | Added as evals. This is the main number in the demo. |
| 15 | Taking the teammate tool's results into this map | Their severity and route come from their policy file, not ours. | Two rule sets exist. Recomputing theirs here would need their row model and .NET. | The route banner names the source ("recorded, not recomputed") and their rule id. Their expectations became our evals for those PRs. |
| 16 | Recorded Tieto PRs have one commit each | "Previous / Next" would have nothing to step through. | The second step is new evidence on the same commit. | Steps are labelled "same commit, new evidence". A sign-off belongs to one step, so a decision made before the targeted check does not carry over. |

## How misses and false alarms become evals

1. A reviewer or incident confirms a miss (for example a caller the map did
   not show) or a false alarm (a blocker that was not real).
2. Save the smallest reproduction: the base and PR commits as a fixture
   overlay in `sample/commits/`, plus any altered evidence.
3. Write the expected label and route in `evals/expected.json` **before**
   changing the rules.
4. Add the case to `evals/run.mjs`. It fails first, then passes after the fix.
5. Track three counters over time: missing callers, overclaimed coverage,
   stale evidence. Rows 2, 5 and 6 above are the first entries.

## Not done

- No comparison with real people of "map vs diff alone".
- No live GitHub or CI integration.
- The Tieto C# tests were not run here (no .NET SDK). The real PRs are shown from packs recorded by the teammate project.
