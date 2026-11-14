// Monte Carlo swarm: the same task, given to N agents of one model, each alone in a clean copy of the code.
// The "Blast radius" tab replays the result. No agent runs while the demo runs.
//
//   node scripts/record-swarm.mjs --setup  [--model claude-sonnet-5-5] [--count 5]   make N clean copies
//   node scripts/record-swarm.mjs --run    [--model ...] [--count 5]                 run the N agents (in parallel)
//   node scripts/record-swarm.mjs --record                                           write data/tieto/<pr>/swarm.json
//
// Copies live in .demo/swarm/<model>/<n> (git-ignored). Each copy holds only the base commit,
// fetched on its own (git fetch --depth 1 <repo> <base sha>), so the real fix is never there.
// Every agent gets the same prompt: blast-prompts/normal.txt (the "normal" agent's prompt, word for word).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileRecord } from "../src/lib/blast.mjs";
import { DATA, ROOT } from "../src/lib/paths.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const has = (name) => process.argv.includes(`--${name}`);
const prId = arg("pr", "ju26-issue-2283");
const model = arg("model", "claude-sonnet-5-5");
const count = Number(arg("count", "5"));
const root = path.join(ROOT, ".demo", "swarm");
const prDir = path.join(DATA, "tieto", prId);
const promptFile = path.join(prDir, "blast-prompts", "normal.txt");
const pack = JSON.parse(fs.readFileSync(path.join(prDir, "pack.json"), "utf8"));
const baseSha = pack.change.base.sha;
const repoUrl = `${pack.change.repo}`;
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
const unix = (s) => s.replace(/\r\n/g, "\n");
const folder = (m, n) => path.join(root, m, String(n));
const LABEL = { "claude-sonnet-5-5": "Sonnet 5.5", "claude-opus-5-5": "Opus 5.5", "claude-haiku-5-5": "Haiku 5.5", "claude-fable-5-2": "Fable 5.2" };

if (has("setup")) {
  for (let n = 1; n <= count; n++) {
    const cwd = folder(model, n);
    if (fs.existsSync(path.join(cwd, ".git"))) continue;
    fs.mkdirSync(cwd, { recursive: true });
    git(cwd, "init", "-q");
    git(cwd, "config", "core.longpaths", "true");
    git(cwd, "config", "core.autocrlf", "false");
    git(cwd, "-c", "credential.helper=!gh auth git-credential", "fetch", "-q", "--depth", "1", repoUrl, baseSha);
    git(cwd, "checkout", "-q", "FETCH_HEAD");
    console.log(`ready: ${path.relative(ROOT, cwd)} at ${git(cwd, "rev-parse", "--short", "HEAD").trim()}`);
  }
}

