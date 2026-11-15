// Review evals. They test whether the system finds the right path, cites the
// right evidence and takes the expected route. (Rounding itself is tested by
// the sample's own tests.)   Run with:  npm run evals
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileAt } from "../src/lib/git.mjs";
import { buildModel, demoRevisions, loadBrief, loadRevisions } from "../src/lib/model.mjs";
import { loadRun } from "../src/lib/runner.mjs";
import { decisionView, recordDecision } from "../src/lib/decisions.mjs";
import { findPr, prSummary } from "../src/lib/github.mjs";
import { buildSwarm } from "../src/lib/swarm.mjs";
import { buildLedgerModel, ledgerPrs } from "../src/lib/ledger.mjs";
import { prComment } from "../src/lib/comment.mjs";
import { loadReview } from "../src/lib/reviewer.mjs";
import { SENTENCE_MAX, cutAtWord, issueList, verdictSentence } from "../src/lib/verdict.mjs";
import { DATA } from "../src/lib/paths.mjs";
import { prOverlays, reviewSampleChange } from "../src/lib/edit-check.mjs";
import { editCheckSummary } from "../src/lib/edit-check-view.mjs";
import { ROOT } from "../src/lib/paths.mjs";

const expected = JSON.parse(fs.readFileSync(path.join(ROOT, "evals", "expected.json"), "utf8"));
const revisions = loadRevisions();
const baseSha = revisions.base.sha;
const req17 = revisions.prs.find((p) => p.id === "req-17");
const [c1, c2] = req17.commits.map((c) => c.sha);
const IMPORT = "fn:src/import/orderImport.ts#importOrder";
const CHECKOUT = "fn:src/checkout/checkout.ts#checkoutTotal";
const APPLY = "fn:src/pricing/discount.ts#applyDiscount";

const results = [];
let group = "";
function check(name, actual, want) {
  const pass = JSON.stringify(actual) === JSON.stringify(want);
  results.push({ group, name, pass, actual, want });
}
const evidenceOf = (m, id) => m.evidence.find((e) => e.nodeId === id)?.status;
const claimOf = (m, id) => m.claims.find((c) => c.id === id)?.label;
const checkOf = (m, name) => m.checks.find((c) => c.name === name)?.status;
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- 1. Walkthrough ------------------------------------------------------
group = "Walkthrough";
{
  const base = buildModel(revisions, "req-17", baseSha);
  const callers = base.graph.edges.filter((e) => e.level === "function" && e.kind === "calls" && e.to === APPLY).map((e) => e.from).sort();
  check("base: graph shows both callers of applyDiscount()", callers, expected.walkthrough.base.callersOfApplyDiscount);
  check("base: no route", base.classifier2, null);

  const m1 = buildModel(revisions, "req-17", c1);
  const w1 = expected.walkthrough.commit1;
  check("commit 1: edited function", m1.impact.edited.map((e) => e.id), w1.edited);
  check("commit 1: unchanged downstream callers shown", m1.impact.downstream.map((e) => e.id).sort(), w1.downstream);
  check("commit 1: import caller is not in the diff", m1.diff.files.some((f) => f.file === "src/import/orderImport.ts"), false);
  check("commit 1: suite is green", checkOf(m1, "unit-tests"), w1.requiredChecks["unit-tests"]);
  check("commit 1: Checkout supported", evidenceOf(m1, CHECKOUT), w1.evidence[CHECKOUT]);
  check("commit 1: Import UNVERIFIED despite green suite", evidenceOf(m1, IMPORT), w1.evidence[IMPORT]);
  check("commit 1: author's import claim label", claimOf(m1, "c3"), w1.importClaimLabel);
  check("commit 1: initial severity", m1.classifier1.severity, w1.initialSeverity);
  check("commit 1: final severity", m1.classifier2.severity, w1.finalSeverity);
  check("commit 1: route", m1.classifier2.route, w1.route);
  check("commit 1: blocker names a targeted check", Boolean(m1.classifier2.blockers.find((b) => b.ref === IMPORT)?.suggestedCheck), true);
  check("commit 1: AI review is a real recorded response for these inputs", [m1.review.mode, m1.review.available], ["recorded-llm", true]);
  check("commit 1: AI review flags a gap with a valid citation into the import file", m1.review.findings.some((f) => f.category === "Needs evidence" && f.citationsValid && f.citations.some((c) => c.file === "src/import/orderImport.ts")), true);

  const m2 = buildModel(revisions, "req-17", c2);
  const w2 = expected.walkthrough.commit2;
  check("commit 2: Import supported by a test run on this commit", [evidenceOf(m2, IMPORT), m2.run.revision === c2], [w2.evidence[IMPORT], true]);
  check("commit 2: Checkout still supported", evidenceOf(m2, CHECKOUT), w2.evidence[CHECKOUT]);
  check("commit 2: author's import claim label", claimOf(m2, "c3"), w2.importClaimLabel);
  check("commit 2: zero-discount check cited and passed for both workflows", [claimOf(m2, "c4"), claimOf(m2, "c7")], ["Verified", "Verified"]);
  check("commit 2: severity kept", [m2.classifier1.severity, m2.classifier2.severity], [w2.initialSeverity, w2.finalSeverity]);
  check("commit 2: route", m2.classifier2.route, w2.route);
  check("commit 2: new test link is marked as new", m2.impact.newLinks.some((l) => l.id.includes("REQ-17 import: 105")), true);
  check("going back to commit 1 still shows the gap", evidenceOf(buildModel(revisions, "req-17", c1), IMPORT), "unverified");
}

