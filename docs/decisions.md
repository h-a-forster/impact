# Decisions

The open questions from Tieto's challenge brief (*Earned Trust in AI Code*) and how we answered them.
The deliverable is the **review decision**: a named engineer finds a caller outside the diff, sees why
green checks leave it unverified, asks for a targeted check, and signs off on the later commit.

| # | Open question | Decision | Reason | How verified |
|---|---|---|---|---|
| 1 | Which sample? | Synthetic REQ-17 case from the brief. | No team-owned copy of the Tieto C# repo was available, and .NET is not installed, so its tests could not be run. | `npm run evals` walkthrough cases. |
| 2 | Sample language? | TypeScript, run directly by Node 26. | Node is already installed. Graphify supports TypeScript. Tests run with `node --test`, no extra tooling. | Real test runs saved in `data/runs/`. |
| 3 | Stack? | Small local Node web app. Plain HTML/JS frontend. One dependency (`yaml`). | Empty repo. Fewest moving parts for a one-command run. | `npm start` then open the app. |
| 4 | Indexer? | Graphify 0.9.108, `graphify extract . --code-only`, `GRAPHIFY_BACKEND=none`. | Brief says try it first. It found `applyDiscount`, the unchanged `importOrder`, and the call between them with a line number. | Eval `map-integrity` re-checks the call site in the real source at each commit. |
| 5 | Graphify limits? | Keep them visible in the app. Graphify gave no symbols for test files and no function end lines. A labelled rule-based test mapper parses `test(...)` blocks. End lines come from brace matching. | Needed per-test links. Did not need a second indexer. | Coverage notes shown in the app header. Lessons log entries. |
| 6 | Where do generated files go? | Snapshots and Graphify work files in `.demo/` (ignored). Saved exports, test runs and AI reviews in `data/` keyed by commit SHA. | Brief: keep generated files outside the indexed tree. Saved data allows a replay without Graphify or a model. | `data/revisions.json` SHAs match the rebuilt repo (setup checks this). |
| 7 | Mapping passes: model or rules? | Rule-based and labelled as such: concept mapper (folder groups with labels from `config/concepts.json`), dependency mapper (Graphify edges), test mapper (parser). | Deterministic and inspectable. The brief allows labelled rule-based output. | Labels shown in the app. |
| 8 | How do models run? | Independent AI review through the `claude` CLI in a fresh process, no tools, empty working folder, model `sonnet`. Real prompt and response saved in `data/reviews/` for replay. | Runs through the signed-in CLI, no API key needed. A fresh process gives a separate context from the authoring pass. | Saved inputs + response. App shows "recorded" vs "live" vs "rule-based fallback". |
| 9 | Do AI findings set the route? | No. Deterministic classifiers set severity and route. AI findings are shown, citation-checked, and can only raise caution. | Brief: use deterministic rules for both classifiers. Keeps the route repeatable. | Evals expect exact routes. |
| 10 | What counts as evidence for a workflow? | A test that (a) reaches the function through mapped calls, (b) cites the requirement ID, (c) passed in a run recorded for the selected commit. | Matches `REVIEW.md` rule 3. A green suite alone does not qualify. | Evals `wrong-revision`, `checkout-only-test`, `failed-check`. |
| 11 | Which policy applies? | `review-policy.yml` and `REVIEW.md` read from the **base** commit. | A PR must not grant itself lighter checks. | Eval `policy-self-patch`. |
| 12 | GitHub link? | Stable local link `http://localhost:4317/#pr=<id>&rev=<sha>`. Saved PR brief in `briefs/`. No live PR or check updates. | Local demo. Brief says add GitHub updates only after the local walkthrough works. | Opening the link selects the PR and commit. |
| 12c | How to combine with the companion tool (Impact Ledger)? | One map: ours. Their best parts go inside it. (1) The real Tieto PRs are shown from their recorded packs through an adapter (`src/lib/ledger.mjs`). (2) Before/after runs: proof is `changed` or `held`. (3) Planted faults as the measurement. (4) A merge gate command. (5) Row states, including `contradicted` and `exercised only`, and the reviewer's refusals. | The brief's first choice is the sponsor's own sample; they had it with real `dotnet test` evidence and we had no .NET. Their strongest ideas are cheap to add and close gaps in Measurement and Evidence. Two UIs would mean two stories. | 26 new evals. Route and contradicted rows match the expectations in their own eval cases. |
| 12d | What is not taken from them? | Reading depth and tiers, the signed record format, numbers-in-prose check, their Python pipeline. | Out of scope for the brief; would duplicate our decision record. | Listed in the concept card. |
| 13 | Who approves? | Named human in the app. Stored per commit in `.demo/decisions.json`. Auto-merge is a dry-run label only. | Brief. | Eval `decision-integrity`. |
| 14 | CI? | No CI in this demo. The runner record is labelled **Local run**. | Honest labelling. | Label shown on every check. |

## Expected review outcomes (written before the reviewer ran)

See [evals/expected.json](../evals/expected.json).

- Base: graph shows `checkoutTotal` and `importOrder` both calling `applyDiscount`. No route.
- PR commit 1: `importOrder` shown as unchanged downstream caller. Checkout supported. Import **Unverified**. **Medium + Waiting for checks or evidence**.
- PR commit 2: Import supported by the new test run on that commit. **Medium + Human review required**. Sign-off allowed here only.