if (has("run")) {
  const prompt = fs.readFileSync(promptFile);
  const logs = path.join(root, model, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const one = (n) =>
    new Promise((resolve) => {
      const cwd = folder(model, n);
      fs.writeFileSync(path.join(logs, `${n}.start`), new Date().toISOString());
      const args = ["-p", "--model", model, "--permission-mode", "acceptEdits", "--disallowedTools", "Bash", "PowerShell", "WebFetch", "WebSearch", "Agent", "Skill", "--strict-mcp-config", "--output-format", "stream-json", "--verbose"];
      const child = spawn("claude", args, { cwd, shell: process.platform === "win32" });
      child.stdout.pipe(fs.createWriteStream(path.join(logs, `${n}.jsonl`)));
      child.stderr.pipe(fs.createWriteStream(path.join(logs, `${n}.err`)));
      child.stdin.end(prompt);
      child.on("close", (code) => {
        fs.writeFileSync(path.join(logs, `${n}.end`), new Date().toISOString());
        console.log(`agent ${n} done (exit ${code})`);
        resolve();
      });
    });
  await Promise.all(Array.from({ length: count }, (_, i) => one(i + 1)));
}

if (has("record")) {
  const baseText = (cwd, file) => {
    try {
      return unix(git(cwd, "show", `HEAD:${file}`));
    } catch {
      return null;
    }
  };
  const models = {};
  for (const m of fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "logs")))) {
    const logs = path.join(root, m, "logs");
    const read = (name) => (fs.existsSync(path.join(logs, name)) ? fs.readFileSync(path.join(logs, name), "utf8") : "");
    const nums = fs.readdirSync(path.join(root, m)).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b);
    models[m] = {
      label: LABEL[m] ?? m,
      runs: nums.map((n) => {
        const cwd = folder(m, n);
        const head = git(cwd, "rev-parse", "HEAD").trim();
        if (head !== baseSha) throw new Error(`${cwd} is at ${head}, not at the base commit ${baseSha}`);
        git(cwd, "add", "-A"); // so new files show up. Nothing is committed.
        const names = git(cwd, "diff", "--cached", "--name-status", "--no-renames", "HEAD").trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
        const files = names.map(([status, file]) => {
          const patch = unix(git(cwd, "diff", "--cached", "--no-color", "-U3", "HEAD", "--", file)).split("\n").filter((l, i, all) => i >= all.findIndex((x) => x.startsWith("@@"))).join("\n").replace(/\n$/, "");
          return fileRecord(file, status, patch, status === "D" ? null : unix(fs.readFileSync(path.join(cwd, file), "utf8")), status === "A" ? null : baseText(cwd, file));
        });
        const events = read(`${n}.jsonl`).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const result = events.find((e) => e.type === "result");
        const uses = events.flatMap((e) => (e.type === "assistant" ? (e.message.content ?? []).filter((c) => c.type === "tool_use") : []));
        const home = cwd.replace(/\\/g, "/").toLowerCase();
        const outside = uses.flatMap((u) => [u.input?.file_path, u.input?.path].filter(Boolean)).filter((p) => path.isAbsolute(p) && !p.replace(/\\/g, "/").toLowerCase().startsWith(home));
        return {
          n,
          startedAt: read(`${n}.start`).trim() || null,
          endedAt: read(`${n}.end`).trim() || null,
          exitCode: result ? (result.is_error ? 1 : 0) : null,
          modelInLog: events.find((e) => e.subtype === "init")?.model ?? null,
          turns: result?.num_turns ?? null,
          reply: result?.result ?? null,
          pathsOutsideFolder: [...new Set(outside)],
          files,
        };
      }),
    };
  }
  const out = {
    schema: "impact-map/swarm/v1",
    pr: prId,
    recordedAt: new Date().toISOString(),
    base: baseSha,
    prompt: { file: `data/tieto/${prId}/blast-prompts/normal.txt`, text: unix(fs.readFileSync(promptFile, "utf8")), note: "Every agent got this prompt, word for word: the same one the normal agent got." },
    how: "Each agent ran once with `claude -p --model <model>`, alone, in its own copy of the code from before the fix. No shell, no git, no web. Agents of the same model ran at the same time.",
    notBuilt: "This machine has no .NET SDK. Nobody built the code or ran the unit tests. We do not know if any agent's fix works.",
    // The demo mix the Run button plays by default: [model, run number]. Picked before looking at the results.
    mix: [["claude-opus-5-5", 1], ["claude-sonnet-5-5", 1], ["claude-sonnet-5-5", 2], ["claude-haiku-5-5", 1], ["claude-haiku-5-5", 2]],
    models,
  };
  fs.writeFileSync(path.join(prDir, "swarm.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`Wrote data/tieto/${prId}/swarm.json`);
  for (const [m, v] of Object.entries(models)) for (const r of v.runs) console.log(`${m} #${r.n}: ${r.files.length} files, +${r.files.reduce((s, f) => s + f.added, 0)} -${r.files.reduce((s, f) => s + f.removed, 0)}  ${r.files.map((f) => f.file.split("/").pop()).join(", ")}${r.pathsOutsideFolder.length ? "  OUTSIDE: " + r.pathsOutsideFolder.join(", ") : ""}`);
}
