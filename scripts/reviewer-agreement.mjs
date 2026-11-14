// Does the independent AI reviewer agree with itself?
// Runs the reviewer again, fresh, on the same inputs as a recorded review and compares
// the route and the findings that matter (Action required, Needs evidence).
//   node scripts/reviewer-agreement.mjs             top up to 2 fresh runs per target, then print the table
//   node scripts/reviewer-agreement.mjs --runs 3    top up to 3 fresh runs per target
//   node scripts/reviewer-agreement.mjs --report    no new runs; print the table from saved runs
// Fresh runs are saved to data/agreement/. The recorded reviews the app replays are never touched.
import fs from "node:fs";
import path from "node:path";
import { buildModel } from "../src/lib/model.mjs";
import { askReviewer, loadReview } from "../src/lib/reviewer.mjs";
import { DATA, REVISIONS_FILE } from "../src/lib/paths.mjs";

const TARGETS = [
  { pr: "req-17", commit: 0, note: "the trap: Order Import untested" },
  { pr: "docs-example", commit: 0, note: "clean docs change" },
];
const MATTERS = ["Action required", "Needs evidence"];
const LINE_SLACK = 3; // a citation a few lines away points at the same code

const OUT = path.join(DATA, "agreement");
const args = process.argv.slice(2);
const reportOnly = args.includes("--report");
const runsWanted = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 2;
if (!Number.isInteger(runsWanted) || runsWanted < 1) throw new Error("--runs needs a positive whole number");

const revisions = JSON.parse(fs.readFileSync(REVISIONS_FILE, "utf8"));
fs.mkdirSync(OUT, { recursive: true });

const runFile = (t, sha, k) => path.join(OUT, `${t.pr}-${sha.slice(0, 7)}-run${k}.json`);

function savedRuns(t, sha) {
  const prefix = `${t.pr}-${sha.slice(0, 7)}-run`;
  return fs
    .readdirSync(OUT)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8")));
}

/** Route and the findings that matter, as the app would show them for this review record. */
function outcome(t, sha, record) {
  const m = buildModel(revisions, t.pr, sha, { reviewRecord: record });
  if (!m.review.available) throw new Error(`${t.pr} ${sha.slice(0, 7)}: review not usable (${m.review.modeLabel})`);
  return {
    route: m.classifier2.route,
    severity: m.classifier2.severity,
    findings: m.review.findings.filter((f) => MATTERS.includes(f.category)),
  };
}

const sameSpot = (a, b) => a.citations.some((x) => b.citations.some((y) => x.file === y.file && Math.abs(x.line - y.line) <= LINE_SLACK));
const matches = (a, b) => a.category === b.category && sameSpot(a, b);
const describe = (f) => `${f.category}: ${f.citations.map((c) => `${c.file}:${c.line}`).join(", ")}`;

const rows = [];
for (const t of TARGETS) {
  const sha = revisions.prs.find((p) => p.id === t.pr).commits[t.commit].sha;
  const recorded = loadReview(sha);
  if (!recorded) throw new Error(`no recorded review for ${t.pr} ${sha.slice(0, 7)}`);
  const base = outcome(t, sha, recorded);
  const input = buildModel(revisions, t.pr, sha).reviewInput;

  let runs = savedRuns(t, sha).filter((r) => r.inputHash === input.inputHash);
  while (!reportOnly && runs.length < runsWanted) {
    const k = runs.length + 1;
    process.stderr.write(`${t.pr} ${sha.slice(0, 7)} fresh run ${k}... `);
    // --setting-sources user: no project settings or hooks from the folder the reviewer runs in.
    const record = askReviewer(sha, input, ["--setting-sources", "user"]);
    fs.writeFileSync(runFile(t, sha, k), JSON.stringify(record, null, 2) + "\n");
    process.stderr.write("done\n");
    runs = savedRuns(t, sha).filter((r) => r.inputHash === input.inputHash);
  }

  rows.push({ t, sha, label: "recorded", ranAt: recorded.ranAt, ...base, sameRoute: true, kept: "-", extra: [], exact: true });
  for (const r of runs) {
    const o = outcome(t, sha, r);
    const kept = base.findings.filter((f) => o.findings.some((g) => matches(f, g)));
    const extra = o.findings.filter((g) => !base.findings.some((f) => matches(f, g)));
    rows.push({ t, sha, label: "fresh", ranAt: r.ranAt, ...o, sameRoute: o.route === base.route, kept: `${kept.length} of ${base.findings.length}`, extra, exact: o.route === base.route && kept.length === base.findings.length && extra.length === 0 });
  }
}

console.log("| PR | Review | Ran at (UTC) | Route | Same route | Recorded findings found again | Findings that matter | New findings |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const found = r.findings.map(describe).join("<br>") || "none";
  const extra = r.extra.map(describe).join("<br>") || "none";
  console.log(`| ${r.t.pr} ${r.sha.slice(0, 7)} | ${r.label} | ${r.ranAt.slice(0, 16).replace("T", " ")} | ${r.route} | ${r.sameRoute ? "yes" : "NO"} | ${r.kept} | ${found} | ${r.label === "recorded" ? "-" : extra} |`);
}
const fresh = rows.filter((r) => r.label === "fresh");
console.log(`\n${fresh.length} fresh run(s); ${fresh.filter((r) => r.sameRoute).length} gave the recorded route; ${fresh.filter((r) => r.exact).length} matched the recorded route and findings exactly.`);
