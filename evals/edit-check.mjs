// Two checks on a change that the tests pass. No model is called.
//   Too much:   take each edit out again and re-run the tests. An edit no test needs is a passenger.
//               The code with and without a passenger is then called side by side to see whether
//               the passenger changes what the code does.
//   Too little: look in the code the change did not touch for the old form of each edited line.
// It runs on the shop sample: its commits as written, each planted fault as one extra edit, and one
// unfinished change. The answers are known beforehand, so it is an eval of the check itself: it
// fails if a planted fault passes in silence or a clean REQ-17 commit raises a question.
//   Run with:  npm run editcheck
// It works in the system's temporary folder. It imports and calls the sample's code, so run it
// where the tests may run.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIPPED_FOLDERS = new Set(["node_modules", ".git"]);
const TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\d+(?:\.\d+)?|\S/g;
const MAX_TRIES = 5000;
const MIN_SHARED_TOKENS = 6;
const MIN_SHARED_PART = 0.6;
const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "await", "function"]);

const isTestFile = (file) => file.startsWith("tests/") || /\.test\.\w+$/.test(file);
const isComment = (token) => token.startsWith("//") || token.startsWith("/*");

function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) files.push(...listFiles(dir, file));
    } else files.push(file);
  }
  return files;
}

/** The lines of a file; no lines at all when the file does not exist. */
function readLines(dir, file) {
  const full = path.join(dir, file);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n").split("\n") : [];
}

function writeLines(dir, file, lines) {
  const full = path.join(dir, file);
  if (!lines.length) return fs.rmSync(full, { force: true });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join("\n"));
}

function copyTree(from, to) {
  for (const file of listFiles(from)) writeLines(to, file, readLines(from, file));
}

