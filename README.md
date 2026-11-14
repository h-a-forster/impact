# Code Review Impact Map

Reference implementation for Junction · Tieto, *Earned Trust in AI Code*.

A normal PR shows the edits. This app shows what else depends on the edited
code, what the tests actually establish, and lets a named engineer record a
decision on one specific commit.

One map, two kinds of pull request:

| Repo | What it is | Where the evidence comes from |
|---|---|---|
| `junction-demo/shop-sample` | Synthetic TypeScript repo. The two-commit REQ-17 story that ends in a sign-off. | Built, indexed, tested and reviewed **by this project**. |
| `te-industry-tech-office/junction26-messagepack-csharp` | The **real Tieto sample**. Four agent-written C# PRs. | **Recorded packs** from the teammate project [Impact Ledger](https://github.com/h-a-forster/junction26-earned-trust), in `data/tieto/`. Shown here, not recomputed. |

On the real PR #1 (issue 2283) the suite is green (170/170), the route is *Waiting for checks or
evidence*, and the check the AI reviewer asked for then **fails on the change**: severity goes to High
and the route to *Human review required*.

## Run it

Needs Node 22.6+ (built with Node 26) and Git.

```
npm run demo
```

Then open <http://localhost:4317/#pr=req-17>.

`npm run demo` installs one dependency, rebuilds the sample Git repo, reuses
the saved evidence in `data/`, and starts the app. It needs no model access
and no Graphify install.

| Command | What it does |
|---|---|
| `npm run demo` | Install, set up, start the app. |
| `npm run setup` | Rebuild the sample repo. Reuse saved evidence when the commit SHAs and inputs match. |
| `npm run setup:fresh` | Also re-run the tests and Graphify on every commit. Needs Graphify: `uv tool install graphifyy --python 3.12` |
| `npm run review:live` | Re-run the independent AI review for every PR commit. Needs the `claude` CLI, signed in. |
| `npm start` | Start the app only. |
| `npm run build:graph` | Rebuild the map graph (React Flow + Dagre) from `src/graph/main.jsx` into `src/public/graph.bundle.js`. Only needed after editing that file; the built bundle is committed. |
| `npm run evals` | Run the 94 review evals. |
| `npm run planted` | Plant known bugs into each REQ-17 commit and measure what the tests and the map catch. Writes `docs/measurement.md`. |
| `npm run gate -- <pr id or number> [owner/name]` | Merge gate. Exit 0 only when the latest step is signed off by a named person. |
| `npm run import:ledger -- <path to a clone of junction26-earned-trust>` | Refresh the recorded Tieto packs in `data/tieto/`. |
| `npm run reset` | Clear recorded human decisions. |
| `npm run export:replica` | Write the shop-sample repo and PRs into the GitHub replica's data folder. |

## Run it inside the GitHub replica

The sibling worktree `../REA/github-replica` is a local copy of GitHub's PR pages.
This app plugs into it like a GitHub App.

```
# terminal 1 (this folder)
npm run demo

# terminal 2 (../REA/github-replica)
npm install
npm run dev
```

Open <http://localhost:3000/junction-demo/shop-sample/pull/1>.

- The PR page shows one **Impact Map bot comment per commit**, the **Impact review**
  check, and the unit-test row. All of it is read live from this app
  (`GET /api/summary?repo=<owner/name>&pr=<number>`).
- **Open Impact Map** and the **Impact Map** tab open this app at
  `/?repo=<owner/name>&pr=<number>&sha=<sha>`.
- Sign off here, refresh the PR page: the check turns green and the sign-off is on the timeline.
- The real Tieto PRs in the replica are **not analysed**. They show "queued", and this
  app says so instead of showing another repo's map.
- `npm run export:replica` rewrites the replica's shop-sample data after the sample changes.

## The 90-second walkthrough

See [docs/demo-script.md](docs/demo-script.md).

1. **PR commit 1.** Checks are green (5/5). The route is still
   **Medium · Waiting for checks or evidence**.
2. Click the red **importOrder()** node. It is not in the diff. It calls the
   edited `applyDiscount()` at line 28. No REQ-17 test exercises it.
3. Press **Next**. PR commit 2 adds the Order Import test. The route becomes
   **Medium · Human review required**.
4. Open the test and its run result. Sign off with your name.
5. Press **Previous**. The gap is still shown on commit 1, and your sign-off
   does not apply there.

## Blast radius tab (PR #1 only)

Open: `http://localhost:4317/?map=blast#pr=ju26-issue-2283` (tab "Blast radius" in the Impact map card).

