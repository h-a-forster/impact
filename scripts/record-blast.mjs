// Rebuilds data/tieto/<pr>/blast.json from the 3 agent folders.
//
//   node scripts/record-blast.mjs [--dir .demo/blast] [--pr ju26-issue-2283] [--model claude-fable-5-2]
//
// Before this script: each folder under --dir (minimal, normal, wide) is the Tieto repo at the
// base commit (only that commit is fetched, so the real fix is not there), and one agent has
// worked in it. How the agents were run is written into blast.json under "how".
// This script reads only: `git diff` in each folder, the saved prompts, the run logs, and the
// recorded pack for the real change. It calls no model and no network.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENTS, fileKind, fileRecord } from "../src/lib/blast.mjs";
import { DATA, ROOT } from "../src/lib/paths.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const prId = arg("pr", "ju26-issue-2283");
const dir = path.resolve(ROOT, arg("dir", ".demo/blast"));
const model = arg("model", "claude-fable-5-2");
const prDir = path.join(DATA, "tieto", prId);
const promptDir = path.join(prDir, "blast-prompts");
const pack = JSON.parse(fs.readFileSync(path.join(prDir, "pack.json"), "utf8"));
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
const unix = (s) => s.replace(/\r\n/g, "\n");

/** The new text of a file: the old text with a diff laid on. Used when the pack holds no text for a file (unit tests). */
function applyPatch(base, patch) {
  const old = base.split("\n"), out = [];
  let at = 0; // lines of the old file used so far
  for (const raw of patch.split("\n")) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(raw);
    if (head) {
      const start = Number(head[1]) - (head[2] === "0" ? 0 : 1);
      out.push(...old.slice(at, start));
      at = start;
    } else if (raw[0] === "+") out.push(raw.slice(1));
    else if (raw[0] === "-") at++;
    else if (!raw.startsWith("\\")) out.push(old[at++]);
  }
  return [...out, ...old.slice(at)].join("\n");
}

