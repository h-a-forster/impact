// Brake test. The AI reviewer can stop a merge, never start one.
// Every PR commit in the demo data gets every kind of reviewer output: silent, each finding
// category with real and made-up citations, broken or cut-off answers, a missing review, and
// reviews made for other inputs. For each one:
//   - the route is never lighter than with a silent reviewer. Route weight, from classifier2:
//     Auto-merge (no person) < Human review (a named engineer) < Waiting (checks or evidence
//     first, then a named engineer);
//   - severity never drops below Classifier 1's, and Classifier 1 does not depend on the review;
//   - a review with any finding never takes the auto-merge route.
// Silence is one of the conditions for the fast lane, not enough on its own: with a silent
// reviewer, taking away any one of the rules' conditions (Low severity, checks passed, evidence
// in, files on the allowlist) keeps the change off the auto-merge route.
//   Run with:  npm run brake
import { classifier2, loadApprovedPolicy, ROUTES } from "../src/lib/classifier.mjs";
import { buildModel, demoRevisions, loadRevisions } from "../src/lib/model.mjs";

const WEIGHT = { [ROUTES.AUTO]: 0, [ROUTES.HUMAN]: 1, [ROUTES.WAITING]: 2 };
const SEVERITY = { Low: 1, Medium: 2, High: 3 };
// An unknown route or severity counts as lighter than anything, so it fails the test.
const weight = (route) => WEIGHT[route] ?? -1;
const severity = (s) => SEVERITY[s] ?? 0;

const failures = [];
let checked = 0;
function expect(ok, where) {
  checked++;
  if (!ok) failures.push(where);
}

// ---- Whole pipeline: saved reviewer records, read back as the app reads them (shop sample) ----
const SUMMARY = "Nothing material found in this change after reading the diff and tests.";
const FAKE_FILE = "src/does/not/exist.ts";
// citation(real) gives a real file and line at the commit.
const CITATIONS = [
  ["a real line", (real) => [real]],
  ["a made-up file", () => [{ file: FAKE_FILE, line: 3 }]],
  ["a line past the end", (real) => [{ file: real.file, line: 99999 }]],
  ["a line that is not a number", (real) => [{ file: real.file, line: "<img src=x>" }]],
  ["no citation", () => []],
];
const CATEGORIES = ["Action required", "Needs evidence", "Pre-existing", "Important", "Minor", "Praise", undefined];
const finding = (category, citations) => ({ category, title: "A point", detail: "Why it matters.", citations, suggestedCheck: null });
const withParsed = (r, parsed) => ({ ...r, parsed: { ...r.parsed, ...parsed } });

/** Every kind of record the reviewer could leave on disk, built from a silent one made for exactly these inputs. */
function recordKinds(silent, real, otherInputHash) {
  const kinds = [
    ["silent", silent],
    ["silent, with an open question", withParsed(silent, { couldNotDecide: [{ question: "Which requirement?", checkThatWouldHelp: "Link it." }] })],
  ];
  for (const category of CATEGORIES) {
    for (const [where, cite] of CITATIONS) kinds.push([`one ${category ?? "uncategorised"} finding citing ${where}`, withParsed(silent, { findings: [finding(category, cite(real))] })]);
  }
  kinds.push(
    ["several findings of every category", withParsed(silent, { findings: CATEGORIES.map((c) => finding(c, [real])) })],
    ["no review saved", null],
    ["a review made for other inputs", { ...silent, inputHash: "0".repeat(64) }],
    ["a review made for another commit's inputs", { ...silent, inputHash: otherInputHash }],
    ["a review saved for another commit", { ...silent, revision: "0".repeat(40) }],
    ["a review not made by a model", { ...silent, mode: "manual" }],
    ["a review with no mode", { ...silent, mode: undefined }],
    ["a review with no model name", { ...silent, model: undefined }],
    ["a review with no date", { ...silent, ranAt: undefined }],
    ["an unparseable answer", { ...silent, rawResponse: "Sure! {not json", parsed: undefined }],
    ["an answer that is a string", { ...silent, parsed: "LGTM" }],
    ["an empty answer", { ...silent, parsed: {} }],
    ["an empty summary", withParsed(silent, { summary: "" })],
    ["a blank summary", withParsed(silent, { summary: "   " })],
    ["a filler summary", withParsed(silent, { summary: "LGTM" })],
    ["no summary", withParsed(silent, { summary: undefined })],
    ["findings that are not a list", withParsed(silent, { findings: "none" })],
    ["findings missing", withParsed(silent, { findings: undefined })],
    ["a finding that is empty", withParsed(silent, { findings: [null] })],
    ["a finding that is a string", withParsed(silent, { findings: ["looks fine"] })],
    ["open questions that are not a list", withParsed(silent, { couldNotDecide: "none" })],
    ["a record that is a string", "approved"],
    ["a record that is a list", []],
    ["an empty record", {}],
  );
  return kinds;
}