We gave the same task to 3 agents: one careful ("minimal"), one normal, one that changes too
much ("wide"). What they touched is the zone a fix can reasonably reach. The real change
(Tieto's AI-written branch, shown as a PR) is laid over that zone.

- **Real runs, recorded.** 2026-11-14, model `claude-fable-5-2`, `claude -p` once per agent, each in
  its own copy of the Tieto repo at the base commit `32258fd` (the branch with the real fix was
  never fetched). No shell, no git, no web. The result is saved in
  `data/tieto/ju26-issue-2283/blast.json`; the tab replays it offline.
- **What the agents got:** `data/tieto/ju26-issue-2283/blast-prompts/requirements.md` = the
  Requirement, Why, Before/after (first part) and Must preserve rows of the AI PR, plus the bug
  report #2283 word for word. Left out: Summary, Approach, Alternatives, Checks run, Open gaps,
  Rollback (they describe the real fix). The 3 prompts differ only in the "How to work" lines.
- **Unit tests, run both ways** (recorded afterwards on a machine with a .NET SDK, by
  `node scripts/blast-tests.mjs <clone of the sample repository>`; saved in
  `data/tieto/ju26-issue-2283/blast-tests.json`). The agents themselves could not build the code.
  - The wide agent's own unit tests: 2 of 5 pass on the old code, 5 of 5 on the real change.
    A test written without seeing the real change notices the bug, and the real change passes it.
  - The real change's unit tests (19): 16 pass on the old code, 18 on each of the three agents' fixes.
    The one that fails on all three, `ClosedGenericStruct_FromMetadataReference_UnkeyedMember`,
    expects no MsgPack004 diagnostic for a type from a referenced assembly. No agent's fix silences
    that diagnostic; only the real change does. The tab shows it as a question for a named person.
- **Rebuild the record:** put the 3 agent folders under `.demo/blast/{minimal,normal,wide}`
  (git-ignored), run the agents, then `node scripts/record-blast.mjs`.
- **Maths:** `src/lib/blast.mjs`, served by `GET /api/blast?pr=<id>`. Functions are found by a
  simple reader of the C# text, the same way for all 4 changes. Callers come from the saved
  Graphify run and the recorded compiler data; code they do not cover shows "not known".
- **File level.** The picture and the main table show files: one box and one row per file, with
  lines added and removed per change. Function numbers, reach and overlap sit in a fold.
- **Trust label rule.** Look at the product code files the real change touches (not docs, not
  unit tests).
  1. No agent touched one of them: "Touches code no agent touched".
  2. Else, only the wide agent touched one of them: "Touches more than needed".
  3. Else: "Inside the expected zone".
  Docs, unit test files and functions are not scored. They are named in the line under the
  label. The other 3 PRs have no runs and say so.

## What is real, what is recorded, what is rule-based

| Part | Status |
|---|---|
| Sample repo, commits, diffs | Real Git commits, rebuilt from `sample/` with fixed dates so SHAs are stable. |
| Test results | Real `node --test` runs on a clean snapshot of each commit. Saved in `data/runs/<sha>.json`. Labelled **local run**. There is no CI. |
| Code index | Real Graphify 0.9.108 code-only exports, one per commit, in `data/graphify/<sha>.json`. |
| Independent AI review | Real model responses (`claude` CLI, fresh process, no tools). Prompt and response saved in `data/reviews/<sha>.json`. The app replays them and says so. |
| Concept, dependency and test mappers | Rule-based, labelled in the app. |
| Claim verifier, Classifier 1, Classifier 2 | Deterministic rules. |
| Before/after evidence | Real: each PR commit's tests are also run against the base code (`data/runs/<sha>.base.json`). "Fails on base, passes here" shows the change caused it. "Held" means it passed before too. |
| Planted faults | Real, rule-based: 8 hand-written bugs planted into copies of each REQ-17 commit, same suite run. `data/planted/`, `docs/measurement.md`. |
| Real Tieto PRs | Recorded by the Impact Ledger project: Roslyn links, `dotnet test` on base and head, one AI review per change, severity and route. Imported unchanged into `data/tieto/`. This project does not re-run them (no .NET SDK here). |
| Auto-merge | Dry-run label only. Nothing is ever merged. |
| GitHub | Not connected to real GitHub. Connected to the local GitHub replica (`../REA/github-replica`): links in, live status out. |

## Layout

```
sample/            fixtures for the sample repo (base + commit overlays)
briefs/            saved PR briefs (one template for human and agent authors)
config/            trusted demo config for the concept mapper
data/              saved evidence, keyed by commit SHA (runs, graphify, reviews, planted)
data/tieto/        recorded packs for the real Tieto PRs (from Impact Ledger; MIT; not edited)
planted/           the planted faults, written before the run
src/lib/           pipeline: git, graphify adapter, test mapper, claims,
                   classifiers, reviewer, model, decisions,
                   github (summary API + export for the GitHub replica)
src/public/        the web app
src/server.mjs     local server
scripts/setup.mjs  one-time setup
evals/             review evals and expected outcomes
docs/              concept card, lessons log, demo script
PLAN.md            plan and decision log
.demo/             generated (ignored): sample repo, snapshots, decisions
```

The team's `REVIEW.md` and `review-policy.yml` live in the sample repo
(`sample/base/`). The app always reads them from the **base** commit.

## Known limits

- Two sources with different depth: the shop repo is analysed here (TypeScript, Graphify); the Tieto repo is shown from recorded packs (C#, Roslyn). Their severity and route come from that project's rules, named on screen.
- For the Tieto PRs there is no Base view and no test list: the packs carry changed files at the head commit and run totals only.
- Graphify gave no symbols for test files and no function end lines. The app
  fills those with a labelled rule-based parser and brace matching.
- "Reach" is static: a call path exists. It is not proof the line ran.
- Dynamic calls and consumers outside the repo are not indexed.
- No live GitHub, CI, merges, background scans or PR chat.
- The comparison "map vs diff alone" with real people was not run.