// ---- the real change, from the recorded pack ----
const baseSha = pack.change.base.sha;
const anyFolder = AGENTS.map((a) => path.join(dir, a)).find((d) => fs.existsSync(path.join(d, ".git")));
if (!anyFolder) throw new Error(`No agent folder with the base commit under ${dir}`);
const baseText = (cwd, file) => {
  try {
    return unix(git(cwd, "show", `HEAD:${file}`));
  } catch {
    return null; // the file does not exist at the base commit
  }
};
const real = {
  id: "real",
  head: pack.change.head.sha,
  source: `data/tieto/${prId}/pack.json (branch ${prId}, recorded)`,
  files: pack.files.map((f) => {
    const patch = f.hunks.map((h) => [`@@ -${h.base_start},${h.base_lines} +${h.head_start},${h.head_lines} @@`, ...h.lines.map((l) => `${l.t}${l.text}`)].join("\n")).join("\n");
    const before = baseText(anyFolder, f.path);
    const after = f.head_text ? f.head_text.join("\n") : f.status === "deleted" ? null : applyPatch(before ?? "", patch);
    return fileRecord(f.path, f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M", patch, after, before);
  }),
};

// ---- the 3 agent runs ----
const runs = AGENTS.map((id) => {
  const cwd = path.join(dir, id);
  const head = git(cwd, "rev-parse", "HEAD").trim();
  if (head !== baseSha) throw new Error(`${cwd} is at ${head}, not at the base commit ${baseSha}`);
  git(cwd, "add", "-A"); // so new files show up in the diff. Nothing is committed.
  const names = git(cwd, "diff", "--cached", "--name-status", "--no-renames", "HEAD").trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
  const files = names.map(([status, file]) => {
    const patch = unix(git(cwd, "diff", "--cached", "--no-color", "-U3", "HEAD", "--", file)).split("\n").filter((l, i, all) => i >= all.findIndex((x) => x.startsWith("@@"))).join("\n").replace(/\n$/, "");
    const abs = path.join(cwd, file);
    return fileRecord(file, status, patch, status === "D" ? null : unix(fs.readFileSync(abs, "utf8")), status === "A" ? null : baseText(cwd, file));
  });
  // What the run log says: times, the last reply, which tools were called, and any path outside the folder.
  const read = (name) => (fs.existsSync(path.join(dir, "logs", name)) ? fs.readFileSync(path.join(dir, "logs", name), "utf8") : "");
  const events = read(`${id}.jsonl`).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = events.find((e) => e.type === "result");
  const uses = events.flatMap((e) => (e.type === "assistant" ? (e.message.content ?? []).filter((c) => c.type === "tool_use") : []));
  const toolCalls = {};
  for (const u of uses) toolCalls[u.name] = (toolCalls[u.name] ?? 0) + 1;
  const home = cwd.replace(/\\/g, "/").toLowerCase();
  const outside = uses.flatMap((u) => [u.input?.file_path, u.input?.path].filter(Boolean)).filter((p) => path.isAbsolute(p) && !p.replace(/\\/g, "/").toLowerCase().startsWith(home));
  const prompt = unix(fs.readFileSync(path.join(promptDir, `${id}.txt`), "utf8"));
  return {
    id,
    prompt,
    instruction: /How to work:\n([\s\S]*?)\n\n## /.exec(prompt)?.[1] ?? null,
    startedAt: read(`${id}.start`).trim() || null,
    endedAt: read(`${id}.end`).trim() || null,
    exitCode: result ? (result.is_error ? 1 : 0) : null,
    modelInLog: events.find((e) => e.subtype === "init")?.model ?? null,
    turns: result?.num_turns ?? null,
    reply: result?.result ?? null,
    toolCalls,
    pathsOutsideFolder: [...new Set(outside)],
    files,
  };
});

const out = {
  schema: "impact-map/blast/v1",
  pr: prId,
  recordedAt: new Date().toISOString(),
  model,
  base: baseSha,
  how: {
    command: `claude -p --model ${model} --permission-mode acceptEdits --disallowedTools Bash PowerShell WebFetch WebSearch Agent Skill --strict-mcp-config --output-format stream-json --verbose < blast-prompts/<run>.txt`,
    folders: "3 folders, each with only the base commit fetched (git fetch --depth 1 <repo> <base sha>). The branch with the real fix was never fetched.",
    same: "Same model and same requirements for all three. Only the 'How to work' lines differ.",
    settings: "The agents ran with the operator's user settings only (no project settings). They could read, search and edit files in their folder. They had no shell, no git and no web.",
    functions: "Functions are found by a simple reader of the C# text (scanFunctions in src/lib/blast.mjs), the same way for all 4 changes. A function counts as edited when a changed line sits inside it.",
  },
  notBuilt: "This machine has no .NET SDK. Nobody built the code or ran the unit tests. We do not know if any agent's fix works.",
  given: {
    file: `data/tieto/${prId}/blast-prompts/requirements.md`,
    text: unix(fs.readFileSync(path.join(promptDir, "requirements.md"), "utf8")),
    kept: ["Requirement", "Why", "Before and after (first part: 'Before: the tool crashed and the file was missing. After: no crash.')", "Must preserve", "The bug report #2283 that the Requirement row points to, word for word (without the link to the attached zip)"],
    leftOut: ["Summary and tags (they describe the real fix)", "Second half of 'Before → after' (it says what the real fix hides)", "Approach (it names a function the real fix adds)", "Alternatives", "Checks run", "Open gaps", "Rollback"],
    note: "The bug report itself names TypeCollector.cs and GetObjectInfo(), where the crash is. The author of the real change had the same bug report.",
  },
  real,
  runs,
};
const target = path.join(prDir, "blast.json");
fs.writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log(`Wrote ${path.relative(ROOT, target)}`);
for (const r of [real, ...runs]) {
  console.log(`${r.id.padEnd(8)} files ${r.files.length}  +${r.files.reduce((s, f) => s + f.added, 0)} -${r.files.reduce((s, f) => s + f.removed, 0)}  functions: ${r.files.flatMap((f) => f.functions.map((x) => `${x.name}${x.isNew ? " (new)" : ""}`)).join(", ") || "none"}${r.pathsOutsideFolder?.length ? `  PATHS OUTSIDE THE FOLDER: ${r.pathsOutsideFolder.join(", ")}` : ""}`);
}
