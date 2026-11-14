// Shared by scripts/record-shop-blast.mjs (--run) and scripts/record-shop-swarm.mjs: running one coding
// agent alone in a clean copy of the shop sample, and reading back what it did.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileRecord } from "../src/lib/blast.mjs";
import { BRIEFS, SAMPLE_REPO } from "../src/lib/paths.mjs";

export const MODEL = "claude-sonnet-5-5";
const TIMEOUT_MS = 15 * 60 * 1000;
// No shell, no git, no web, no subagents, no MCP servers. Only the user's own settings are loaded.
export const CLAUDE_ARGS = ["-p", "--model", MODEL, "--setting-sources", "user", "--permission-mode", "acceptEdits", "--disallowedTools", "Bash", "PowerShell", "WebFetch", "WebSearch", "Agent", "Skill", "--strict-mcp-config", "--output-format", "stream-json", "--verbose"];

export const git = (cwd, ...args) => execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
export const unix = (s) => s.replace(/\r\n/g, "\n");
/** The diff of one file without its header lines, starting at the first "@@". */
export const hunks = (text) => unix(text).split("\n").filter((l, i, all) => i >= all.findIndex((x) => x.startsWith("@@"))).join("\n").replace(/\n$/, "");
export const show = (cwd, rev, file) => {
  try {
    return unix(git(cwd, "show", `${rev}:${file}`));
  } catch {
    return null; // not there at that commit
  }
};

/** The PR's real change: its first commit against the base, read from the sample repo. */
export function realFiles(baseSha, headSha) {
  if (git(SAMPLE_REPO, "rev-parse", `${headSha}^`).trim() !== baseSha) throw new Error(`${headSha.slice(0, 7)} does not sit on the base ${baseSha.slice(0, 7)}`);
  return git(SAMPLE_REPO, "diff", "--name-status", "--no-renames", baseSha, headSha).trim().split("\n").filter(Boolean).map((l) => l.split("\t")).map(([status, file]) =>
    fileRecord(file, status, hunks(git(SAMPLE_REPO, "diff", "--no-color", "-U3", baseSha, headSha, "--", file)), status === "D" ? null : show(SAMPLE_REPO, headSha, file), status === "A" ? null : show(SAMPLE_REPO, baseSha, file)));
}

/** A clean copy of the shop sample at the base commit: only that commit is fetched, so the real change is never there. */
export function freshCopy(cwd, baseSha) {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-q");
  git(cwd, "config", "core.autocrlf", "false");
  git(cwd, "fetch", "-q", "--depth", "1", SAMPLE_REPO, baseSha);
  git(cwd, "checkout", "-q", "FETCH_HEAD");
}

/** The files a copy changes against its HEAD, as file records. New files count; nothing is committed. */
export function copyFiles(cwd) {
  git(cwd, "add", "-A");
  const names = git(cwd, "diff", "--cached", "--name-status", "--no-renames", "HEAD").trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
  return names.map(([status, file]) =>
    fileRecord(file, status, hunks(git(cwd, "diff", "--cached", "--no-color", "-U3", "HEAD", "--", file)), status === "D" ? null : unix(fs.readFileSync(path.join(cwd, file), "utf8")), status === "A" ? null : show(cwd, "HEAD", file)));
}

/**
 * Runs one agent with `claude -p` in `cwd`, the prompt on stdin. Writes <name>.start, .jsonl, .err
 * and .end under `logs`. Resolves when the agent has finished or was stopped at the time limit.
 */