/** The runs of lines that differ between two versions of a file. Line numbers count from 0; ends are exclusive. */
export function diffHunks(before, after) {
  const common = Array.from({ length: before.length + 1 }, () => new Array(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      common[i][j] = before[i] === after[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const same = (i, j) => i < before.length && j < after.length && before[i] === after[j];
  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (same(i, j)) {
      i++;
      j++;
      continue;
    }
    const hunk = { beforeStart: i, afterStart: j };
    while ((i < before.length || j < after.length) && !same(i, j)) {
      if (j >= after.length || (i < before.length && common[i + 1][j] >= common[i][j + 1])) i++;
      else j++;
    }
    hunks.push({ ...hunk, beforeEnd: i, afterEnd: j });
  }
  return hunks;
}

/** Every edit the change makes to code that is not a test: one per run of changed lines. */
function changeEdits(baseDir, headDir) {
  const files = new Set([...listFiles(baseDir), ...listFiles(headDir)].filter((file) => CODE_FILE.test(file) && !isTestFile(file)));
  const edits = [];
  for (const file of [...files].sort()) {
    const before = readLines(baseDir, file);
    const after = readLines(headDir, file);
    for (const hunk of diffHunks(before, after)) {
      edits.push({ file, ...hunk, removed: before.slice(hunk.beforeStart, hunk.beforeEnd), added: after.slice(hunk.afterStart, hunk.afterEnd) });
    }
  }
  return edits;
}

/** Where an edit sits in the changed file, as a person would point at it. */
function whereIs(edit) {
  const first = edit.afterStart + 1;
  const last = Math.max(edit.afterEnd, first);
  return `${edit.file}:${first === last ? first : `${first}-${last}`}`;
}

const codeTokens = (text) => (text.match(TOKEN) ?? []).filter((token) => !isComment(token));
const sameCode = (linesA, linesB) => codeTokens(linesA.join("\n")).join(" ") === codeTokens(linesB.join("\n")).join(" ");

/** The names of the tests that fail in a folder. Refuses a run in which no test ran. */
function failingTests(dir, testGlob) {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testGlob], { cwd: dir, encoding: "utf8", env });
  const total = Number(/^# tests (\d+)/m.exec(run.stdout ?? "")?.[1] ?? 0);
  if (!total) throw new Error(`no test ran for ${testGlob} in ${dir}: ${(run.stderr ?? "").trim() || run.error?.message || "nothing matched"}`);
  const failed = [...run.stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((match) => match[1]);
  if (run.status !== 0 && !failed.length) throw new Error(`the test run in ${dir} ended with status ${run.status} and named no failing test`);
  return failed;
}

/** Exported functions whose arguments are all numbers or text. An argument with no stated type is tried as a number. */
function plainFunctions(source) {
  const found = [];
  for (const [, name, params] of source.matchAll(/export function (\w+)\s*\(([^)]*)\)/g)) {
    const types = params.trim() ? params.split(",").map((param) => (param.split(":")[1] ?? "number").trim()) : [];
    if (types.every((type) => type === "number" || type === "string")) found.push({ name, types });
  }
  return found;
}

/** Values to try: every number in the given texts and its two neighbours, and every quoted text. */
function probeValues(texts) {
  const numbers = new Set();
  const strings = new Set([""]);
  for (const text of texts) {
    for (const [digits] of text.matchAll(/\b\d+(?:\.\d+)?\b/g)) [0, 1, -1].forEach((step) => numbers.add(Number(digits) + step));
    for (const [, quoted] of text.matchAll(/"([^"\\\n]*)"/g)) strings.add(quoted);
  }
  return { number: [...numbers.add(0).add(-1)], string: [...strings] };
}

function* argumentLists(types, values) {
  if (!types.length) return yield [];
  for (const first of values[types[0]]) {
    for (const rest of argumentLists(types.slice(1), values)) yield [first, ...rest];
  }
}

function outcome(fn, args) {
  try {
    const value = fn(...args);
    return typeof value === "number" ? String(value) : JSON.stringify(value) ?? String(value);
  } catch (error) {
    return `throws ${error?.name ?? "an error"}`;
  }
}

/** Calls each plain function of one file with and without an edit, and reports the first call that ends differently. */
async function behaviourDifference(file, headDir, withoutDir, values) {
  const functions = plainFunctions(readLines(headDir, file).join("\n"));
  if (!functions.length) return { status: "not-tried", why: "no exported function takes only numbers or text" };
  let withEdit;
  let withoutEdit;
  try {
    withEdit = await import(pathToFileURL(path.join(headDir, file)).href);
    withoutEdit = await import(pathToFileURL(path.join(withoutDir, file)).href);
  } catch (error) {
    return { status: "not-tried", why: `the file could not be loaded: ${error.message}` };
  }
  let tries = 0;
  let differing = 0;
  let first = null;
  for (const { name, types } of functions) {
    if (typeof withEdit[name] !== "function" || typeof withoutEdit[name] !== "function") continue;
    let triesHere = 0;
    for (const args of argumentLists(types, values)) {
      if (++triesHere > MAX_TRIES) break;
      tries++;
      const results = { without: outcome(withoutEdit[name], args), with: outcome(withEdit[name], args) };
      if (results.without === results.with) continue;
      differing++;
      first ??= { call: `${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`, ...results };
    }
  }
  return first ? { status: "found", ...first, differing, tries } : { status: "none", tries };
}

/** A line reduced to its shape: names become "$" unless they are being called; numbers, text and signs stay. */
function shapeOf(line) {
  const tokens = codeTokens(line);
  return tokens.map((token, at) => (/^[A-Za-z_$]/.test(token) && tokens[at + 1] !== "(" ? "$" : token));
}

/** The longest run of tokens that two shapes share, in order and without gaps. */
function longestSharedRun(a, b) {
  let best = { length: 0, end: 0 };
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== b[j - 1]) continue;
      row[j] = previous[j - 1] + 1;
      if (row[j] > best.length) best = { length: row[j], end: i };
    }
    previous = row;
  }
  return a.slice(best.end - best.length, best.end);
}

