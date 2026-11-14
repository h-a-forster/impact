// Fast-lane test. The auto-merge route is the one place where no person looks, so it is the one
// that must never let the wrong change in. Each case below takes the one change that should
// qualify (a docs-only edit, checks passed, reviewer silent) and alters exactly one thing.
// Every altered case must leave the fast lane; the unaltered one must stay in it.
// A second group breaks the AI reviewer itself (missing, stale, empty, cut off) and sends the
// sample's docs-only pull request through the whole pipeline: a broken reviewer must never
// count as a silent one. A third group goes through git itself: a link, a submodule pointer, an
// executable or a binary file can all be named notes.md.
//   Run with:  npm run fastlane
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifier1, classifier2, loadApprovedPolicy, ROUTES } from "../src/lib/classifier.mjs";
import { changedFiles as gitChangedFiles } from "../src/lib/git.mjs";
import { buildModel, loadBrief, loadRevisions } from "../src/lib/model.mjs";
import { loadReview } from "../src/lib/reviewer.mjs";

const revisions = loadRevisions();
const policy = loadApprovedPolicy(revisions.base.sha);

const docsOnlyChange = () => ({
  files: ["docs/pricing.md"],
  oddity: null, // what the diff says about the files: null means ordinary text files
  sharedEdits: [],
  rollbackRecorded: true,
  checks: [{ name: "unit-tests", status: "passed" }],
  evidence: [],
  review: { available: true, findings: [], couldNotDecide: [] },
});

function routeOf(change) {
  const changedFiles = change.changedFiles ?? change.files.map((file) => ({ file, oddity: change.oddity }));
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
  ["tests that always pass, in a folder not named like tests", (c) => c.files.push("src/backend/websocket/checks.mjs")],
  ["a test runner config that skips a folder rides along", (c) => c.files.push("vitest.config.ts")],
  ["a test project file that drops test files rides along", (c) => c.files.push("tests/Pricing.Tests.csproj")],
  // It is not really a document.
  ["code placed inside the docs folder", (c) => (c.files = ["docs/helper.ts"])],
  ["a script placed inside the docs folder", (c) => (c.files = ["docs/build.sh"])],
  ["code moved into the docs folder", (c) => (c.files = ["src/pricing/discount.ts", "docs/discount.ts"])],
  ["a path that climbs out of the docs folder", (c) => (c.files = ["docs/../src/pricing/discount.ts"])],
  ["a folder that only looks like docs (src/docs)", (c) => (c.files = ["src/docs/notes.md"])],
  ["a folder that only looks like docs (docs2)", (c) => (c.files = ["docs2/notes.md"])],
  ["no files at all", (c) => (c.files = [])],
  ["a build file with a text extension", (c) => (c.files = ["docs/requirements.txt"])],
  ["a build script named like a text file", (c) => (c.files = ["docs/CMakeLists.txt"])],
  ["a hidden file", (c) => (c.files = ["docs/.hidden.md"])],
  ["a test hook file placed inside the docs folder", (c) => (c.files = ["docs/conftest.py"])],
  ["only deletions: a test file marked deleted", (c) => (c.changedFiles = [{ status: "D", file: "tests/pricing.test.mjs", oddity: null }])],
  ["a workflow folder inside the docs folder", (c) => (c.files = ["docs/.github/workflows/x.md"])],
  ["a name with two extensions", (c) => (c.files = ["docs/x.php.md"])],
  ["the diff says a file is not an ordinary file", (c) => (c.oddity = "a link, not a file")],
  ["nothing says what kind of file it is", (c) => (c.oddity = undefined)],
  // The evidence is not there.
  ["the required check failed", (c) => (c.checks[0].status = "failed")],
  ["the check result is for another commit", (c) => (c.checks[0].status = "stale")],
  ["the check has no result", (c) => (c.checks[0].status = "missing")],
  ["the check is still running", (c) => (c.checks[0].status = "pending")],
  ["no check ran at all", (c) => (c.checks = [])],
  ["a check passed, but not the required one", (c) => (c.checks = [{ name: "lint", status: "passed" }])],
  ["an affected part is contradicted", (c) => (c.evidence = [{ status: "contradicted", nodeId: "n", missing: "a test fails" }])],
  ["an affected part is unverified", (c) => (c.evidence = [{ status: "unverified", nodeId: "n", missing: "no test" }])],
  ["no rollback is recorded", (c) => (c.rollbackRecorded = false)],
  ["the edited thing has callers elsewhere", (c) => (c.sharedEdits = [{ label: "x()", callerConcepts: ["Checkout"] }])],
  // The reviewer is absent or not silent.
  ["the AI review is unavailable", (c) => (c.review = { available: false, findings: [] })],
  ["there is no AI review", (c) => (c.review = null)],
  ["the review is marked available with a word, not a fact", (c) => (c.review.available = "false")],
  ["the review has no list of findings", (c) => (c.review.findings = null)],
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
  ["a finding that is empty", (r) => ({ ...r, parsed: { ...r.parsed, findings: [null] } })],
  ["the review has no date", (r) => ({ ...r, ranAt: undefined })],
  ["the summary is a filler word", (r) => ({ ...r, parsed: { ...r.parsed, summary: "TODO" } })],
  ["the rollback field is blank", (r) => r, (brief) => ({ ...brief, rollback: " " })],
  ["the rollback field says none", (r) => r, (brief) => ({ ...brief, rollback: "none" })],
  ["the rollback field says None.", (r) => r, (brief) => ({ ...brief, rollback: "None." })],
  ["the rollback field says n/a.", (r) => r, (brief) => ({ ...brief, rollback: "n/a." })],
  ["the rollback field says N/A", (r) => r, (brief) => ({ ...brief, rollback: "N/A" })],
  ["the rollback field says nothing", (r) => r, (brief) => ({ ...brief, rollback: "nothing" })],
  ["the rollback field is a dash", (r) => r, (brief) => ({ ...brief, rollback: "-" })],
];