const shop = loadRevisions();
const shopCommits = shop.prs.flatMap((pr) => pr.commits.map((c) => ({ pr, sha: c.sha, index: c.index })));
const inputHashOf = (c) => buildModel(shop, c.pr.id, c.sha, { reviewRecord: null }).reviewInput.inputHash;
const isDocument = (file) => file.endsWith(".md");
let pipelineRuns = 0;
let pipelineKinds = 0;
for (const [i, c] of shopCommits.entries()) {
  const at = `${c.pr.id}@${c.index}`;
  const silentRecord = { revision: c.sha, mode: "llm", model: "test-model", ranAt: "2026-11-15T00:00:00Z", inputHash: inputHashOf(c), parsed: { summary: SUMMARY, findings: [], couldNotDecide: [] } };
  const silent = buildModel(shop, c.pr.id, c.sha, { reviewRecord: silentRecord });
  expect(silent.review.available && silent.review.findings.length === 0, `${at}: the silent record is read as an available, silent review`);
  // A code change with a silent reviewer is never auto-merge under the approved policy.
  if (silent.diff.files.some((f) => !isDocument(f.file))) expect(silent.classifier2.route !== ROUTES.AUTO, `${at}: a code change with a silent reviewer took the auto-merge route`);
  const real = { file: silent.diff.files.find((f) => f.status !== "D")?.file ?? silent.diff.files[0].file, line: 1 };
  const kinds = recordKinds(silentRecord, real, inputHashOf(shopCommits[(i + 1) % shopCommits.length]));
  pipelineKinds = kinds.length;
  for (const [kind, record] of kinds) {
    pipelineRuns++;
    let m;
    try {
      m = buildModel(shop, c.pr.id, c.sha, { reviewRecord: structuredClone(record) });
    } catch (error) {
      expect(false, `${at}, ${kind}: crashed (${error.message})`);
      continue;
    }
    const c2 = m.classifier2;
    expect(weight(c2.route) >= weight(silent.classifier2.route), `${at}, ${kind}: route "${c2.route}" is lighter than with a silent reviewer ("${silent.classifier2.route}")`);
    expect(severity(c2.severity) >= severity(m.classifier1.severity), `${at}, ${kind}: severity ${c2.severity} is below Classifier 1's ${m.classifier1.severity}`);
    expect(JSON.stringify(m.classifier1) === JSON.stringify(silent.classifier1), `${at}, ${kind}: Classifier 1 changed with the review`);
    if (m.review.findings.length) expect(c2.route !== ROUTES.AUTO, `${at}, ${kind}: a review with findings took the auto-merge route`);
  }
}

