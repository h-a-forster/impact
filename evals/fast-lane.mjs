// Fast-lane test. The auto-merge route is the one place where no person looks, so it is the one
// that must never let the wrong change in. Each case below takes the one change that should
// qualify (a docs-only edit, checks passed, reviewer silent) and alters exactly one thing.
// Every altered case must leave the fast lane; the unaltered one must stay in it.
// A second group breaks the AI reviewer itself (missing, stale, empty, cut off) and sends the
// sample's docs-only pull request through the whole pipeline: a broken reviewer must never
// count as a silent one.
//   Run with:  npm run fastlane
import { classifier1, classifier2, loadApprovedPolicy, ROUTES } from "../src/lib/classifier.mjs";
import { buildModel, loadRevisions } from "../src/lib/model.mjs";
import { loadReview } from "../src/lib/reviewer.mjs";

const revisions = loadRevisions();
const policy = loadApprovedPolicy(revisions.base.sha);

const docsOnlyChange = () => ({
  files: ["docs/pricing.md"],
  sharedEdits: [],
  rollbackRecorded: true,
  checks: [{ name: "unit-tests", status: "passed" }],
  evidence: [],
  review: { available: true, findings: [], couldNotDecide: [] },
});

function routeOf(change) {
  const changedFiles = change.files.map((file) => ({ file }));
  const initial = classifier1(policy, { changedFiles, editedCount: 0, downstreamCount: 0, sharedEdits: change.sharedEdits, workflowsReached: [], rollbackRecorded: change.rollbackRecorded });
  return classifier2(policy, { initial, checks: change.checks, evidence: change.evidence, review: change.review, changedFiles }).route;
}

const finding = (category, citationsValid = true) => ({ category, citationsValid });
const ATTEMPTS = [
  // Something else rides along with the docs edit.
  ["a code file rides along", (c) => c.files.push("src/pricing/discount.ts")],
  ["a payments file rides along", (c) => c.files.push("src/payments/ledger.ts")],
  ["the review policy rides along", (c) => c.files.push("review-policy.yml")],
  ["the reviewer's instructions ride along", (c) => c.files.push("REVIEW.md")],
  ["a CI workflow rides along", (c) => c.files.push(".github/workflows/ci.yml")],
  ["the package manifest rides along", (c) => c.files.push("package.json")],
  // It is not really a document.
  ["code placed inside the docs folder", (c) => (c.files = ["docs/helper.ts"])],
  ["a script placed inside the docs folder", (c) => (c.files = ["docs/build.sh"])],
  ["code moved into the docs folder", (c) => (c.files = ["src/pricing/discount.ts", "docs/discount.ts"])],
  ["a path that climbs out of the docs folder", (c) => (c.files = ["docs/../src/pricing/discount.ts"])],
  ["a folder that only looks like docs (src/docs)", (c) => (c.files = ["src/docs/notes.md"])],
  ["a folder that only looks like docs (docs2)", (c) => (c.files = ["docs2/notes.md"])],
  ["no files at all", (c) => (c.files = [])],
  // The evidence is not there.
  ["the required check failed", (c) => (c.checks[0].status = "failed")],
  ["the check result is for another commit", (c) => (c.checks[0].status = "stale")],
  ["the check has no result", (c) => (c.checks[0].status = "missing")],
  ["the check is still running", (c) => (c.checks[0].status = "pending")],
  ["no check ran at all", (c) => (c.checks = [])],
  ["an affected part is unverified", (c) => (c.evidence = [{ status: "unverified", nodeId: "n", missing: "no test" }])],
  ["no rollback is recorded", (c) => (c.rollbackRecorded = false)],
  ["the edited thing has callers elsewhere", (c) => (c.sharedEdits = [{ label: "x()", callerConcepts: ["Checkout"] }])],
  // The reviewer is absent or not silent.
  ["the AI review is unavailable", (c) => (c.review = { available: false, findings: [] })],
  ["there is no AI review", (c) => (c.review = null)],
  ["the reviewer reports a problem", (c) => c.review.findings.push(finding("Action required"))],
  ["the reviewer reports a problem it could not cite", (c) => c.review.findings.push(finding("Action required", false))],
  ["the reviewer asks for evidence", (c) => c.review.findings.push(finding("Needs evidence"))],
];

