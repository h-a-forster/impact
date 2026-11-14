// Writes data/shop/<pr>/blast.json for a shop sample PR from three recorded blind attempts.
//
//   node scripts/record-shop-blast.mjs --attempts <folder> [--pr req-17]
//
// <folder> holds one folder per brief (careful, normal, greedy), each with the agent's
// changes.patch and its closing reply.md. Those agents got the requirement and the shop's code
// from before the change, never the pull request. Each patch is laid on its own copy of the base
// commit under .demo/blast-shop/<pr>/<agent> (git-ignored), and the diff is read back from there.
// The real change is the PR's first commit against the base, read from the sample repo.
// This script calls no model and no network.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENTS, fileRecord } from "../src/lib/blast.mjs";
import { DATA, DEMO, REVISIONS_FILE, ROOT, SAMPLE_REPO } from "../src/lib/paths.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const prId = arg("pr", "req-17");
const attempts = arg("attempts");
if (!attempts) throw new Error("Give the folder of recorded attempts: --attempts <folder>");
// Which brief each agent column comes from: the three whose instructions are the app's Blast radius prompts.
const BRIEF = { minimal: "careful", normal: "normal", wide: "greedy" };
const PROMPTS = path.join(DATA, "tieto", "ju26-issue-2283", "blast-prompts");

const git = (cwd, ...args) => execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
const unix = (s) => s.replace(/\r\n/g, "\n");
const show = (cwd, rev, file) => {
  try {
    return unix(git(cwd, "show", `${rev}:${file}`));
  } catch {
    return null; // not there at that commit
  }
};
/** The diff of one file without its header lines, starting at the first "@@". */
const hunks = (text) => unix(text).split("\n").filter((l, i, all) => i >= all.findIndex((x) => x.startsWith("@@"))).join("\n").replace(/\n$/, "");

const revisions = JSON.parse(fs.readFileSync(REVISIONS_FILE, "utf8"));
const pr = revisions.prs.find((p) => p.id === prId);
if (!pr) throw new Error(`Unknown shop PR ${prId}`);
const baseSha = revisions.base.sha;
const headSha = pr.commits[0].sha;
for (const brief of Object.values(BRIEF)) {
  if (!fs.existsSync(path.join(attempts, brief, "changes.patch"))) throw new Error(`No ${brief}/changes.patch under ${attempts}`);
}

// ---- the real change: commit 1 of the PR against the base ----
const realNames = git(SAMPLE_REPO, "diff", "--name-status", "--no-renames", baseSha, headSha).trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
const real = {
  id: "real",
  head: headSha,
  source: `the shop sample's ${prId} commit 1 (${headSha.slice(0, 7)}) against its base (${baseSha.slice(0, 7)})`,
  files: realNames.map(([status, file]) =>
    fileRecord(file, status, hunks(git(SAMPLE_REPO, "diff", "--no-color", "-U3", baseSha, headSha, "--", file)), show(SAMPLE_REPO, headSha, file), show(SAMPLE_REPO, baseSha, file)),
  ),
};