// ---- Classifier 2 on each commit's facts, shop and Tieto ----
// The Tieto routes are recorded by the Impact Ledger factory, not recomputed here, so their facts
// go through Classifier 2 directly. An open policy (every plain file allowed at Low) and a Low
// starting severity leave the reviewer as the only thing between the change and the fast lane.
const demo = demoRevisions();
const allCommits = [
  ...shopCommits.map((c) => ({ ...c, rev: shop })),
  ...demo.prs.filter((pr) => pr.source === "tieto").flatMap((pr) => pr.commits.map((c) => ({ pr, sha: c.sha, index: c.index, rev: demo }))),
];
const REVIEWS = [["silent", { available: true, findings: [], couldNotDecide: [] }], ["silent, with an open question", { available: true, findings: [], couldNotDecide: [{ question: "?" }] }]];
for (const category of CATEGORIES) for (const citationsValid of [true, false]) REVIEWS.push([`one ${category ?? "uncategorised"} finding, citations ${citationsValid ? "valid" : "invalid"}`, { available: true, findings: [{ category, citationsValid }], couldNotDecide: [] }]);
REVIEWS.push(
  ["unavailable", { available: false, findings: [], couldNotDecide: [] }],
  ["missing", null],
  ["available as a word", { available: "true", findings: [], couldNotDecide: [] }],
  ["findings not a list", { available: true, findings: null, couldNotDecide: [] }],
  ["findings a string", { available: true, findings: "none", couldNotDecide: [] }],
);
const approved = loadApprovedPolicy(shop.base.sha);
const openPolicy = (checks) => ({ ...approved, required_checks: checks.map((x) => x.name), auto_merge_dry_run: { allow: [{ severity: "Low", paths: ["**"], extensions: [""] }] } });
let classifierRuns = 0;
let fastLaneOpen = 0;
let breakers = 0;
for (const c of allCommits) {
  const at = `${c.pr.id}@${c.index}`;
  const m = buildModel(c.rev, c.pr.id, c.sha);
  // The demo's own route, as shown, never puts severity below Classifier 1's (Tieto routes are recorded or written by hand).
  expect(severity(m.classifier2.severity) >= severity(m.classifier1.severity), `${at}: shown severity ${m.classifier2.severity} is below Classifier 1's ${m.classifier1.severity}`);
  const changedFiles = m.diff.files.map((f) => ({ ...f, oddity: f.oddity === undefined ? null : f.oddity }));
  const input = { checks: m.checks, evidence: m.evidence, changedFiles, authors: [], description: "" };
  // A crash has no route and no severity, so it fails both checks.
  const route = (policy, initialSeverity, review, extra = {}) => {
    try {
      return classifier2(policy, { ...input, initial: { severity: initialSeverity }, review, ...extra });
    } catch (error) {
      return { route: `crashed: ${error.message}`, severity: null };
    }
  };
  // Three things vary: the policy (open, or the approved one), the starting severity (Classifier 1's, or Low),
  // and the facts (as recorded, or the same files with every check passed and no evidence missing).
  const cleared = { checks: m.checks.map((x) => ({ ...x, status: "passed" })), evidence: [] };
  const starts = [...new Set([m.classifier1.severity, "Low"])];
  const setups = [openPolicy(m.checks), approved].flatMap((policy) => starts.flatMap((start) => [{}, cleared].map((facts) => ({ policy, start, facts }))));
  const silent = REVIEWS[0][1];
  for (const { policy, start, facts } of setups) {
    const base = route(policy, start, silent, facts);
    if (base.route === ROUTES.AUTO) fastLaneOpen++;
    for (const [kind, review] of REVIEWS) {
      classifierRuns++;
      const out = route(policy, start, structuredClone(review), facts);
      const where = `${at}, ${policy === approved ? "approved" : "open"} policy, starts ${start}, ${facts === cleared ? "checks and evidence cleared" : "facts as recorded"}, ${kind}`;
      expect(weight(out.route) >= weight(base.route), `${where}: route "${out.route}" is lighter than with a silent reviewer ("${base.route}")`);
      expect(severity(out.severity) >= severity(start), `${where}: severity ${out.severity} is below Classifier 1's ${start}`);
      if (Array.isArray(review?.findings) && review.findings.length) expect(out.route !== ROUTES.AUTO, `${where}: a review with findings took the auto-merge route`);
    }
    // Silence alone never opens the fast lane: take away any one rule condition and it stays shut.
    if (base.route !== ROUTES.AUTO) continue;
    const without = [
      ["severity is Medium", route(policy, "Medium", silent, facts)],
      ["a required check failed", route(policy, start, silent, { ...facts, checks: m.checks.map((x) => ({ ...x, status: "failed" })) })],
      ["an affected part is unverified", route(policy, start, silent, { ...facts, evidence: [{ status: "unverified", nodeId: "n", missing: "no test" }] })],
      ["no file is on the allowlist", route({ ...policy, auto_merge_dry_run: { allow: [] } }, start, silent, facts)],
    ];
    // The open policy allows every plain file, so a code file only breaks the approved one.
    if (policy === approved) without.push(["a code file rides along", route(policy, start, silent, { ...facts, changedFiles: [...changedFiles, { file: "src/pricing/discount.ts", oddity: null }] })]);
    for (const [why, out] of without) {
      breakers++;
      expect(out.route !== ROUTES.AUTO, `${at}, silent reviewer but ${why}: took the auto-merge route`);
    }
  }
}

console.log(`Brake test: the AI reviewer can stop a merge, never start one.\n`);
console.log(`  Whole pipeline: ${shopCommits.length} shop commits x ${pipelineKinds} saved reviewer records = ${pipelineRuns} runs.`);
console.log(`  Classifier 2 on recorded facts: ${allCommits.length} commits (shop and Tieto) x policies and starting severities x ${REVIEWS.length} reviews = ${classifierRuns} runs; ${fastLaneOpen} setups were on the fast lane with a silent reviewer.`);
console.log(`  Silence alone: ${breakers} runs with a silent reviewer and one rule condition taken away.`);
for (const f of failures.slice(0, 20)) console.log(`  FAIL  ${f}`);
if (failures.length > 20) console.log(`  ...and ${failures.length - 20} more`);
console.log(`\n${checked - failures.length} of ${checked} checks passed.`);
process.exit(failures.length || fastLaneOpen === 0 ? 1 : 0);
