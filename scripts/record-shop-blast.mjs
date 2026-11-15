// Writes data/shop/<pr>/blast.json for a shop sample PR: three agents (careful, normal, too much) on the same task.
//
//   node scripts/record-shop-blast.mjs --attempts <folder> [--pr req-17]
//   node scripts/record-shop-blast.mjs --run --pr <id> [--agents minimal,normal,wide] [--record-only]
//
// --attempts: from three recorded blind attempts. <folder> holds one folder per brief (careful,
// normal, greedy), each with the agent's changes.patch and its closing reply.md. Those agents got the
// requirement and the shop's code from before the change, never the pull request. Each patch is laid
// on its own copy of the base commit, and the diff is read back from there. This mode calls no model.
//
// --run: runs the three agents now, at the same time (at most 3), with `claude -p` (scripts/shop-agents.mjs).
// Each prompt is the shop's rules, the "How to work" lines of the app's Blast radius prompts
// (data/tieto/ju26-issue-2283/blast-prompts), and the PR description's requirements from
// briefs/<pr>.json. The full prompt, model, times and tool calls are saved with each run.
// --agents runs only those agents again (a failed run); the others keep their copies and logs.
// --record-only runs no agent and rebuilds blast.json from the copies already there.
//
// Copies live under .demo/blast-shop/<pr>/<agent> (git-ignored), logs under .demo/blast-shop/<pr>/logs.
// The real change is the PR's first commit against the base, read from the sample repo.
import fs from "node:fs";
import path from "node:path";
import { AGENTS } from "../src/lib/blast.mjs";
import { DATA, DEMO, REVISIONS_FILE, ROOT, SAMPLE_REPO } from "../src/lib/paths.mjs";
import { CLAUDE_ARGS, MODEL, copyFiles, freshCopy, git, inBatches, readRun, realFiles, runAgent, shopPrompt, show, unix } from "./shop-agents.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const run = process.argv.includes("--run");
const prId = arg("pr", run ? undefined : "req-17");
if (!prId) throw new Error("Give the shop PR: --pr <id>");
const attempts = arg("attempts");
if (!run && !attempts) throw new Error("Give the folder of recorded attempts (--attempts <folder>), or --run to run the agents");
if (run && attempts) throw new Error("Give either --attempts or --run, not both");
const recordOnly = process.argv.includes("--record-only");
const todo = arg("agents", AGENTS.join(",")).split(",");
if (todo.some((a) => !AGENTS.includes(a))) throw new Error(`--agents takes ${AGENTS.join(", ")}`);
// Which brief each agent column comes from: the three whose instructions are the app's Blast radius prompts.
const BRIEF = { minimal: "careful", normal: "normal", wide: "greedy" };
const PROMPTS = path.join(DATA, "tieto", "ju26-issue-2283", "blast-prompts");
const instructionOf = (id) => /How to work:\n([\s\S]*?)\n\n## /.exec(unix(fs.readFileSync(path.join(PROMPTS, `${id}.txt`), "utf8")))?.[1] ?? null;

const revisions = JSON.parse(fs.readFileSync(REVISIONS_FILE, "utf8"));
const pr = revisions.prs.find((p) => p.id === prId);
if (!pr) throw new Error(`Unknown shop PR ${prId}`);
const baseSha = revisions.base.sha;
const headSha = pr.commits[0].sha;
if (attempts) {
  for (const brief of Object.values(BRIEF)) {
    if (!fs.existsSync(path.join(attempts, brief, "changes.patch"))) throw new Error(`No ${brief}/changes.patch under ${attempts}`);
  }
}
const home = path.join(DEMO, "blast-shop", prId);
const logs = path.join(home, "logs");

// ---- the real change: commit 1 of the PR against the base ----
const real = {
  id: "real",
  head: headSha,
  source: `the shop sample's ${prId} commit 1 (${headSha.slice(0, 7)}) against its base (${baseSha.slice(0, 7)})`,
  files: realFiles(baseSha, headSha),
};

// ---- the 3 agents: run now, or each recorded patch on a clean copy of the base commit ----
const prompts = Object.fromEntries(AGENTS.map((id) => [id, run ? shopPrompt(prId, instructionOf(id)) : null]));
if (run && !recordOnly) {
  await inBatches(todo.map((id) => () => {
    const cwd = path.join(home, id);
    freshCopy(cwd, baseSha);
    return runAgent(cwd, prompts[id], logs, id);
  }));
}

