// Review evals. They test whether the system finds the right path, cites the
// right evidence and takes the expected route. (Rounding itself is tested by
// the sample's own tests.)   Run with:  npm run evals
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileAt } from "../src/lib/git.mjs";
import { buildModel, loadBrief, loadRevisions } from "../src/lib/model.mjs";
import { loadRun } from "../src/lib/runner.mjs";
import { decisionView, recordDecision } from "../src/lib/decisions.mjs";
import { findPr, prSummary } from "../src/lib/github.mjs";
import { ledgerSource } from "../src/lib/ledger.mjs";
import { DATA } from "../src/lib/paths.mjs";
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
  const c = buildModel(revisions, "req-17", c1, { brief: briefC });
  check("invalid citation (line out of range): not shown as Verified", claimOf(c, "c1"), e.invalidCitation.claimLabel);
  check("invalid citation (missing file): not shown as Verified", claimOf(c, "c3"), e.invalidCitation.claimLabel);
  check("invalid citation (test exists only at a later commit): not shown as Verified", claimOf(c, "c2"), e.invalidCitation.claimLabel);

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

  const ledger = buildModel(revisions, "ledger-note", sha("ledger-note"));
  check("trivial edit to a sensitive module: severity and route", [ledger.classifier2.severity, ledger.classifier2.route], [p["ledger-note"].finalSeverity, p["ledger-note"].route]);
  check("trivial edit to a sensitive module: only 1 function edited, 0 downstream", [ledger.impact.edited.length, ledger.impact.downstream.length], [1, 0]);

  const self = buildModel(revisions, "policy-self-patch", sha("policy-self-patch"));
  check("policy self-patch: severity and route", [self.classifier2.severity, self.classifier2.route], [p["policy-self-patch"].finalSeverity, p["policy-self-patch"].route]);
  check("policy self-patch: rules come from the base commit", [self.policy.revision, self.policy.rules.critical_paths], [baseSha, ["src/payments/**"]]);
  check("policy self-patch: the PR's own policy edit is detected and not applied", [self.policy.changedInThisPr, self.classifier2.autoMergeDryRun], [true, false]);
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

// ---- 8. Real Tieto PRs (recorded packs) -----------------------------------
group = "Real Tieto PRs (recorded packs)";
{
  const e = expected.tietoRecorded;
  const TIETO = "te-industry-tech-office/junction26-messagepack-csharp";
  const pr = findPr(revisions, TIETO, 1);
  check("PR #1 of the Tieto repo resolves to the recorded pack, not to the shop PR #1", [pr?.id, pr?.source], ["ju26-issue-2283", "ledger"]);
  check("an unknown repo or PR resolves to nothing (no borrowed analysis)", [findPr(revisions, "someone/else", 1), findPr(revisions, TIETO, 99)], [null, null]);
  const [s1, s2] = pr.commits.map((c) => c.sha);
  const a = buildModel(revisions, pr.id, s1);
  const b = buildModel(revisions, pr.id, s2);
  check("#2283 as submitted: green suite, severity and route", [checkOf(a, "head-full"), a.classifier2.severity, a.classifier2.route], ["passed", e["2283"].asSubmitted.severity, e["2283"].asSubmitted.route]);
  check("#2283 as submitted: waits on the requirement row the reviewer refused, with a named check", [a.classifier2.blockers.some((x) => x.rowId === e["2283"].asSubmitted.waitingOn && Boolean(x.suggestedCheck))], [true]);
  check("#2283 after targeted checks: severity raised, route to a human", [b.classifier2.severity, b.classifier2.route, b.classifier2.notes.length > 0], [e["2283"].afterTargetedChecks.severity, e["2283"].afterTargetedChecks.route, true]);
  check("#2283 after targeted checks: contradicted rows", b.rows.filter((r) => r.state === "contradicted").map((r) => r.id).sort(), e["2283"].afterTargetedChecks.contradicted);
  const rch = b.rows.find((r) => r.id === "RCH-26");
  check("RCH-26 is outside the diff and its contradicting check passed on base and failed on head", [rch.inDiff, rch.checks.some((c) => c.base === "Passed" && c.head === "Failed")], [false, true]);
  const node = b.graph.nodes.find((n) => n.id === rch.member && n.level === "function");
  check("the map marks that member as contradicted, and it was not contradicted as submitted", [node?.evidence, a.graph.nodes.find((n) => n.id === rch.member && n.level === "function")?.evidence !== "contradicted"], ["contradicted", true]);
  const src = ledgerSource(pr.id, rch.location.file);
  check("RCH-26 links to real code at the head commit", /reportDiagnostic/.test((src.text ?? "").split("\n")[rch.location.line - 1] ?? ""), true);
  check("both steps share one commit and are labelled as new evidence, not a new commit", [a.selected.commitSha === b.selected.commitSha, b.selected.sameCommit], [true, true]);
  check("the pack is labelled as recorded output of another tool", [a.provenance.producedBy, Boolean(a.provenance.packSha256)], ["Impact Ledger", true]);
  const p3 = findPr(revisions, TIETO, 3);
  check("#2129 touches a sensitive path: High", buildModel(revisions, p3.id, p3.commits[0].sha).classifier2.severity, e["2129"].severity);

  // Decisions and the GitHub summary on a recorded PR.
  const file = path.join(os.tmpdir(), `impact-map-eval-ledger-${process.pid}.json`);
  fs.rmSync(file, { force: true });
  const early = recordDecision(a, { name: "Eval Engineer", action: "sign-off", residualRisk: "none" }, file);
  check("sign-off while waiting for evidence is rejected", early.ok, false);
  const late = recordDecision(b, { name: "Eval Engineer", action: "sign-off", residualRisk: "the dropped diagnostic, pending the owner's decision" }, file);
  check("a decision at the later step is recorded for that step only", [late.ok, decisionView(a, file).signedOff, decisionView(b, file).signedOff], [true, false, true]);
  const sum = prSummary(revisions, pr, file);
  check("GitHub summary: two review steps on the one real commit, latest signed", [sum.commits.length, new Set(sum.commits.map((c) => c.sha)).size, sum.commits[0].status, sum.commits[1].status], [2, 1, "pending", "success"]);
  fs.rmSync(file, { force: true });
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
