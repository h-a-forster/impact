# Concept card: Code Review Impact Map

## Recommendation

Make the **review decision** the product, not the diff.

For every PR commit, show one screen with:

1. **The path.** A map from the edited function to every caller, including
   callers the diff never touches.
2. **The evidence, per caller.** A caller counts as supported only when a
   test that cites the requirement reaches it and passed **on that exact
   commit**. Otherwise it is shown as **Unverified**, even when the suite is
   green.
3. **The route.** Deterministic rules give a severity and one route:
   Waiting for checks or evidence, Human review required, or Auto-merge
   eligible (dry run).
4. **The decision.** A named engineer requests a check, escalates or signs
   off. The record is tied to one commit and never carries over.

AI is used where reading is needed (the independent review). Rules are used
where repeatability is needed (severity, route, claim labels).

## Three kinds of evidence, strongest first

| Label on screen | What stands behind it |
|---|---|
| **Fails on base, passes here** (proven · changed) | The same test was run against the code before the change and failed. The change caused the behaviour. |
| **Held** (proven · held) | The test passes before and after. The behaviour was preserved. It does not show the change did anything. This is the right evidence for "behaviour to preserve". |
| **Exercised only** | A passing test executed the line. Nothing asserted its result. Weak. |
| **Unverified** | No executed check reaches it. |
| **Contradicted** | A check that passed on base fails on the change. Severity is raised and a named human decides. |

A green suite cannot tell these apart. The map can.

## How we measure the map itself: planted faults

We plant known bugs into a copy of each PR commit and run the same suite (`npm run planted`,
[measurement.md](measurement.md)). On REQ-17 commit 1 the suite is green and 4 of 8 planted faults get
past it. Two of them sit in Order Import, exactly where the map said **Unverified**. On commit 2 the
new test catches both. One fault escapes where the map said Supported: a real miss, kept on record.
The method, and the before/after idea, come from the teammate project Impact Ledger.

## Trade-offs

| Choice | Gain | Cost |
|---|---|---|
| Rules set the route. AI findings are advisory. | Same inputs, same route. Easy to audit. | A sharp AI finding cannot block on its own. A human must act on it. |
| Evidence = requirement-tagged test + static reach + pass on this commit. | Simple, inspectable, hard to fake with a stale result. | Depends on test naming. Static reach can overstate what ran. |
| Graphify code-only index, no model. | Fast, local, free, labelled EXTRACTED / INFERRED. | No test-level symbols, no dynamic calls, one language verified. |
| Policy read from the base commit. | A PR cannot loosen its own review. | Policy changes need their own reviewed PR first. |
| Recorded AI review replay. | Demo is repeatable offline. | A replay only counts when its inputs match. Otherwise the app says "unavailable". |

## Limits

- The synthetic repo is analysed here. The real Tieto PRs are shown from recorded packs made by another tool; their route comes from that tool's rules. One screen, two engines behind it.
- "Supported for the tested case" means that case only. It is not proof of
  correctness.
- The index can miss callers (dynamic calls, other repos). The app shows this
  as an **Inferred** claim, not a verified one.
- Human-vs-diff timing comparison was not run.

## What counts as evidence in other kinds of change

| Change | Evidence the map would ask for | Why |
|---|---|---|
| **Frontend** | A **user-flow assertion**: a browser test that walks the affected flow (for example add to cart → checkout) and asserts the visible result, run on the reviewed commit. | Component unit tests pass while the flow breaks. The affected "caller" is the user journey. |
| **Backend** | An **integration test** through the real entry point (API route, queue consumer, import job) that hits the changed code with the requirement's case. | This is the Order Import case in the demo: the shared function was tested, the workflow was not. |
| **Sensitive code** | A **team rule for full review**. Paths listed in `review-policy.yml` (`critical_paths`) are High and go to a named engineer, however small the diff. | Blast radius is not measured by node count. One line in the payments ledger can matter more than fifty elsewhere. |

## Scaling

- **Index per project.** Each project (service, package) gets its own index
  and its own saved exports keyed by commit SHA. Cross-project links are
  stored as boundary edges between project indexes, and shown as inferred
  until resolved.
- **Update only what changed.** On a new commit: take the changed files from
  `git diff`, re-extract those files, then re-resolve only the references
  that point into or out of them. Graphify already caches per-file AST
  results by content hash (this demo saw the cache directory per run).
  Unchanged files keep their nodes and stable IDs.
- **Re-run evidence only where it can change.** A new commit invalidates
  results for that commit only. Tests are re-run; the test map is rebuilt
  for changed test files and for tests that reach changed symbols.
- **Roll up, do not draw everything.** The graph has three levels. Counts
  roll up from functions to files to workflows, so a reviewer starts at
  "which workflows are touched and which are unverified" and drills down.
- **Keep gaps visible.** Unindexed languages fall back to file-level nodes
  with a visible "no symbols indexed" label, as the docs and policy files do
  in this demo.

## Feedback loop

Every confirmed miss or false alarm becomes a replayable eval case:
a fixture commit, the altered evidence, and the expected label and route.
`evals/run.mjs` already replays altered evidence this way (wrong-revision
result, wrong-workflow test, invalid citation, failed check).
