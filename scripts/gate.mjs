// Merge gate. What a merge check would ask, as one command.
//   npm run gate -- <pr id or number> [owner/name]
// Exit 0 only when the latest step of the PR is signed off by a named person for exactly that
// commit and evidence. Anything else answers MERGE BLOCKED and says why. Fails closed.
// An override (a person merging against the rules, with a reason) also exits 0: the person made
// the call, and a failing check would only push them to bypass it with no record. It says
// MERGE ALLOWED BY OVERRIDE, lists what was not proven, and warns on the check in GitHub Actions.
// (Idea from the Impact Ledger project. Nothing is ever merged by this demo.)
import { loadRevisions } from "../src/lib/model.mjs";
import { prSummary } from "../src/lib/github.mjs";

const [arg, repo] = process.argv.slice(2);
const revisions = loadRevisions();
const pr = revisions.prs.find((p) => (p.id === arg || String(p.number) === arg) && (!repo || p.repo === repo));
if (!pr) {
  console.error(`MERGE BLOCKED: unknown pull request "${arg ?? ""}". Known: ${revisions.prs.map((p) => p.id).join(", ")}`);
  process.exit(2);
}
try {
  const summary = prSummary(revisions, pr);
  const head = summary.commits[summary.commits.length - 1];
  const where = `${pr.repo} #${pr.number} at ${head.label ?? head.sha.slice(0, 7)}`;
  const override = head.signedOff?.override;
  if (override) {
    const text = `${where} was merged against the rules by ${head.signedOff.name} (${head.signedOff.at}): ${override.reason}`;
    console.log(`MERGE ALLOWED BY OVERRIDE: ${text}. Severity ${head.severity}.`);
    for (const o of override.open) console.log(`  - Not proven: ${o}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Merged against the rules::${text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
    process.exit(0);
  }
  if (head.signedOff) {
    console.log(`MERGE ALLOWED: ${where} was signed off by ${head.signedOff.name} (${head.signedOff.at}). Severity ${head.severity}. Residual risk accepted: ${head.signedOff.residualRisk}`);
    process.exit(0);
  }
  const older = summary.commits.slice(0, -1).filter((c) => c.signedOff);
  console.log(`MERGE BLOCKED: ${where}. Severity ${head.severity}. Route: ${head.route}.`);
  for (const b of head.blockers) console.log(`  - ${b.text}${b.suggestedCheck ? `\n    Check that would help: ${b.suggestedCheck}` : ""}`);
  if (!head.blockers.length) console.log(head.route.startsWith("Auto-merge") ? "  - Auto-merge eligibility is a policy dry run. This gate still needs a named sign-off." : "  - No named person has signed off on this exact commit and evidence.");
  for (const c of older) console.log(`  - An earlier step (${c.label ?? c.sha.slice(0, 7)}) was signed off by ${c.signedOff.name}. That does not carry over.`);
  process.exit(1);
} catch (err) {
  console.error(`MERGE BLOCKED: the gate could not read the review state (${err.message}).`);
  process.exit(2);
}
