// Fast-lane test. The auto-merge route is the one place where no person looks, so it is the one
// that must never let the wrong change in. Each case below takes the one change that should
// qualify (a docs-only edit, checks passed, reviewer silent) and alters exactly one thing.
// Every altered case must leave the fast lane; the unaltered one must stay in it.
//   Run with:  npm run fastlane
import { classifier1, classifier2, loadApprovedPolicy, ROUTES } from "../src/lib/classifier.mjs";
import { loadRevisions } from "../src/lib/model.mjs";

const policy = loadApprovedPolicy(loadRevisions().base.sha);

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

// Allowed on purpose, and listed so that it is a choice and not an oversight.
const KNOWN_LIMITS = [
  ["the reviewer has an open question", (c) => c.review.couldNotDecide.push({ question: "Which requirement does this tie to?" })],
];

const baselineRoute = routeOf(docsOnlyChange());
const results = ATTEMPTS.map(([name, alter]) => {
  const change = docsOnlyChange();
  alter(change);
  const route = routeOf(change);
  return { name, route, held: route !== ROUTES.AUTO };
});
const leaks = results.filter((r) => !r.held);

console.log(`Fast-lane test: ${ATTEMPTS.length} ways to get the wrong change auto-merged\n`);
for (const r of results) console.log(`  ${r.held ? "held  " : "LEAK  "} ${r.name.padEnd(48)} -> ${r.route}`);
for (const [name, alter] of KNOWN_LIMITS) {
  const change = docsOnlyChange();
  alter(change);
  console.log(`  ${routeOf(change) === ROUTES.AUTO ? "allowed" : "held  "} ${name.padEnd(47)} -> ${routeOf(change)}  (known limit)`);
}
console.log(`\n  ${baselineRoute === ROUTES.AUTO ? "ok    " : "BROKEN"} ${"the plain docs-only change".padEnd(48)} -> ${baselineRoute}`);
console.log(`\n${results.length - leaks.length} of ${results.length} held. ${leaks.length} got through.`);
if (baselineRoute !== ROUTES.AUTO) console.log("The fast lane no longer accepts the change it exists for.");
process.exit(leaks.length || baselineRoute !== ROUTES.AUTO ? 1 : 0);