export const runAgent = (cwd, prompt, logs, name) =>
  new Promise((resolve) => {
    fs.mkdirSync(logs, { recursive: true });
    for (const ext of ["jsonl", "err", "start", "end"]) fs.rmSync(path.join(logs, `${name}.${ext}`), { force: true });
    fs.writeFileSync(path.join(logs, `${name}.start`), new Date().toISOString());
    const child = spawn("claude", CLAUDE_ARGS, { cwd, shell: true });
    child.stdout.pipe(fs.createWriteStream(path.join(logs, `${name}.jsonl`)));
    child.stderr.pipe(fs.createWriteStream(path.join(logs, `${name}.err`)));
    child.stdin.end(prompt);
    const timer = setTimeout(() => {
      console.log(`agent ${name} timed out`);
      // shell: true puts a shell between us and claude; stop the whole tree.
      if (os.platform() === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(logs, `${name}.end`), new Date().toISOString());
      console.log(`agent ${name} done (exit ${code}) ${new Date().toISOString()}`);
      resolve();
    });
  });

/** Drop a folder from paths in a reply, so only the path inside the repository is left. */
const local = (text, home) => text.replace(new RegExp(home.split("/").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]") + "[\\\\/]", "gi"), "");

/** What one agent's logs say: times, exit, model, turns, reply, tool calls, and any path it used outside its copy. */
export function readRun(logs, name, cwd) {
  const read = (ext) => (fs.existsSync(path.join(logs, `${name}.${ext}`)) ? fs.readFileSync(path.join(logs, `${name}.${ext}`), "utf8") : "");
  const events = read("jsonl").split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const result = events.find((e) => e.type === "result");
  const uses = events.flatMap((e) => (e.type === "assistant" ? (e.message.content ?? []).filter((c) => c.type === "tool_use") : []));
  const toolCalls = {};
  for (const u of uses) toolCalls[u.name] = (toolCalls[u.name] ?? 0) + 1;
  const home = cwd.replace(/\\/g, "/").toLowerCase();
  const outside = uses.flatMap((u) => [u.input?.file_path, u.input?.path].filter(Boolean)).filter((p) => path.isAbsolute(p) && !p.replace(/\\/g, "/").toLowerCase().startsWith(home));
  return {
    startedAt: read("start").trim() || null,
    endedAt: read("end").trim() || null,
    exitCode: result ? (result.is_error ? 1 : 0) : null,
    modelInLog: events.find((e) => e.subtype === "init")?.model ?? null,
    turns: result?.num_turns ?? null,
    // Links in a reply point into the copy's folder on this machine: keep only the path inside the repository.
    reply: result?.result ? local(result.result, home) : null,
    toolCalls,
    pathsOutsideFolder: [...new Set(outside)],
  };
}

const HEADER = `You are working in a copy of the shop-sample repository (TypeScript), at the commit just before the change. Solve the problem described below by editing files in this folder.

Rules for this run:
- You cannot run commands, so you cannot run the unit tests. Do not try. Reason from the code.
- Work only inside this folder. Do not use the web. Do not use git.
- When you are done, reply with a short list of the files you changed and why.`;

/**
 * The prompt for a shop PR: the shop's rules, the given "How to work" lines, then the PR description's
 * Requirement, Why, Before and after and Must preserve (from briefs/<pr>.json), and the linked
 * requirement word for word. The PR's approach, title, commits and code are left out.
 */
export function shopPrompt(prId, howToWork, baseSha) {
  const brief = JSON.parse(fs.readFileSync(path.join(BRIEFS, `${prId}.json`), "utf8"));
  const lower = (s) => s[0].toLowerCase() + s.slice(1);
  const reqFile = brief.requirement ? `requirements/${brief.requirement}.md` : null;
  const parts = [
    HEADER,
    `How to work:\n${howToWork}`,
    "## Requirements (from the pull request description)",
    `Requirement: ${reqFile ? `${brief.requirement} in the shop sample (${reqFile}).` : "None linked."}`,
    `Why: ${brief.why}`,
    `Before and after: Before: ${lower(brief.before)} After: ${lower(brief.after)}`,
    `Must preserve: ${brief.preserve}`,
  ];
  if (reqFile) parts.push(`## The requirement the Requirement row points to (${reqFile}, word for word)\n\n${show(SAMPLE_REPO, baseSha, reqFile).replace(/\n$/, "")}`);
  return parts.join("\n\n") + "\n";
}