/** A called name, a number or a quoted text: something that tells one line from another. Bare names, signs and control words do not. */
const isTelling = (token) => /^[\w"'`]/.test(token) && !CONTROL_WORDS.has(token);

/** Untouched lines that still have the shape of a line the change replaced. */
function leftBehind(headDir, edits) {
  const replaced = new Set(edits.flatMap((edit) => edit.added.map((_, at) => `${edit.file}:${edit.afterStart + at}`)));
  const files = listFiles(headDir).filter((file) => CODE_FILE.test(file) && !isTestFile(file));
  const found = [];
  for (const edit of edits) {
    for (const oldLine of edit.removed) {
      const oldShape = shapeOf(oldLine);
      const needed = Math.max(MIN_SHARED_TOKENS, Math.ceil(MIN_SHARED_PART * oldShape.length));
      for (const file of files) {
        for (const [at, line] of readLines(headDir, file).entries()) {
          if (replaced.has(`${file}:${at}`)) continue;
          const shared = longestSharedRun(oldShape, shapeOf(line));
          if (shared.length < needed || !shared.some(isTelling)) continue;
          found.push({ where: `${file}:${at + 1}`, line: line.trim(), oldFormOf: whereIs(edit) });
        }
      }
    }
  }
  return found;
}

async function judgeEdit(edit, index, { headDir, testGlob, workDir, values }) {
  const where = whereIs(edit);
  if (sameCode(edit.removed, edit.added)) return { where, verdict: "comment-only" };
  const withoutDir = path.join(workDir, `without-edit-${index + 1}`);
  copyTree(headDir, withoutDir);
  const head = readLines(headDir, edit.file);
  writeLines(withoutDir, edit.file, [...head.slice(0, edit.afterStart), ...edit.removed, ...head.slice(edit.afterEnd)]);
  const neededBy = failingTests(withoutDir, testGlob);
  if (neededBy.length) return { where, verdict: "needed", neededBy };
  return { where, verdict: "passenger", difference: await behaviourDifference(edit.file, headDir, withoutDir, values(edit.file)) };
}

/**
 * Judges one change. `baseDir` holds the code before it, `headDir` the code with it; `workDir` is an
 * empty folder for the copies made here. Neither `baseDir` nor `headDir` is written to.
 */
export async function reviewChange({ baseDir, headDir, testGlob, workDir }) {
  const failedOnChange = failingTests(headDir, testGlob);
  if (failedOnChange.length) return { testsPass: false, failedOnChange, edits: [], leftBehind: [] };
  const edits = changeEdits(baseDir, headDir);
  const testTexts = listFiles(headDir).filter(isTestFile).map((file) => readLines(headDir, file).join("\n"));
  const values = (file) => probeValues([...testTexts, readLines(baseDir, file).join("\n"), readLines(headDir, file).join("\n")]);
  const judged = [];
  for (const [index, edit] of edits.entries()) judged.push(await judgeEdit(edit, index, { headDir, testGlob, workDir, values }));
  return { testsPass: true, failedOnChange: [], edits: judged, leftBehind: leftBehind(headDir, edits) };
}

/** True when the check gives a person something to answer before the change can be approved. */
export const raisesQuestion = (review) => review.testsPass && (review.leftBehind.length > 0 || review.edits.some((edit) => edit.verdict === "passenger"));

function describeDifference(difference) {
  if (difference.status === "found") {
    return `changes behaviour: ${difference.call} gave "${difference.without}" without it and "${difference.with}" with it (${difference.differing} of ${difference.tries} calls differ)`;
  }
  if (difference.status === "none") return `no difference found in ${difference.tries} calls (not proof that there is none)`;
  return `behaviour not compared: ${difference.why}`;
}

export function describeReview(review) {
  if (!review.testsPass) return [`tests fail on the change (${review.failedOnChange.length}); nothing to take out`];
  const lines = review.edits.map((edit) => {
    if (edit.verdict === "comment-only") return `${edit.where}  comment or layout only`;
    if (edit.verdict === "needed") return `${edit.where}  needed: ${edit.neededBy.length} test(s) fail without it, first "${edit.neededBy[0]}"`;
    return `${edit.where}  PASSENGER: no test fails without it; ${describeDifference(edit.difference)}`;
  });
  for (const twin of review.leftBehind) lines.push(`${twin.where}  LEFT BEHIND: still has the old form of ${twin.oldFormOf}: ${twin.line}`);
  return lines.length ? lines : ["no code edits"];
}

function plant(dir, fault) {
  const lines = readLines(dir, fault.file);
  const text = lines.join("\n");
  if (!text.includes(fault.find)) return false;
  writeLines(dir, fault.file, text.replace(fault.find, fault.replace).split("\n"));
  return true;
}

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

async function runCase(app, sample, work) {
  const baseDir = path.join(work, "base");
  const headDir = path.join(work, "head");
  copyTree(path.join(app, "sample", "base"), baseDir);
  copyTree(path.join(app, "sample", "base"), headDir);
  for (const overlay of sample.overlays) copyTree(path.join(app, "sample", "commits", overlay), headDir);
  if (sample.baseFault && !plant(baseDir, sample.baseFault)) throw new Error(`${sample.name}: fault ${sample.baseFault.id} does not apply to the base`);
  if (sample.headFault && !plant(headDir, sample.headFault)) return null;
  return reviewChange({ baseDir, headDir, testGlob: "tests/**/*.test.ts", workDir: path.join(work, "copies") });
}

async function main() {
  const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const unexpected = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "too-little-too-much-"));
  const tally = {};
  try {
    for (const [index, sample] of sampleCases(path.resolve(app)).entries()) {
      const review = await runCase(path.resolve(app), sample, path.join(root, `case-${index + 1}`));
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
