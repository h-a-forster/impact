// One-time setup. Safe to re-run.
//   node scripts/setup.mjs                rebuild the sample repo; reuse saved evidence where it matches
//   node scripts/setup.mjs --fresh        re-run tests, Graphify and the edit check for every commit
//   node scripts/setup.mjs --live-review  re-run the AI review for every PR commit
import fs from "node:fs";
import path from "node:path";
import { allRevisions, buildSampleRepo, snapshot, snapshotBaseWithTestsFrom } from "../src/lib/sample.mjs";
import { graphifyAvailable, loadExport, runGraphify } from "../src/lib/graphify.mjs";
import { loadBaseRun, loadRun, runHeadTestsOnBase, runTests } from "../src/lib/runner.mjs";
import { buildModel } from "../src/lib/model.mjs";
import { loadReview, runLiveReview } from "../src/lib/reviewer.mjs";
import { DATA, REVISIONS_FILE } from "../src/lib/paths.mjs";
import { raisesQuestion, recordEditCheck } from "../src/lib/edit-check.mjs";

const fresh = process.argv.includes("--fresh");
const liveReview = process.argv.includes("--live-review");
const noReview = process.argv.includes("--no-review");
const short = (s) => s.slice(0, 7);

console.log("1/5 Building the sample Git repo (.demo/shop-sample)");
const revisions = buildSampleRepo();
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(REVISIONS_FILE)) {
  const saved = JSON.parse(fs.readFileSync(REVISIONS_FILE, "utf8"));
  const same = JSON.stringify(allRevisions(saved)) === JSON.stringify(allRevisions(revisions));
  console.log(same ? "    Commit SHAs match the saved evidence." : "    Commit SHAs changed. Saved evidence for old SHAs will not be used.");
}
fs.writeFileSync(REVISIONS_FILE, JSON.stringify(revisions, null, 2) + "\n");
console.log(`    base ${short(revisions.base.sha)}; ` + revisions.prs.map((p) => `${p.id}: ${p.commits.map((c) => short(c.sha)).join(", ")}`).join("; "));

console.log("2/5 Running tests on a clean snapshot of each commit");
const graphifyVersion = graphifyAvailable();
const snapshots = new Map();
const snap = (sha) => {
  if (!snapshots.has(sha)) snapshots.set(sha, snapshot(sha));
  return snapshots.get(sha);
};
for (const rev of allRevisions(revisions)) {
  const saved = loadRun(rev.sha);
  if (saved && !fresh) {
    console.log(`    ${short(rev.sha)} saved run reused: ${saved.status} (${saved.counts.passed}/${saved.counts.total})`);
  } else {
    const run = runTests(rev.sha, snap(rev.sha));
    console.log(`    ${short(rev.sha)} ran now: ${run.status} (${run.counts.passed}/${run.counts.total})`);
  }
}

console.log("    Before/after: each PR commit's tests against the base code");
for (const pr of revisions.prs) {
  for (const c of pr.commits) {
    const saved = loadBaseRun(c.sha);
    if (saved && !fresh) {
      console.log(`    ${short(c.sha)} saved base run reused: ${saved.counts.failed} fail on base, ${saved.counts.passed} pass on base`);
    } else {
      const r = runHeadTestsOnBase(c.sha, revisions.base.sha, snapshotBaseWithTestsFrom(revisions.base.sha, c.sha));
      console.log(`    ${short(c.sha)} ran now on base: ${r.counts.failed} fail on base, ${r.counts.passed} pass on base`);
    }
  }
}

console.log(`3/5 Code index (Graphify: ${graphifyVersion ?? "not installed - using saved exports"})`);
for (const rev of allRevisions(revisions)) {
  const saved = loadExport(rev.sha);
  if (saved && (!fresh || !graphifyVersion)) {
    console.log(`    ${short(rev.sha)} saved export reused (Graphify ${saved.graphifyVersion})`);
  } else if (graphifyVersion) {
    const rec = runGraphify(rev.sha, snap(rev.sha));
    console.log(`    ${short(rev.sha)} indexed now: ${rec.graph.nodes.length} nodes, ${rec.graph.links.length} links`);
  } else {
    console.error(`    ${short(rev.sha)} has no saved export and Graphify is not installed.\n    Install it with:  uv tool install graphifyy --python 3.12`);
    process.exit(1);
  }
}

console.log("4/5 Independent AI review per PR commit");
for (const pr of revisions.prs) {
  for (const c of pr.commits) {
    const model = buildModel(revisions, pr.id, c.sha);
    const saved = loadReview(c.sha);
    const matches = saved && saved.inputHash === model.reviewInput.inputHash;
    if (matches && !liveReview) {
      console.log(`    ${pr.id} ${short(c.sha)} saved review reused (${saved.model}); inputs match`);
      continue;
    }
    if (noReview) {
      console.log(`    ${pr.id} ${short(c.sha)} no matching saved review; skipped (--no-review). The app will show the rule-based fallback.`);
      continue;
    }
    try {
      process.stdout.write(`    ${pr.id} ${short(c.sha)} asking the model (fresh context)... `);
      const rec = runLiveReview(c.sha, model.reviewInput);
      console.log(`done: ${rec.parsed.findings?.length ?? 0} finding(s)`);
    } catch (err) {
      console.log(`FAILED: ${err.message}\n      The app will show the labelled rule-based fallback for this commit.`);
    }
  }
}

console.log("5/5 Too much, too little: each edit taken out again, tests re-run (no model)");
for (const { pr, sha, reused, review } of await recordEditCheck(revisions, { fresh })) {
  const found = !review.testsPass ? "tests fail on the change" : raisesQuestion(review) ? "raises a question" : "nothing found";
  console.log(`    ${pr} ${short(sha)} ${reused ? "saved result reused" : "checked now"}: ${found}`);
}

console.log("\nRoutes now:");
for (const pr of revisions.prs) {
  for (const c of pr.commits) {
    const m = buildModel(revisions, pr.id, c.sha);
    console.log(`    ${pr.id.padEnd(18)} ${short(c.sha)}  ${m.classifier2.severity.padEnd(6)} ${m.classifier2.route}   [review: ${m.review.mode}${m.review.available ? "" : ", unavailable"}]`);
  }
}
console.log(`\nSetup done. Data is in ${path.relative(process.cwd(), DATA) || "data"}. Start the app with:  npm start`);
