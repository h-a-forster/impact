import { execFileSync } from "node:child_process";
import { SAMPLE_REPO } from "./paths.mjs";

/** Run git in the sample repo. Returns stdout as text. */
// Reads of a commit never change, so they are cached for the life of the process.
// (Each git call costs tens of milliseconds on Windows.)
const READ_ONLY = new Set(["show", "ls-tree", "diff", "cat-file"]);
const cache = new Map();

export function git(args, opts = {}) {
  const cacheable = READ_ONLY.has(args[0]) && !opts.cwd && !opts.env;
  const key = args.join("\u0000");
  if (cacheable && cache.has(key)) return cache.get(key);
  const out = run(args, opts);
  if (cacheable) cache.set(key, out);
  return out;
}

function run(args, opts) {
  return execFileSync("git", args, {
    cwd: opts.cwd ?? SAMPLE_REPO,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function revisionExists(sha) {
  try {
    return git(["cat-file", "-t", sha]).trim() === "commit";
  } catch {
    return false;
  }
}

export function listFiles(sha) {
  return git(["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
}

/** File content at a revision, or null when the file is not in that revision. */
export function readFileAt(sha, file) {
  try {
    return git(["show", `${sha}:${file}`]);
  } catch {
    return null;
  }
}

const REGULAR_FILE = "100644";
const ABSENT = "000000";
const OTHER_MODES = { 120000: "a link, not a file", 160000: "a submodule pointer", 100755: "an executable file" };
// Fails closed: any tag that runs code, loads or sends something, or changes the page, and any event-handler attribute.
const ACTIVE_CONTENT = /<\s*(script|iframe|frame|frameset|object|embed|applet|svg|math|link|meta|base|form|style)\b|<[a-z][^>]*[\s/"']on[a-z]+\s*=|(javascript|vbscript):|data:text\/html/i;
const MAX_PLAIN_BYTES = 1024 * 1024;

/**
 * Why a changed file is not an ordinary text file, or null when it is one.
 * A name alone proves nothing: a link, a submodule pointer, an executable or a binary file
 * can all be called notes.md.
 */
function oddityOf({ oldMode, newMode, status, file }, sha, binary, opts) {
  if (status === "T") return "the file changes type";
  for (const mode of [oldMode, newMode]) {
    if (mode !== REGULAR_FILE && mode !== ABSENT) return OTHER_MODES[mode] ?? `file mode ${mode}`;
  }
  if (binary.has(file)) return "binary content";
  if (newMode === ABSENT) return null;
  if (Number(git(["cat-file", "-s", `${sha}:${file}`], opts)) > MAX_PLAIN_BYTES) return "larger than 1 MB";
  if (ACTIVE_CONTENT.test(git(["show", `${sha}:${file}`], opts))) return "contains a script or an embedded page";
  const reader = codeThatReads(file, sha, opts);
  return reader ? `read by code (${reader}), so editing it can change what the code does` : null;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first file that is not a document and names this file or its folder as a path, or null.
 * The review policy is left out: it names the allowlisted folders, and no code runs it.
 * A document that code loads at run time is configuration in disguise: editing a price table
 * in docs/pricing.md can change every total. Prose such as "see the docs" does not count.
 */
function codeThatReads(file, sha, opts) {
  const slash = file.lastIndexOf("/");
  const patterns = [`[/\\\\"'\`]${escapeRegExp(file.slice(slash + 1))}`];
  if (slash > 0) {
    const folder = escapeRegExp(file.slice(0, slash));
    patterns.push(`${folder}[/\\\\]`, `["'\`]${folder}["'\`]`);
  }
  try {
    const args = ["grep", "-l", "-I", "-E", ...patterns.flatMap((p) => ["-e", p]), sha, "--", ".", ":(exclude)*.md", ":(exclude)review-policy.yml", `:(exclude)${file}`];
    return git(args, opts).split("\n").find(Boolean)?.replace(`${sha}:`, "") ?? null;
  } catch (error) {
    if (error.status === 1) return null; // git grep exits 1 when nothing matches
    return "a file the search could not check"; // any other failure fails closed
  }
}

/**
 * Files that differ between two commits: `{ status, file, oddity }`.
 * `opts.cwd` points at another repository (used by tests).
 */
export function changedFiles(baseSha, sha, opts = {}) {
  // No rename detection: a file moved into another folder must show up under its old path too.
  const raw = git(["diff", "--raw", "--no-renames", "--no-abbrev", "-z", baseSha, sha], opts).split("\0").filter(Boolean);
  const binary = new Set(
    git(["diff", "--numstat", "--no-renames", "-z", baseSha, sha], opts).split("\0").filter((entry) => entry.startsWith("-\t-\t")).map((entry) => entry.slice(4)),
  );
  const files = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, , , status] = raw[i].slice(1).split(" ");
    const record = { oldMode, newMode, status: status[0], file: raw[i + 1] };
    files.push({ status: record.status, file: record.file, oddity: oddityOf(record, sha, binary, opts) });
  }
  return files;
}

export function unifiedDiff(baseSha, sha, file) {
  const args = ["diff", "--unified=3", baseSha, sha];
  if (file) args.push("--", file);
  return git(args);
}

/**
 * Changed line ranges per file, from `git diff --unified=0`.
 * Returns { file: { added: [[start,end]], removed: [[start,end]] } }.
 * "added" lines use line numbers at `sha`. "removed" use line numbers at base.
 */
export function changedLineRanges(baseSha, sha) {
  const out = {};
  let current = null;
  for (const line of git(["diff", "--unified=0", baseSha, sha]).split("\n")) {
    if (line.startsWith("+++ ")) {
      const file = line.slice(4).replace(/^b\//, "");
      current = file === "/dev/null" ? null : file;
      if (current) out[current] ??= { added: [], removed: [] };
    } else if (line.startsWith("--- ")) {
      const file = line.slice(4).replace(/^a\//, "");
      if (file !== "/dev/null") out[file] ??= { added: [], removed: [] };
      current = file === "/dev/null" ? null : file;
    } else if (line.startsWith("@@") && current) {
      const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const oldStart = Number(m[1]);
      const oldLen = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLen = m[4] === undefined ? 1 : Number(m[4]);
      if (oldLen > 0) out[current].removed.push([oldStart, oldStart + oldLen - 1]);
      // A pure deletion still marks the line it happened at in the new file.
      out[current].added.push(newLen > 0 ? [newStart, newStart + newLen - 1] : [newStart, newStart]);
    }
  }
  return out;
}
