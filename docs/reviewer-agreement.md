# Measurement: does the AI reviewer agree with itself?

The independent reviewer (`claude-sonnet-5-5`, print mode, no tools, fresh process) was run again on exactly the
same inputs as the recorded review the app replays: same prompt, same input hash. Two fresh runs on the trap
(`req-17` commit 1, Order Import untested) and two on the clean docs change (`docs-example`).
For each run the route comes from the app's own classifier, and findings are compared by category and cited
file and line (within 3 lines). Only "Action required" and "Needs evidence" findings are compared.

| PR | Review | Ran at (UTC) | Route | Same route | Recorded findings found again | Findings that matter | New findings |
|---|---|---|---|---|---|---|---|
| req-17 ae08cfb | recorded | 2026-11-14 05:41 | Waiting for checks or evidence | yes | - | Needs evidence: src/import/orderImport.ts:28, src/import/orderImport.ts:12, tests/orderImport.test.ts:5 | - |
| req-17 ae08cfb | fresh | 2026-11-14 23:33 | Waiting for checks or evidence | yes | 1 of 1 | Needs evidence: src/import/orderImport.ts:28, tests/orderImport.test.ts:5<br>Needs evidence: src/pricing/discount.ts:5, tests/ledger.test.ts:6 | Needs evidence: src/pricing/discount.ts:5, tests/ledger.test.ts:6 |
| req-17 ae08cfb | fresh | 2026-11-14 23:33 | Waiting for checks or evidence | yes | 1 of 1 | Needs evidence: src/import/orderImport.ts:28, tests/orderImport.test.ts:5, src/pricing/discount.ts:10<br>Needs evidence: src/pricing/discount.ts:10, tests/ledger.test.ts:6 | Needs evidence: src/pricing/discount.ts:10, tests/ledger.test.ts:6 |
| docs-example 9f5f233 | recorded | 2026-11-14 05:41 | Auto-merge eligible (dry run) | yes | - | none | - |
| docs-example 9f5f233 | fresh | 2026-11-14 23:34 | Auto-merge eligible (dry run) | yes | 0 of 0 | none | none |
| docs-example 9f5f233 | fresh | 2026-11-14 23:34 | Auto-merge eligible (dry run) | yes | 0 of 0 | none | none |

**Conclusion:** all four fresh runs gave the recorded route and the trap runs both found the Order Import gap again, but each trap run also added one extra "Needs evidence" finding (other callers of `applyDiscount()`), so the route is stable while the list of findings is not identical.

Not compared: summaries, "Pre-existing" findings and the "could not decide" questions (one docs run asked which
requirement the change belongs to; the route was still auto-merge eligible because that question is not a finding).

## Re-run it

```
npm run setup                                  # builds .demo; the recorded reviews must match their inputs
node scripts/reviewer-agreement.mjs            # tops up to 2 fresh runs per target, then prints the table
node scripts/reviewer-agreement.mjs --runs 3   # one more run per target
node scripts/reviewer-agreement.mjs --report   # no model calls; table from saved runs
```

Each fresh run calls the `claude` CLI once and is saved to `data/agreement/`. Runs whose inputs no longer match
are ignored. The recorded reviews in `data/reviews/` are never written.