const runs = AGENTS.map((id) => {
  const brief = BRIEF[id];
  const cwd = path.join(home, id);
  if (run) {
    if (git(cwd, "rev-parse", "HEAD").trim() !== baseSha) throw new Error(`The ${id} copy is not at the base commit`);
  } else {
    freshCopy(cwd, baseSha);
    git(cwd, "apply", "--whitespace=nowarn", path.resolve(attempts, brief, "changes.patch"));
  }
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
  const files = copyFiles(cwd);
  if (run) {
    const log = readRun(logs, id, cwd);
    return { id, brief, prompt: prompts[id], instruction: instructionOf(id), ...log, lineEndingsNormalised: crlf, files };
  }
  const replyFile = path.join(attempts, brief, "reply.md");
  return {
    id,
    brief,
    from: `benchmark/cases/blind-attempts/${prId}/${brief}`,
    prompt: null,
    promptNote: "The full prompt was not saved with these runs. The brief used the 'How to work' lines of the app's Blast radius prompts.",
    instruction: instructionOf(id),
    startedAt: null,
    endedAt: null,
    exitCode: 0,
    reply: fs.existsSync(replyFile) ? unix(fs.readFileSync(replyFile, "utf8")).trim() : null,
    toolCalls: null,
    lineEndingsNormalised: crlf,
    files,
  };
});

const functions = "Functions are found by a simple reader of the TypeScript text (scanFunctions in src/lib/blast.mjs: `function` declarations, ended by brace matching), the same way for all 4 changes. A function counts as edited when a changed line sits inside it. Callers come from the shop's saved Graphify code index at the base commit.";
const lineEndings = "Files an agent saved with Windows line endings were turned back to the shop's own, so a line counts only when its text changed (listed per run under lineEndingsNormalised).";
const reqFile = pr.requirement ? `requirements/${pr.requirement}.md` : null;
const out = run
  ? {
      schema: "impact-map/blast/v1",
      pr: prId,
      recordedAt: new Date().toISOString(),
      model: MODEL,
      base: baseSha,
      how: {
        source: `Three agents run on the shop sample (pull request ${prId}), ${(runs[0].startedAt ?? "").slice(0, 10)}: ${AGENTS.map((a) => `${a} = the '${BRIEF[a]}' brief`).join(", ")}. Each ran once, alone, at the same time as the others. None saw the pull request.`,
        command: `claude ${CLAUDE_ARGS.join(" ")} < the run's prompt (saved under runs[].prompt)`,
        folders: `Each agent worked in its own clean copy of the base commit (git fetch --depth 1 of the base only), so the real change was never there. No shell, no git, no web. ${lineEndings}`,
        same: "Same model, same requirements and same code for all three. Only the 'How to work' lines differ.",
        functions,
      },
      notBuilt: "The agents had no shell. Nobody ran the unit tests on their changes.",
      given: {
        file: reqFile,
        text: reqFile ? show(SAMPLE_REPO, headSha, reqFile) : null,
        kept: ["The pull request description's Why, Before and after, and Must preserve", ...(reqFile ? [`The requirement ${pr.requirement}, word for word`] : []), "The shop's code and tests from before the change"],
        leftOut: ["The pull request: its title, approach, commits and code"],
        note: reqFile ? null : "No requirement is linked to this pull request.",
      },
      real,
      runs,
    }
  : {
      schema: "impact-map/blast/v1",
      pr: prId,
      recordedAt: new Date().toISOString(),
      model: null,
      modelNote: "The model was not saved with these runs.",
      base: baseSha,
      how: {
        source: `Three recorded blind attempts on the shop sample (benchmark/cases/blind-attempts/${prId}): ${AGENTS.map((a) => `${a} = the '${BRIEF[a]}' brief`).join(", ")}. Each agent got REQ-17 and the shop's code from before the change, alone, once. None saw the pull request.`,
        folders: `Each attempt's patch was laid on a clean copy of the base commit (git fetch --depth 1 of the base only), so the real change was never there. ${lineEndings}`,
        same: "Same requirement and same code for all three. Only the 'How to work' lines differ.",
        functions,
      },
      notBuilt: "This record did not run the tests on the agents' changes. Each agent ran the shop's tests itself and said what it saw in its reply.",
      given: {
        file: reqFile,
        text: show(SAMPLE_REPO, headSha, reqFile),
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
  console.log(`${r.id.padEnd(8)} ${r.id === "real" ? "" : `exit ${r.exitCode} model ${r.modelInLog ?? "-"} outside [${r.pathsOutsideFolder ?? ""}] `}files ${r.files.length}  +${r.files.reduce((s, f) => s + f.added, 0)} -${r.files.reduce((s, f) => s + f.removed, 0)}  functions: ${r.files.flatMap((f) => f.functions.map((x) => `${x.name}${x.isNew ? " (new)" : ""}`)).join(", ") || "none"}`);
}