// The reviewer itself is missing or broken. Each case alters the saved review of the docs-only pull request.
const BROKEN_REVIEWER = [
  ["no review was saved (it never ran, or had no key)", () => null],
  ["the review was made for other evidence", (r) => ({ ...r, inputHash: "0".repeat(64) })],
  ["the review was saved for another commit", (r) => ({ ...r, revision: "0".repeat(40) })],
  ["the review did not come from a model", (r) => ({ ...r, mode: "manual" })],
  ["the reviewer returned nothing", (r) => ({ ...r, parsed: {} })],
  ["the reviewer returned no summary", (r) => ({ ...r, parsed: { ...r.parsed, summary: " " } })],
  ["the saved review is cut off", (r) => ({ ...r, parsed: undefined })],
  ["the findings are not a list", (r) => ({ ...r, parsed: { ...r.parsed, findings: "none" } })],
  ["a finding of a kind the rules do not know", (r) => ({ ...r, parsed: { ...r.parsed, findings: [{ category: "Praise", title: "Nice change" }] } })],
];

const docsPr = revisions.prs.find((p) => p.id === "docs-example");
const docsSha = docsPr.commits.at(-1).sha;
/** The route of the docs-only pull request with its saved review replaced; a crash is reported, not hidden. */
function pipelineRoute(alter) {
  try {
    return buildModel(revisions, docsPr.id, docsSha, { reviewRecord: alter(structuredClone(loadReview(docsSha))) }).classifier2.route;
  } catch (error) {
    return `crashed: ${error.message}`;
  }
}

// Allowed on purpose, and listed so that it is a choice and not an oversight.
const KNOWN_LIMITS = [
  ["the reviewer has an open question", (c) => c.review.couldNotDecide.push({ question: "Which requirement does this tie to?" })],
  ["the description asks in words not to auto-merge", (c) => (c.description = "Please do not auto-merge this.")],
];

const baselineRoute = routeOf(docsOnlyChange());
const results = ATTEMPTS.map(([name, alter]) => {
  const change = docsOnlyChange();
  alter(change);
  const route = routeOf(change);
  return { name, route, held: route !== ROUTES.AUTO };
});
for (const [name, alter] of BROKEN_REVIEWER) {
  const route = pipelineRoute(alter);
  results.push({ name, route, held: route !== ROUTES.AUTO && !route.startsWith("crashed") });
}
const leaks = results.filter((r) => !r.held);
const pipelineBaseline = pipelineRoute((record) => record);

console.log(`Fast-lane test: ${results.length} ways to get the wrong change auto-merged\n`);
for (const r of results) console.log(`  ${r.held ? "held  " : "LEAK  "} ${r.name.padEnd(52)} -> ${r.route}`);
for (const [name, alter] of KNOWN_LIMITS) {
  const change = docsOnlyChange();
  alter(change);
  console.log(`  ${routeOf(change) === ROUTES.AUTO ? "allowed" : "held  "} ${name.padEnd(51)} -> ${routeOf(change)}  (known limit)`);
}
const baselines = [["the plain docs-only change", baselineRoute], ["the recorded docs-only pull request, whole pipeline", pipelineBaseline]];
console.log("");
for (const [name, route] of baselines) console.log(`  ${route === ROUTES.AUTO ? "ok    " : "BROKEN"} ${name.padEnd(52)} -> ${route}`);
console.log(`\n${results.length - leaks.length} of ${results.length} held. ${leaks.length} got through.`);
const accepts = baselines.every(([, route]) => route === ROUTES.AUTO);
if (!accepts) console.log("The fast lane no longer accepts the change it exists for.");
process.exit(leaks.length || !accepts ? 1 : 0);
