// Records the Monte Carlo swarm for a shop sample PR: 5 agents of one model, the same prompt, each alone.
//
//   node scripts/record-shop-swarm.mjs --pr <id> [--runs 1,2,3,4,5] [--record-only]
//
// Each agent gets data/shop/<pr>/swarm-prompt.txt, word for word, in its own clean copy of the shop
// sample at the base commit, under .demo/swarm-shop/<pr>/<n> (git-ignored). The agents run with
// `claude -p` (scripts/shop-agents.mjs), at most 3 at the same time. Their logs go to .demo/swarm-shop/<pr>/logs.
// --runs runs only those agents again (a failed run); the others keep their copies and logs.
// --record-only runs no agent and rebuilds data/shop/<pr>/swarm.json from the copies already there.
// The real change is the PR's first commit against the base, read from the sample repo.
import fs from "node:fs";
import path from "node:path";
import { DATA, DEMO, REVISIONS_FILE, ROOT } from "../src/lib/paths.mjs";
import { MODEL, copyFiles, freshCopy, git, inBatches, readRun, realFiles, runAgent, unix } from "./shop-agents.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const prId = arg("pr");
if (!prId) throw new Error("Give the shop PR: --pr <id>");
const COUNT = 5;
const recordOnly = process.argv.includes("--record-only");
const todo = arg("runs", Array.from({ length: COUNT }, (_, i) => i + 1).join(",")).split(",").map(Number);
if (todo.some((n) => !(n >= 1 && n <= COUNT))) throw new Error(`--runs takes numbers from 1 to ${COUNT}`);

const revisions = JSON.parse(fs.readFileSync(REVISIONS_FILE, "utf8"));
const pr = revisions.prs.find((p) => p.id === prId);
if (!pr) throw new Error(`Unknown shop PR ${prId}`);
const BASE = revisions.base.sha;
const HEAD1 = pr.commits[0].sha;
const prompt = unix(fs.readFileSync(path.join(DATA, "shop", prId, "swarm-prompt.txt"), "utf8"));
const root = path.join(DEMO, "swarm-shop", prId);
const logs = path.join(root, "logs");

const real = realFiles(BASE, HEAD1);
if (!recordOnly) {
  await inBatches(todo.map((n) => () => {
    const cwd = path.join(root, String(n));
    freshCopy(cwd, BASE);
    return runAgent(cwd, prompt, logs, String(n));
  }));
}

// ---- the agents: what each copy holds now, against the base ----
const nums = fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b);
if (nums.length !== COUNT) throw new Error(`Expected ${COUNT} copies under ${path.relative(ROOT, root)}, found ${nums.length}`);
const runs = nums.map((n) => {
  const cwd = path.join(root, String(n));
  const head = git(cwd, "rev-parse", "HEAD").trim();
  if (head !== BASE) throw new Error(`copy ${n} is at ${head}, not at the base commit`);
  const files = copyFiles(cwd);
  const { startedAt, endedAt, exitCode, modelInLog, turns, reply, pathsOutsideFolder } = readRun(logs, String(n), cwd);
  return { n, startedAt, endedAt, exitCode, modelInLog, turns, reply, pathsOutsideFolder, files };
});
const day = (runs[0].startedAt ?? "").slice(0, 10);
const out = {
  schema: "impact-map/swarm/v1",
  pr: prId,
  recordedAt: new Date().toISOString(),
  base: BASE,
  realFrom: { commit: HEAD1, note: `The real change: the first commit of ${prId} in the shop sample, against its base.` },
  real: { files: real },
  prompt: { file: `data/shop/${prId}/swarm-prompt.txt`, text: prompt, note: "Every agent got this prompt, word for word: the normal agent's brief (own judgement, as for a normal pull request)." },
  how: `Runs on the shop sample (pull request ${prId}), ${day}. Each of ${COUNT} agents ran once with \`claude -p --model ${MODEL}\`, alone, in its own copy of the shop sample at the commit before ${prId}. Every agent got the same normal prompt (swarm-prompt.txt). No shell, no git, no web. At most 3 ran at the same time.`,
  notBuilt: "The agents had no shell. Nobody ran the unit tests on their changes. We do not know if any agent's change passes them.",
  models: { [MODEL]: { label: "Sonnet 5.5", runs } },
};
const dest = path.join(DATA, "shop", prId, "swarm.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
console.log(`Wrote ${path.relative(ROOT, dest)}`);
console.log(`real: ${real.map((f) => `${f.file} +${f.added} -${f.removed}`).join(", ")}`);
for (const r of runs) console.log(`#${r.n} exit ${r.exitCode} model ${r.modelInLog} turns ${r.turns} outside [${r.pathsOutsideFolder}]: ${r.files.map((f) => `${f.file} +${f.added} -${f.removed}`).join(", ")}`);