const docsPr = revisions.prs.find((p) => p.id === "docs-example");
const docsSha = docsPr.commits.at(-1).sha;
/**
 * The route of the docs-only pull request with its saved review, or its brief, replaced.
 * A changed brief gets a review made for that brief, so only the brief is at fault. A crash is reported, not hidden.
 */
function pipelineRoute(alterReview, alterBrief) {
  try {
    const record = alterReview(structuredClone(loadReview(docsSha)));
    if (!alterBrief) return buildModel(revisions, docsPr.id, docsSha, { reviewRecord: record }).classifier2.route;
    const brief = alterBrief(loadBrief(docsPr.id));
    const inputHash = buildModel(revisions, docsPr.id, docsSha, { brief, reviewRecord: null }).reviewInput.inputHash;
    return buildModel(revisions, docsPr.id, docsSha, { brief, reviewRecord: { ...record, inputHash } }).classifier2.route;
  } catch (error) {
    return `crashed: ${error.message}`;
  }
}

// Through git itself: a throwaway repository built with plumbing commands, so links and file modes work on every system.
// add(null, null, file) deletes the file.
const DOCTEST_CONFIG = "[pytest]\naddopts = --doctest-glob=\"*.md\"\n";
const READS_NOTES = "import { readFileSync } from \"node:fs\";\nexport const notes = readFileSync(new URL(\"../docs/notes.md\", import.meta.url), \"utf8\");\n";
const THROUGH_GIT = [
  ["a link to a code file, named like a document", (add) => add("120000", "../src/payments/ledger.ts", "docs/link.md")],
  ["a link to a secrets file, named like a document", (add) => add("120000", "../../.env", "docs/env.md")],
  ["a document made executable", (add, text) => add("100755", text, "docs/notes.md")],
  ["a document turned into a link", (add) => add("120000", "../src/payments/ledger.ts", "docs/notes.md")],
  ["a submodule pointer, named like a document", (add) => add("160000", null, "docs/sub.md")],
  ["binary content in a file named like a document", (add) => add("100644", Buffer.from([0, 1, 2, 0, 255, 0]), "docs/data.md")],
  ["a document larger than 1 MB", (add) => add("100644", "word ".repeat(250_000), "docs/big.md")],
  ["a document with a script in it", (add) => add("100644", "# Notes\n\n<script>fetch('/collect')</script>\n", "docs/page.md")],
  ["a document with an image that runs code on error", (add) => add("100644", "# Notes\n\n<img src=x onerror=\"fetch('/collect')\">\n", "docs/page.md")],
  ["a document with a drawing that runs code on load", (add) => add("100644", "# Notes\n\n<svg onload=\"fetch('/collect')\"></svg>\n", "docs/page.md")],
  ["a document that links a stylesheet", (add) => add("100644", "# Notes\n\n<link rel=\"stylesheet\" href=\"https://example.invalid/x.css\">\n", "docs/page.md")],
  ["a document that redirects the page", (add) => add("100644", "# Notes\n\n<meta http-equiv=\"refresh\" content=\"0; url=https://example.invalid\">\n", "docs/page.md")],
  ["a document that changes where links point", (add) => add("100644", "# Notes\n\n<base href=\"https://example.invalid/\">\n", "docs/page.md")],
  ["a document with a form that sends data", (add) => add("100644", "# Notes\n\n<form action=\"https://example.invalid\"><input name=card></form>\n", "docs/page.md")],
  // The third entry sets up the base: code that reads the document at run time, so editing the document changes prices.
  [
    "a document that the code reads its prices from",
    (add) => add("100644", "# Notes\n\n| Maximum discount | 120% |\n", "docs/notes.md"),
    (add) => add("100644", READS_NOTES, "src/limits.ts"),
  ],
  // Tests dropped from the build, next to a document edit.
  [
    "a test script that skips files, beside a document edit",
    (add, text) => (add("100644", `${text}One more sentence.\n`, "docs/notes.md"), add("100644", "{ \"scripts\": { \"test\": \"node --test --test-skip-pattern=pricing\" } }\n", "package.json")),
    (add) => add("100644", "{ \"scripts\": { \"test\": \"node --test\" } }\n", "package.json"),
  ],
  [
    "a test project file that removes test files, beside a document edit",
    (add, text) => (add("100644", `${text}One more sentence.\n`, "docs/notes.md"), add("100644", "<Project><ItemGroup><Compile Remove=\"Pricing/**\" /></ItemGroup></Project>\n", "tests/Tests.csproj")),
    (add) => add("100644", "<Project><ItemGroup><Compile Include=\"**/*.cs\" /></ItemGroup></Project>\n", "tests/Tests.csproj"),
  ],
  // Only deletions: nothing is added, so there is nothing new to object to.
  ["only deletions: a check removed from the code", (add) => add("100644", "export const limit = (d) => d;\n", "src/limits.ts"), (add) => add("100644", "export const limit = (d) => {\n  if (d > 1) throw new Error(\"discount over 100%\");\n  return d;\n};\n", "src/limits.ts")],
  ["only deletions: a test file removed", (add) => add(null, null, "tests/limits.test.mjs"), (add) => add("100644", "import test from \"node:test\";\ntest(\"discount stays under 100%\", () => {});\n", "tests/limits.test.mjs")],
  ["only deletions: a document the code reads, removed", (add) => add(null, null, "docs/notes.md"), (add) => add("100644", READS_NOTES, "src/limits.ts")],
  [
    "only deletions: an example the test runner runs, removed from a document",
    (add, text) => add("100644", text, "docs/notes.md"),
    (add, text) => (add("100644", `${text}\n>>> 1 + 1\n2\n`, "docs/notes.md"), add("100644", DOCTEST_CONFIG, "pytest.ini")),
  ],
];
const PLAIN_EDIT = (add, text) => add("100644", `${text}One more sentence.\n`, "docs/notes.md");