// ---- the 3 agents: each patch on a clean copy of the base commit ----
const runs = AGENTS.map((id) => {
  const brief = BRIEF[id];
  const cwd = path.join(DEMO, "blast-shop", prId, id);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-q");
  git(cwd, "config", "core.autocrlf", "false");
  git(cwd, "fetch", "-q", "--depth", "1", SAMPLE_REPO, baseSha);
  git(cwd, "checkout", "-q", "FETCH_HEAD");
  git(cwd, "apply", "--whitespace=nowarn", path.resolve(attempts, brief, "changes.patch"));
  git(cwd, "add", "-A"); // so new files show up in the diff. Nothing is committed.
  // Some agents saved whole files with Windows line endings. Only the edits count, not the line endings.
  const crlf = [];
  for (const file of git(cwd, "diff", "--cached", "--name-only", "--diff-filter=AM", "HEAD").trim().split("\n").filter(Boolean)) {
    const text = fs.readFileSync(path.join(cwd, file), "utf8");
    if (text.includes("\r\n")) {
      fs.writeFileSync(path.join(cwd, file), unix(text));
      crlf.push(file);
    }
  }
  git(cwd, "add", "-A");
  const names = git(cwd, "diff", "--cached", "--name-status", "--no-renames", "HEAD").trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
  const files = names.map(([status, file]) =>
    fileRecord(file, status, hunks(git(cwd, "diff", "--cached", "--no-color", "-U3", "HEAD", "--", file)), status === "D" ? null : unix(fs.readFileSync(path.join(cwd, file), "utf8")), status === "A" ? null : show(cwd, "HEAD", file)),
  );
  const replyFile = path.join(attempts, brief, "reply.md");
  const prompt = unix(fs.readFileSync(path.join(PROMPTS, `${id}.txt`), "utf8"));
  return {
    id,
    brief,
    from: `benchmark/cases/blind-attempts/${prId}/${brief}`,
    prompt: null,
    promptNote: "The full prompt was not saved with these runs. The brief used the 'How to work' lines of the app's Blast radius prompts.",
    instruction: /How to work:\n([\s\S]*?)\n\n## /.exec(prompt)?.[1] ?? null,
    startedAt: null,
    endedAt: null,
    exitCode: 0,
    reply: fs.existsSync(replyFile) ? unix(fs.readFileSync(replyFile, "utf8")).trim() : null,
    toolCalls: null,
    lineEndingsNormalised: crlf,
    files,
  };
});

const out = {
  schema: "impact-map/blast/v1",
  pr: prId,
  recordedAt: new Date().toISOString(),
  model: null,
  modelNote: "The model was not saved with these runs.",
  base: baseSha,
  how: {
    source: `Three recorded blind attempts on the shop sample (benchmark/cases/blind-attempts/${prId}): ${AGENTS.map((a) => `${a} = the '${BRIEF[a]}' brief`).join(", ")}. Each agent got REQ-17 and the shop's code from before the change, alone, once. None saw the pull request.`,
    folders: "Each attempt's patch was laid on a clean copy of the base commit (git fetch --depth 1 of the base only), so the real change was never there. Files an agent saved with Windows line endings were turned back to the shop's own, so a line counts only when its text changed (listed per run under lineEndingsNormalised).",
    same: "Same requirement and same code for all three. Only the 'How to work' lines differ.",
    functions: "Functions are found by a simple reader of the TypeScript text (scanFunctions in src/lib/blast.mjs: `function` declarations, ended by brace matching), the same way for all 4 changes. A function counts as edited when a changed line sits inside it. Callers come from the shop's saved Graphify code index at the base commit.",
  },
  notBuilt: "This record did not run the tests on the agents' changes. Each agent ran the shop's tests itself and said what it saw in its reply.",
  given: {
    file: `requirements/${pr.requirement}.md`,
    text: show(SAMPLE_REPO, baseSha, `requirements/${pr.requirement}.md`),
    kept: [`The requirement ${pr.requirement}, word for word`, "The shop's code and tests from before the change"],
    leftOut: ["The pull request: its title, description, commits and code"],
    note: `${pr.requirement} itself names the two workflows it affects, Checkout and Order Import.`,
  },
  real,
  runs,
};
const target = path.join(DATA, "shop", prId, "blast.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log(`Wrote ${path.relative(ROOT, target)}`);
for (const r of [real, ...runs]) {
  console.log(`${r.id.padEnd(8)} files ${r.files.length}  +${r.files.reduce((s, f) => s + f.added, 0)} -${r.files.reduce((s, f) => s + f.removed, 0)}  functions: ${r.files.flatMap((f) => f.functions.map((x) => `${x.name}${x.isNew ? " (new)" : ""}`)).join(", ") || "none"}`);
}