// ---- 2. Map integrity ----------------------------------------------------
group = "Map integrity";
for (const [label, sha] of [["base", baseSha], ["commit 1", c1], ["commit 2", c2]]) {
  const m = buildModel(revisions, "req-17", sha);
  const edge = m.graph.edges.find((e) => e.level === "function" && e.from === IMPORT && e.to === APPLY);
  const line = (readFileAt(sha, edge?.anchor.file ?? "") ?? "").split("\n")[(edge?.anchor.line ?? 0) - 1] ?? "";
  check(`${label}: import caller links to real code at this revision`, [Boolean(edge), /applyDiscount\(/.test(line)], [true, true]);
  check(`${label}: Graphify confidence label kept on the link`, edge?.confidence, "EXTRACTED");
  check(`${label}: all three zoom levels have nodes`, ["concept", "file", "function"].map((l) => m.graph.nodes.some((n) => n.level === l)), [true, true, true]);
  check(`${label}: run result on screen is for the selected commit`, m.run.revision, sha);
  check(`${label}: selection, diff and model agree`, [m.selected.sha, m.diff.files.length > 0], [sha, sha !== baseSha]);
}
{
  const m1 = buildModel(revisions, "req-17", c1);
  const importTestId = "test:tests/orderImport.test.ts#REQ-17 import: 105 cents at 10% totals 94 cents";
  check("a node that only exists at commit 2 is absent at commit 1 (app says so)", m1.graph.nodes.some((n) => n.id === importTestId), false);
}

// ---- 3. Evidence integrity -----------------------------------------------
group = "Evidence integrity";
{
  const e = expected.evidenceIntegrity;
  // (a) A passing result from the wrong revision.
  const wrong = buildModel(revisions, "req-17", c1, { run: loadRun(c2) });
  check("wrong-revision result: import stays unverified", evidenceOf(wrong, IMPORT), e.wrongRevisionResult.importEvidence);
  check("wrong-revision result: required check is stale", checkOf(wrong, "unit-tests"), e.wrongRevisionResult.check);
  check("wrong-revision result: route", wrong.classifier2.route, e.wrongRevisionResult.route);
  check("wrong-revision result: recorded AI review no longer counts as available", wrong.review.available, false);

  // (b) A test that only exercises Checkout, offered as evidence for Import.
  const briefB = clone(loadBrief("req-17"));
  const claimB = briefB.revisions["1"].claims.find((c) => c.id === "c3");
  Object.assign(claimB, { kind: "test-passed", test: "test:tests/checkout.test.ts#REQ-17 checkout: 105 cents at 10% totals 94 cents", supports: IMPORT });
  delete claimB.cite;
  const b = buildModel(revisions, "req-17", c1, { brief: briefB });
  check("checkout-only test cited for Import: claim stays unverified", claimOf(b, "c3"), e.checkoutOnlyTest.importClaimLabel);
  check("checkout-only test cited for Import: evidence stays unverified", evidenceOf(b, IMPORT), "unverified");

  // (c) Invalid citations.
  const briefC = clone(loadBrief("req-17"));
  briefC.revisions["1"].claims.find((c) => c.id === "c1").cite = { file: "src/pricing/discount.ts", line: 999 };
  briefC.revisions["1"].claims.find((c) => c.id === "c3").cite = { file: "src/import/doesNotExist.ts", line: 3 };
  briefC.revisions["1"].claims.find((c) => c.id === "c2").test = "test:tests/orderImport.test.ts#REQ-17 import: 105 cents at 10% totals 94 cents";
  briefC.revisions["1"].claims.find((c) => c.id === "c5").cite = { file: "src/pricing/discount.ts", line: "<img src=x>" };
  const c = buildModel(revisions, "req-17", c1, { brief: briefC });
  check("invalid citation (line out of range): not shown as Verified", claimOf(c, "c1"), e.invalidCitation.claimLabel);
  check("invalid citation (missing file): not shown as Verified", claimOf(c, "c3"), e.invalidCitation.claimLabel);
  check("invalid citation (test exists only at a later commit): not shown as Verified", claimOf(c, "c2"), e.invalidCitation.claimLabel);
  check("invalid citation (line is not a number): not shown as Verified", claimOf(c, "c5"), e.invalidCitation.claimLabel);

  // (d) A failed required check stays a blocker, even with full evidence otherwise.
  const failedRun = clone(loadRun(c2));
  failedRun.status = "failed";
  failedRun.exitCode = 1;
  failedRun.tests[0].status = "failed";
  failedRun.counts = { total: failedRun.tests.length, passed: failedRun.tests.length - 1, failed: 1 };
  const d = buildModel(revisions, "req-17", c2, { run: failedRun });
  check("failed required check: status", checkOf(d, "unit-tests"), e.failedRequiredCheck.check);
  check("failed required check: route", d.classifier2.route, e.failedRequiredCheck.route);
  check("failed required check: listed as a blocker", d.classifier2.blockers.some((x) => x.type === "check" && x.status === "failed"), true);
}

// ---- 4. Policy integrity -------------------------------------------------
group = "Policy integrity";
{
  const p = expected.policyIntegrity;
  const sha = (id) => revisions.prs.find((x) => x.id === id).commits[0].sha;
  const docs = buildModel(revisions, "docs-example", sha("docs-example"));
  check("clean docs change: severity and route", [docs.classifier2.severity, docs.classifier2.route], [p["docs-example"].finalSeverity, p["docs-example"].route]);
  check("clean docs change: required checks passed", checkOf(docs, "unit-tests"), "passed");
  check("clean docs change: dry run only", docs.classifier2.autoMergeDryRun, true);
  const docsNoReview = buildModel(revisions, "docs-example", sha("docs-example"), { reviewRecord: null });
  check("docs change with the AI review unavailable: cannot qualify", docsNoReview.classifier2.route, "Human review required");
  // The team's own limits on the fast lane, read with the author recorded on the commit.
  const lane = (extra) => buildModel(revisions, "docs-example", sha("docs-example"), { policy: { ...docs.policy.rules, auto_merge_dry_run: { ...docs.policy.rules.auto_merge_dry_run, ...extra } } }).classifier2;
  const routeAndRule = (c) => [c.route, c.rule];
  check("docs change by an author on the trusted list: still qualifies", routeAndRule(lane({ trusted_authors: [revisions.author.email] })), ["Auto-merge eligible (dry run)", "C2-ALLOWLIST"]);
  check("docs change by an author not on the trusted list: a person decides", routeAndRule(lane({ trusted_authors: ["someone-else@example.invalid"] })), ["Human review required", "C2-UNTRUSTED-AUTHOR"]);
  const paused = lane({ paused: [{ paths: ["docs/**"], escape_on: "2026-11-14", owner: "Docs lead" }] });
  check("docs change in an area paused after an escape: a person decides, and the reason names the date and owner", [...routeAndRule(paused), paused.reason.includes("2026-11-14; Docs lead lifts it")], ["Human review required", "C2-PAUSED", true]);

  const ledger = buildModel(revisions, "ledger-note", sha("ledger-note"));
  check("trivial edit to a sensitive module: severity and route", [ledger.classifier2.severity, ledger.classifier2.route], [p["ledger-note"].finalSeverity, p["ledger-note"].route]);
  check("trivial edit to a sensitive module: only 1 function edited, 0 downstream", [ledger.impact.edited.length, ledger.impact.downstream.length], [1, 0]);

  const self = buildModel(revisions, "policy-self-patch", sha("policy-self-patch"));
  check("policy self-patch: severity and route", [self.classifier2.severity, self.classifier2.route], [p["policy-self-patch"].finalSeverity, p["policy-self-patch"].route]);
  check("policy self-patch: rules come from the base commit", [self.policy.revision, self.policy.rules.critical_paths], [baseSha, ["src/payments/**"]]);
  check("policy self-patch: the PR's own policy edit is detected and not applied", [self.policy.changedInThisPr, self.classifier2.autoMergeDryRun], [true, false]);

  // Green tests and full evidence, but percents above 100 now give totals below zero.
  const uncapped = buildModel(revisions, "req-21", sha("req-21"));
  check("uncapped discount: severity and route", [uncapped.classifier2.severity, uncapped.classifier2.route], [p["req-21"].finalSeverity, p["req-21"].route]);
  check("uncapped discount: Checkout and Order Import shown as affected", uncapped.impact.downstream.map((e) => e.id).sort(), p["req-21"].downstream);
  check(
    "uncapped discount: the AI reviewer reports the missing upper limit, citing the pricing code",
    uncapped.review.available && uncapped.review.findings.some((f) => f.category === "Action required" && f.citationsValid && f.citations.some((c) => c.file === "src/pricing/discount.ts")),
    p["req-21"].reviewerFlagsUncappedPercent,
  );
}

// ---- 5. Decision integrity ------------------------------------------------
group = "Decision integrity";
{
  const e = expected.decisionIntegrity;
  const file = path.join(os.tmpdir(), `impact-map-eval-decisions-${process.pid}.json`);
  fs.rmSync(file, { force: true });
  const m1 = buildModel(revisions, "req-17", c1);
  const m2 = buildModel(revisions, "req-17", c2);
  const noName = recordDecision(m2, { name: "  ", action: "sign-off", residualRisk: "none" }, file);
  check("sign-off without a name is rejected", noName.ok, false);
  const early = recordDecision(m1, { name: "Eval Engineer", action: "sign-off", residualRisk: "none" }, file);
  check("sign-off on commit 1 (evidence missing)", early.ok ? "accepted" : "rejected", e.signOffOnCommit1);
  const request = recordDecision(m1, { name: "Eval Engineer", action: "request-check", requestedCheck: "Add a REQ-17 import test" }, file);
  check("request-check on commit 1 is recorded", request.ok, true);
  const sign = recordDecision(m2, { name: "Eval Engineer", action: "sign-off", checkedByHuman: "Opened the import test result", residualRisk: "Other consumers of applyDiscount() outside this repo" }, file);
  check("sign-off on commit 2", sign.ok ? "accepted" : "rejected", e.signOffOnCommit2);
  check("sign-off records name, commit, checked-by and residual risk", [sign.decision?.name, sign.decision?.commit, sign.decision?.checked.length > 0, Boolean(sign.decision?.residualRisk)], ["Eval Engineer", c2, true, true]);
  const v1 = decisionView(m1, file);
  const v2 = decisionView(m2, file);
  check("commit 2 is signed off", v2.signedOff, true);
  check("commit 2 sign-off has no effect on commit 1", v1.signedOff, e.commit2SignOffAppliesToCommit1);
  check("older decision stays visible in history from the other commit", [v1.history.length, v2.history.length, v2.history.some((h) => h.commit === c1 && !h.appliesToSelection)], [2, 2, e.historyKept]);
  fs.rmSync(file, { force: true });
}

// ---- 6. Before/after evidence ---------------------------------------------
group = "Before/after evidence";
{
  const m2 = buildModel(revisions, "req-17", c2);
  const proof = (name) => m2.tests.find((t) => t.name === name)?.proof;
  check("the 94-cent Checkout test fails on base and passes here (the change caused it)", proof("REQ-17 checkout: 105 cents at 10% totals 94 cents"), "changed");
  check("the 94-cent Import test fails on base and passes here", proof("REQ-17 import: 105 cents at 10% totals 94 cents"), "changed");
  check("zero-discount checks pass before and after (behaviour held)", [proof("REQ-17 checkout: zero discount keeps the total at 105 cents"), proof("REQ-17 import: zero discount keeps the total at 105 cents")], ["held", "held"]);
  check("the base run is recorded against the base commit, with this commit's tests", [m2.baseRun.revision, /tests\/ taken from commit/.test(m2.baseRun.overlay)], [baseSha, true]);
  check("claims say which kind of proof stands behind them", [m2.claims.find((c) => c.id === "c3").proof, m2.claims.find((c) => c.id === "c7").proof], ["changed", "held"]);
}

// ---- 7. Planted faults ----------------------------------------------------
group = "Planted faults (measurement)";
{
  const e = expected.plantedFaults;
  const planted = JSON.parse(fs.readFileSync(path.join(DATA, "planted", "req-17.json"), "utf8"));
  const at = (sha) => planted.commits.find((c) => c.sha === sha);
  const p1 = at(c1), p2 = at(c2);
  const caught = (p, id) => p.faults.find((f) => f.id === id).caughtByTests;
  check("commit 1: faults planted in Order Import escape a green suite", [caught(p1, "F5"), caught(p1, "F6")], [false, false]);
  check("commit 1: those escapes sit exactly where the map said Unverified", p1.summary.escapedWhereMapSaidUnverified, e.commit1.escapedWhereMapSaidUnverified);
  check("commit 2: the new Order Import test catches the same faults", [caught(p2, "F5"), caught(p2, "F6")], [true, true]);
  check("commit 2: nothing escapes where the map said Unverified", p2.summary.escapedWhereMapSaidUnverified, e.commit2.escapedWhereMapSaidUnverified);
  check("known miss is reported, not hidden: a fault escapes where the map said Supported", [p1.summary.escapedWhereMapSaidSupported, p2.summary.escapedWhereMapSaidSupported], [e.commit1.escapedWhereMapSaidSupported, e.commit2.escapedWhereMapSaidSupported]);
  check("the planted-fault record is for the commits under review", [p1.sha, p2.sha], [c1, c2]);
}

// ---- 8. Demo PRs -----------------------------------------------------------
group = "Demo PRs";
{
  const demo = demoRevisions();
  const pr = demo.prs.find((p) => p.id === "ju26-issue-2283");
  const files = buildModel(demo, pr.id, pr.commits[1].sha).diff.files.map((f) => f.file);
  check("made-up commit 2 lists each edited file once", [files.length, new Set(files).size], [4, 4]);
}

// ---- 9. Swarm agreement -----------------------------------------------------
group = "Swarm agreement";
{
  const similar = (prId) => buildSwarm(prId).runs.map((r) => r.similar);
  check("docs-only change: agents that edit the same doc agree", similar("docs-example"), [true, true, true, true, true]);
  // A docs-only real change, against a run that failed and one that changed nothing.
  const doc = { file: "docs/pricing.md", kind: "doc", added: 1, removed: 0, patch: "@@ -1 +1 @@\n+x", functions: [] };
  const run = (n, exitCode, files) => ({ n, exitCode, files, reply: "" });
  const dir = path.join(DATA, "shop", `eval-swarm-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "swarm.json"), JSON.stringify({ real: { files: [doc] }, models: { m: { label: "M", runs: [run(1, 1, []), run(2, 0, []), run(3, 0, [doc])] } } }));
  try {
    check("a failed run or one that changed nothing does not agree", similar(path.basename(dir)), [false, false, true]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 10. Contested claims ---------------------------------------------------
group = "Contested claims";
{
  // A passing check does not make a statement Verified when our own serious finding disputes it.
  const ledger = (id) => { const pr = ledgerPrs().find((p) => p.id === id); return buildLedgerModel(pr, pr.commits[0].sha); };
  const m = ledger("ju26-issue-2297");
  const by = (id) => { const c = m.claims.find((x) => x.id === id); return [c.label, (c.contestedBy ?? []).map((b) => b.findingId)]; };
  check("finding filed against the claim: Contested, finding linked", by("CLM-2"), ["Contested", ["F-2"]]);
  check("finding cites the lines the claim stands on: Contested", by("CLM-1"), ["Contested", ["F-2"]]);
  check("scope finding on the clause that states the fix: Contested", by("REQ-2297-1"), ["Contested", ["F-2"]]);
  check("a Minor finding alone does not contest a claim", by("CLM-4"), ["Verified", []]);
  const attack = buildModel(revisions, "req-21", revisions.prs.find((p) => p.id === "req-21").commits[0].sha);
  check("shop sample: Action required finding on the edited lines contests the author's claim", attack.claims.find((c) => c.id === "c1").label, "Contested");
}

// ---- 11. PR comment -----------------------------------------------------------
group = "PR comment";
{
  // req-17 commit 1, as the first screen shows it: proof for Order Import is missing.
  const m = buildModel(revisions, "req-17", c1);
  const points = [
    ...m.review.findings.map((f) => ({ level: f.category === "Minor" ? "minor" : "major", title: f.title })),
    ...m.classifier2.blockers.map((b) => ({ level: "block", title: b.text })),
  ];
  const url = "http://localhost:4317/#pr=req-17";
  const lines = prComment({ model: m, verdict: "Cannot merge yet", score: 0, points, notRun: [], url }).trimEnd().split("\n");
  const at = (start) => lines.findIndex((l) => l.startsWith(start));
  check("req-17 commit 1: verdict and score lead", lines[0], "### Impact Map review: Cannot merge yet (0 / 100)");
  check("req-17 commit 1: route says it waits for proof", lines[1].startsWith(`**Route:** ${m.classifier2.route}`) && m.classifier2.route.startsWith("Waiting"), true);
  check("req-17 commit 1: the missing Order Import proof is the first open point", /^- \*\*Blocker:\*\* .*importOrder\(\)/.test(lines[at("**Open points") + 1]), true);
  check("req-17 commit 1: the unverified import claim is under Not checked", lines.slice(at("**Not checked**")).some((l) => /^- Claim unverified: Order Import/.test(l)), true);
  check("req-17 commit 1: ends with the link back", lines.at(-1), `[Open in Impact Map](${url})`);
  const many = prComment({ model: m, verdict: "Look closer first", score: 50, points: Array.from({ length: 7 }, (_, i) => ({ level: "minor", title: `Point ${i}` })), url }).split("\n");
  check("open points stop at 5, then one line for the rest", [many.filter((l) => /^- Minor: Point/.test(l)).length, many.includes("- …and 2 more in the Impact Map")], [5, true]);
}

// ---- 12. Verdict sentence ------------------------------------------------------
group = "Verdict sentence";
{
  // The first screen's one sentence, from each commit's own open points (the verdict and tone come from the score).
  const demo = demoRevisions();
  const at = (rev, id, index = 1) => buildModel(rev, id, rev.prs.find((p) => p.id === id).commits[index - 1].sha);
  const say = (m, verdict, tone, extra = {}) => verdictSentence({ verdict, tone, auto: m.classifier2.route.startsWith("Auto"), points: issueList(m), checksPassed: m.checks.every((c) => c.status === "passed"), docsOnly: m.diff.files.every((f) => f.file.endsWith(".md")), ...extra });
  check("red with a blocker: the missing proof is the reason", say(at(revisions, "req-17"), "Cannot merge yet", "bad").text, "Cannot merge yet: Order Import has no test for the REQ-17 case.");
  check("amber: the first important finding is the reason", say(at(demo, "ju26-issue-2297"), "Look closer first", "warn").text, "Look closer first: the mark can break a user's build.");
  check("green and auto: says it could merge by itself, and why", say(at(revisions, "docs-example"), "Fine to merge", "ok").text, "Could merge by itself: docs only, every check passed.");
  check("no open points: says nothing is open", say(at(revisions, "req-17", 2), "Fine to merge", "ok").text, "Fine to merge: nothing is open, every check passed.");
  const m2297 = at(demo, "ju26-issue-2297");
  check("every point acknowledged: ready for a sign-off", verdictSentence({ verdict: "Look closer first", tone: "warn", points: issueList(m2297).map((x) => ({ ...x, done: true })) }).text, "Ready for your sign-off: you acknowledged all 4 points.");
  // The failing-test point is too long for one line, so the next important point that fits whole is named.
  check("signed off: says who, on which commit", verdictSentence({ verdict: "Cannot merge yet", tone: "bad", points: issueList(m2297), signedOff: { name: "Ana", step: "commit 1 · a0aa5ab" } }).text, "Merged: Ana signed off commit 1 · a0aa5ab.");
  check("a reason too long for one line gives way to one that fits", say(at(demo, "ju26-issue-2283"), "Do not merge yet", "bad").text, "Do not merge yet: the fix hides more warnings than it needs to.");
  const long = "One extra unit test passes on the old code and fails on the new code, and it also reaches the importer";
  const cut = verdictSentence({ verdict: "Do not merge yet", tone: "bad", points: [{ id: "x", level: "major", title: long }] });
  const words = cut.reason.replace(/…$/, "").split(" ");
  check("a long reason is cut to one line at a whole word", [cut.text.length <= SENTENCE_MAX, cut.text.endsWith("…"), cut.cut, words.every((w, i) => w === long.split(" ")[i] || (i === 0 && w === "one"))], [true, true, true, true]);
  check("too long, but its first clause fits: the sentence stops at the clause", say(at(revisions, "req-21"), "Look closer first", "warn").text, "Look closer first: percent above 100 no longer rejected.");
  check("a clause the next one turns around is not cut off", verdictSentence({ verdict: "Look closer first", tone: "warn", points: [{ id: "x", level: "major", title: "Validation is said to be preserved, but no test covers it on the import path at all" }] }).text.includes("preserved."), false);
  check("a cut never ends on a dangling small word", /\b(the|and|of|on|to|a)…$/.test(cut.text), false);
  check("one word longer than the line stays whole", cutAtWord("Supercalifragilistic expialidocious", 8), "Supercalifragilistic…");
  // Every commit of every PR gets one sentence that fits one line, in every verdict.
  const all = [...revisions.prs.map((p) => [revisions, p]), ...demo.prs.filter((p) => !revisions.prs.some((q) => q.id === p.id)).map((p) => [demo, p])];
  const bad = [];
  for (const [rev, p] of all) for (const c of p.commits) for (const [v, t] of [["Cannot merge yet", "bad"], ["Do not merge yet", "bad"], ["Look closer first", "warn"], ["Fine to merge", "ok"]]) {
    const s = say(buildModel(rev, p.id, c.sha), v, t);
    if (s.text.length > SENTENCE_MAX || /undefined|null|: .*: |\.\.$/.test(s.text)) bad.push(`${p.id}@${c.index} ${s.text}`);
  }
  check("every PR and commit: one plain sentence that fits one line", bad, []);
}

// ---- 13. What the AI saw ------------------------------------------------------
group = "What the AI saw";
{
  // Read back from the prompt saved with the review: the files it was given in full.
  const givenIn = (record) => [...new Set([...record.input.prompt.matchAll(/^## (?:Test s|S)ource at reviewed commit: (.+)$/gm)].map((x) => x[1]))].sort();
  const markedOnMap = (m, given) => [...new Set(m.graph.nodes.filter((n) => n.givenToReviewer === given).map((n) => n.file))].sort();
  const docsSha = revisions.prs.find((p) => p.id === "docs-example").commits[0].sha;
  for (const [label, prId, sha] of [["req-17 commit 1", "req-17", c1], ["docs-example", "docs-example", docsSha]]) {
    const m = buildModel(revisions, prId, sha);
    const record = loadReview(sha);
    check(`${label}: the saved review was made from exactly these inputs`, record.inputHash, m.reviewInput.inputHash);
    check(`${label}: files marked as seen are the files in the saved input`, [m.review.sawFiles, markedOnMap(m, true)], [givenIn(record), givenIn(record)]);
  }
  const m1 = buildModel(revisions, "req-17", c1);
  const ledgerNodes = m1.graph.nodes.filter((n) => n.file === "src/payments/ledger.ts" && ["file", "function"].includes(n.type));
  check("req-17 commit 1: a file outside the input is marked unseen, with its functions", [ledgerNodes.length > 1, ledgerNodes.every((n) => n.givenToReviewer === false)], [true, true]);
  const unmarked = (m) => m.review.sawFiles === null && m.graph.nodes.every((n) => n.givenToReviewer === undefined);
  check("no review for these inputs: nothing is marked", unmarked(buildModel(revisions, "req-17", c1, { reviewRecord: null })), true);
  check("a review made for other inputs: nothing is marked", unmarked(buildModel(revisions, "req-17", c1, { reviewRecord: { ...loadReview(c1), inputHash: "0".repeat(64) } })), true);
  const demo = demoRevisions();
  check("Tieto PRs: input not recorded here, nothing is marked", demo.prs.filter((p) => p.source === "tieto").map((p) => unmarked(buildModel(demo, p.id, p.commits[0].sha))), demo.prs.filter((p) => p.source === "tieto").map(() => true));
}

// ---- 14. Too much, too little ---------------------------------------------------
group = "Too much, too little";
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "edit-check-eval-"));
  try {
    for (const [label, prId, index] of [["req-17 commit 1", "req-17", 1], ["docs-example", "docs-example", 1]]) {
      const sha = revisions.prs.find((p) => p.id === prId).commits[index - 1].sha;
      const computed = await reviewSampleChange({ name: label, overlays: prOverlays(prId).slice(0, index) }, path.join(root, prId));
      check(`${label}: the recorded result is what the check computes`, buildModel(revisions, prId, sha).editCheck, { commit: index, ...computed });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
  check("every shop PR commit has a recorded result", revisions.prs.flatMap((p) => p.commits.filter((c) => !buildModel(revisions, p.id, c.sha).editCheck).map((c) => `${p.id}@${c.index}`)), []);
  check("no recorded result: the panel shows nothing", [editCheckSummary(null), editCheckSummary(undefined)], [null, null]);
  const demo = demoRevisions();
  check("Tieto PRs: no result, so nothing is shown", demo.prs.filter((p) => p.source === "tieto").map((p) => editCheckSummary(buildModel(demo, p.id, p.commits[0].sha).editCheck)), demo.prs.filter((p) => p.source === "tieto").map(() => null));
  const ledger = revisions.prs.find((p) => p.id === "ledger-note");
  const ledgerCheck = editCheckSummary(buildModel(revisions, ledger.id, ledger.commits[0].sha).editCheck);
  check("a passenger is named in the summary and raises a question", [ledgerCheck.tone, ledgerCheck.lines[0].includes("`src/payments/ledger.ts:12`")], ["warn", true]);
}

// ---- Report ---------------------------------------------------------------
let last = "";
for (const r of results) {
  if (r.group !== last) console.log(`\n${r.group}`);
  last = r.group;
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `\n        got:  ${JSON.stringify(r.actual)}\n        want: ${JSON.stringify(r.want)}`}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} of ${results.length} review evals passed.`);
process.exit(failed ? 1 : 0);
