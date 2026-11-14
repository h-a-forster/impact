# 90-second live walkthrough

Before you start: `npm run reset` then `npm start`.
Open <http://localhost:4317/#pr=req-17>. It lands on **PR commit 1**.

**With the GitHub replica** (recommended opening): also run `npm run dev` in
`../REA/github-replica`. Start at
<http://localhost:3000/junction-demo/shop-sample/pull/1>. Point at the green unit-test
tick on commit 1 and the bot comment "Waiting for checks or evidence". Click
**Open Impact Map** in that comment. It opens this app on commit 1. Continue from 0:20
below. After the sign-off, go back to the PR page and refresh: the Impact review check
is green and your sign-off is on the timeline.

| Time | Do | Say |
|---|---|---|
| 0:00 | Point at `unit-tests · passed 5/5` (top right of the banner). | "An AI agent changed how discounts round, for REQ-17. All checks are green. In a normal PR, I would approve now." |
| 0:10 | Point at the banner: **Medium · Waiting for checks or evidence**. | "The map says wait. One thing is unverified." |
| 0:20 | In the graph, follow PR → `applyDiscount()` (amber) → `importOrder()` (red, dashed). Click `importOrder()`. | "The agent edited one shared function. Order Import calls it. Order Import is not in the diff." |
| 0:35 | In the side panel, point at line 28 (highlighted) and the red box. | "This is the real code at this commit. Line 28 calls the edited function. No REQ-17 test goes through here. The one import test that exists checks something else." |
| 0:45 | Scroll to **Author claims**: the red **Unverified** claim. Then the AI review finding. | "The agent claimed Import was fine because it shares the function. That is a reading of the code, not a test result. An independent AI reviewer, in a separate context, says the same and names the exact test to add." |
| 0:55 | Press **Next**. | "The agent adds that test in the next commit." |
| 1:00 | Point at the banner: **Medium · Human review required**. Click the new test node (marked NEW), then "open run result". | "Now there is a passing Import test, run on this commit. The route moves to a human." |
| 1:10 | Scroll to **Human decision**. Type your name. Residual risk: "consumers outside this repo". Press **Record decision**. | "I sign off, by name, on this commit. The record lists what the runner checked, what the AI checked, what I checked, and what is still open." |
| 1:20 | Press **Previous**. | "Back on commit 1 the gap is still there, and my sign-off does not apply. Approval belongs to one commit." |
| 1:25 | Finish (see below). | |

## Closing line: what ran live, what was recorded, what is incomplete

- **Live:** the Git commits and diffs, the map, the claim checks, both
  classifiers, the route, and the sign-off.
- **Recorded:** the test runs (real runs, saved per commit), the Graphify
  index (real exports, saved per commit), and the AI review (a real model
  response, saved with its prompt, replayed).
- **Incomplete:** no GitHub or CI hook, one language, static reach only, and
  no measured comparison against reading the diff alone.

## The real Tieto PR (30 seconds, strongest closer)

Open <http://localhost:3000/te-industry-tech-office/junction26-messagepack-csharp/pull/1>.

- "This is Tieto's own sample. One agent commit, four files. 170 of 170 tests pass."
- Point at the first bot comment: **Medium · Waiting for checks or evidence**. "The AI reviewer refused
  to decide one requirement clause and named the check that would settle it."
- Point at the second bot comment: **High · Human review required**. "That check was written and run.
  It passes before the change and fails after it. The change silences an error the consumer used to get."
- Click **Open Impact Map**, then the red `GetObjectInfo()` box, then row `RCH-26`: the code line, the
  check, base Passed → head Failed.
- Say what it is: "This evidence was recorded by our teammate tool, Impact Ledger, with real dotnet test
  runs. Our map shows it. It does not recompute it."

## The number to quote

"We planted eight known bugs into the commit with the green suite. Four got past the tests. Two of
those were in the one function the map had marked Unverified. After the targeted test, both are caught."
(`npm run planted`, [measurement.md](measurement.md))

## If there is time (optional, 30 seconds)

Use the **Pull request** picker:

- **[eval] Docs** → Low · Auto-merge eligible (dry run). Nothing is merged.
- **[eval] Ledger** → one-character change, High · Human review required.
- **[eval] Ledger + policy** → the PR loosens `review-policy.yml`. The base
  policy still applies. High.

Then run `npm run evals` in a terminal: 94 of 94 pass. And `npm run gate -- req-17`: MERGE BLOCKED until a named sign-off.

## Slide outline for the video

1. **Problem.** AI writes code faster than people can stand behind it.
   A PR shows edits, not consequences.
2. **Idea.** Review the decision: path → evidence → route → named sign-off.
3. **Demo.** The walkthrough above.
4. **Trust rules.** Evidence must match the commit, the workflow and the
   requirement. Policy comes from base. AI advises, rules route, a human signs.
5. **Proof.** 94 review evals and a planted-fault run: wrong-revision result, wrong-workflow test,
   invalid citation, failed check, docs, sensitive path, policy self-patch,
   decision per commit.
6. **Limits and next.** One language, static reach, no CI hook. Next: per-test
   coverage, GitHub check, per-project incremental indexing.
