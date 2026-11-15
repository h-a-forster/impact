// Eval of the "too much, too little" check in src/lib/edit-check.mjs (what it does is described there).
// No model is called.
// It runs on the shop sample: its commits as written, each planted fault as one extra edit, and one
// unfinished change. The answers are known beforehand, so it is an eval of the check itself: it
// fails if a planted fault passes in silence or a clean REQ-17 commit raises a question.
//   Run with:  npm run editcheck
// It works in the system's temporary folder. It imports and calls the sample's code, so run it
// where the tests may run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeReview, raisesQuestion, reviewSampleChange } from "../src/lib/edit-check.mjs";

/** The known-answer cases on the app's shop sample: its commits as written, each planted fault as one extra edit, and one unfinished change. */
function sampleCases(app) {
  const manifest = JSON.parse(fs.readFileSync(path.join(app, "sample", "manifest.json"), "utf8"));
  const planted = JSON.parse(fs.readFileSync(path.join(app, "planted", "req-17.faults.json"), "utf8"));
  const cases = [];
  for (const pr of manifest.prs) {
    pr.commits.forEach((_, at) => {
      const overlays = pr.commits.slice(0, at + 1).map((commit) => commit.overlay);
      const commit = `${pr.id} commit ${at + 1}`;
      cases.push({ name: `${commit}, as written`, group: "as-written", overlays });
      if (pr.id !== planted.pr) return;
      for (const fault of planted.faults) cases.push({ name: `${commit} + ${fault.id} (${fault.what})`, group: `planted on commit ${at + 1}`, overlays, headFault: fault });
    });
  }
  const privateCopy = planted.faults.find((fault) => fault.id === "F5");
  const first = manifest.prs.find((pr) => pr.id === planted.pr).commits[0].overlay;
  cases.push({ name: `${planted.pr} commit 1, where Order Import already had its own copy of the old rounding`, group: "unfinished", overlays: [first], baseFault: privateCopy, headFault: privateCopy });
  return cases;
}

async function main() {
  const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const unexpected = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "too-little-too-much-"));
  const tally = {};
  try {
    for (const [index, sample] of sampleCases(path.resolve(app)).entries()) {
      const review = await reviewSampleChange(sample, path.join(root, `case-${index + 1}`));
      console.log(`\n${sample.name}`);
      if (!review) {
        console.log("  fault does not apply to this commit");
        continue;
      }
      for (const line of describeReview(review)) console.log(`  ${line}`);
      const group = (tally[sample.group] ??= { cases: 0, stoppedByTests: 0, questioned: 0 });
      group.cases++;
      if (!review.testsPass) group.stoppedByTests++;
      if (raisesQuestion(review)) group.questioned++;
      const silent = review.testsPass && !raisesQuestion(review);
      if (sample.group !== "as-written" && silent) unexpected.push(`${sample.name}: passed in silence`);
      if (sample.group === "as-written" && sample.name.startsWith("req-17") && !silent) unexpected.push(`${sample.name}: a clean commit raised a question`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log("\nSummary");
  for (const [group, count] of Object.entries(tally)) {
    console.log(`  ${group}: ${count.cases} cases; tests fail on ${count.stoppedByTests}; tests pass and this check raises a question on ${count.questioned}; passes in silence ${count.cases - count.stoppedByTests - count.questioned}`);
  }
  for (const line of unexpected) console.log(`  NOT AS EXPECTED: ${line}`);
  return unexpected.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