function throughGit(cases) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fastlane-"));
  const identity = { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (args, extra = {}) => execFileSync("git", args, { cwd: repo, input: extra.input, env: { ...process.env, ...identity, ...extra.env }, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  try {
    git(["init", "--quiet", "--bare", "."]);
    const text = "# Notes\n\nA sentence.\n";
    const commit = (edit, parent) => {
      const env = { GIT_INDEX_FILE: path.join(repo, `index-${Math.random().toString(16).slice(2)}`) };
      if (parent) git(["read-tree", parent], { env });
      edit((mode, content, file) => {
        if (mode === null) return git(["update-index", "--index-info"], { env, input: `0 ${"0".repeat(40)}\t${file}\n` });
        const object = mode === "160000" ? "1".repeat(40) : git(["hash-object", "-w", "--stdin"], { input: content });
        git(["update-index", "--add", "--cacheinfo", `${mode},${object},${file}`], { env });
      }, text);
      return git(["commit-tree", git(["write-tree"], { env }), ...(parent ? ["-p", parent] : []), "-m", "change"]);
    };
    const base = commit((add) => add("100644", text, "docs/notes.md"));
    return cases.map(([name, edit, setUpBase]) => {
      const before = setUpBase ? commit(setUpBase, base) : base;
      const head = commit(edit, before);
      return [name, routeOf({ ...docsOnlyChange(), changedFiles: gitChangedFiles(before, head, { cwd: repo }) })];
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
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
for (const [name, alterReview, alterBrief] of BROKEN_REVIEWER) {
  const route = pipelineRoute(alterReview, alterBrief);
  results.push({ name, route, held: route !== ROUTES.AUTO && !route.startsWith("crashed") });
}
const [[, gitBaseline], ...gitRoutes] = throughGit([["a plain edit to a document", PLAIN_EDIT], ...THROUGH_GIT]);
for (const [name, route] of gitRoutes) results.push({ name, route, held: route !== ROUTES.AUTO });
const leaks = results.filter((r) => !r.held);
const pipelineBaseline = pipelineRoute((record) => record);

console.log(`Fast-lane test: ${results.length} ways to get the wrong change auto-merged\n`);
for (const r of results) console.log(`  ${r.held ? "held  " : "LEAK  "} ${r.name.padEnd(52)} -> ${r.route}`);
for (const [name, alter] of KNOWN_LIMITS) {
  const change = docsOnlyChange();
  alter(change);
  console.log(`  ${routeOf(change) === ROUTES.AUTO ? "allowed" : "held  "} ${name.padEnd(51)} -> ${routeOf(change)}  (known limit)`);
}
const baselines = [["the plain docs-only change", baselineRoute], ["the recorded docs-only pull request, whole pipeline", pipelineBaseline], ["a plain edit to a document, through git", gitBaseline]];
console.log("");
for (const [name, route] of baselines) console.log(`  ${route === ROUTES.AUTO ? "ok    " : "BROKEN"} ${name.padEnd(52)} -> ${route}`);
console.log(`\n${results.length - leaks.length} of ${results.length} held. ${leaks.length} got through.`);
const accepts = baselines.every(([, route]) => route === ROUTES.AUTO);
if (!accepts) console.log("The fast lane no longer accepts the change it exists for.");
process.exit(leaks.length || !accepts ? 1 : 0);
