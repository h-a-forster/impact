// Blast radius, second half: unit tests run both ways.
//   - the tests a blast-radius agent wrote, on the old code and on the real change
//     (does a test written blind notice the bug, and does the real change pass it?)
//   - the tests the real change added, on the old code and on each agent's fix
//     (a test that every blind fix fails marks behaviour only the real change has)
// Needs a .NET SDK on PATH and a clone of the sample repository that has the base and the real commit:
//   node scripts/blast-tests.mjs <path to the clone> [pr id]
// It adds git worktrees in a folder "bt" next to the clone (short names: the sample has file paths
// close to the Windows length limit) and writes data/tieto/<pr>/blast-tests.json.
// Nothing is committed or pushed. No model is called.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const isTestFile = (file) => /(^|\/)tests\/.*Tests?\.cs$/.test(file);
const className = (file) => path.basename(file, ".cs");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** One file of a recorded run as a patch `git apply` accepts. */
function asPatch(file) {
  const head = file.status === "A" ? `new file mode 100644\n--- /dev/null\n+++ b/${file.file}` : `--- a/${file.file}\n+++ b/${file.file}`;
  return `diff --git a/${file.file} b/${file.file}\n${head}\n${file.patch.endsWith("\n") ? file.patch : file.patch + "\n"}`;
}

/** A worktree at `commit` with the given recorded files applied and the given files taken from another commit. */
function makeTree(clone, work, name, commit, { apply = [], takeFrom = null, take = [] } = {}) {
  const dir = path.join(work, name);
  if (fs.existsSync(dir)) run("git", ["worktree", "remove", "--force", dir], clone);
  const added = run("git", ["-c", "core.longpaths=true", "worktree", "add", "--detach", dir, commit], clone);
  if (!added.ok) return { error: `cannot check out ${commit.slice(0, 7)}: ${(added.out.match(/^(error|fatal): [^\r\n]{0,120}/m) ?? ["git worktree add failed"])[0]}` };
  if (apply.length) {
    const patchFile = path.join(work, `${name}.patch`);
    fs.writeFileSync(patchFile, apply.map(asPatch).join(""));
    const applied = run("git", ["apply", "--whitespace=nowarn", patchFile], dir);
    if (!applied.ok) return { error: `the recorded change does not apply: ${applied.out.trim().split("\n")[0]}` };
  }
  if (take.length && !run("git", ["checkout", takeFrom, "--", ...take], dir).ok) return { error: "cannot take the unit test files" };
  return { dir };
}

function projectOf(dir, testFile) {
  for (let at = path.dirname(testFile); at !== "."; at = path.dirname(at)) {
    if (fs.readdirSync(path.join(dir, at)).some((f) => f.endsWith(".csproj"))) return at;
  }
  throw new Error(`no project found above ${testFile}`);
}

/** Runs the unit tests of the given classes and reads each test's outcome from the result file. */
function runTests(tree, work, id, testFiles) {
  if (tree.error) return { ran: false, why: tree.error };
  const trx = path.join(work, `${id}.trx`);
  fs.rmSync(trx, { force: true });
  const filter = testFiles.map((f) => `FullyQualifiedName~${className(f)}`).join("|");
  const r = run("dotnet", ["test", projectOf(tree.dir, testFiles[0]), "-c", "Debug", "--filter", filter, "--logger", `trx;LogFileName=${trx}`], tree.dir);
  if (!fs.existsSync(trx)) return { ran: false, why: (r.out.match(/error [A-Z]+\d+: [^\r\n]{0,160}/) ?? ["the unit tests did not build or run"])[0] };
  const xml = fs.readFileSync(trx, "utf8");
  // A passed test is a self-closing element; a failed one has its message inside.
  const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#xD;|&#xA;/g, "\n").replace(/&amp;/g, "&");
  const results = [...xml.matchAll(/<UnitTestResult\b([^>]*?)(\/?)>/g)].map((m) => {
    const body = m[2] ? "" : xml.slice(m.index, xml.indexOf("</UnitTestResult>", m.index));
    const message = (body.match(/<Message>([\s\S]*?)<\/Message>/) ?? [])[1] ?? "";
    return { name: unescape(m[1].match(/testName="([^"]*)"/)[1]), passed: m[1].match(/outcome="([^"]*)"/)[1] === "Passed", message: unescape(message).trim().split(/\r?\n/)[0] };
  });
  return { ran: true, total: results.length, passed: results.filter((t) => t.passed).length, failed: results.filter((t) => !t.passed).map(({ name, message }) => ({ name, message })) };
}

function main(argv) {
  const clone = argv[0] && path.resolve(argv[0]);
  const prId = argv[1] ?? "ju26-issue-2283";
  const recordFile = path.join(ROOT, "data", "tieto", prId, "blast.json");
  if (!clone || !fs.existsSync(path.join(clone, ".git")) || !fs.existsSync(recordFile)) {
    console.error("usage: node scripts/blast-tests.mjs <path to a clone of the sample repository> [pr id]");
    return 2;
  }
  const sdk = run("dotnet", ["--version"], clone);
  if (!sdk.ok) {
    console.error("A .NET SDK is needed on PATH (dotnet --version failed).");
    return 2;
  }
  const rec = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  const work = path.join(path.dirname(clone), "bt");
  fs.mkdirSync(work, { recursive: true });
  const realTests = rec.real.files.map((f) => f.file).filter(isTestFile);
  const runs = [];
  const record = (id, on, tests, by, tree, testFiles) => {
    console.log(`running ${id}`);
    runs.push({ id, on, tests, by, classes: testFiles.map(className), ...runTests(tree, work, id, testFiles) });
  };

  for (const agent of rec.runs) {
    const own = agent.files.filter((f) => isTestFile(f.file));
    if (!own.length) continue;
    const files = own.map((f) => f.file);
    record(`base-vs-${agent.id}-tests`, "base", "agent", agent.id, makeTree(clone, work, `b-${agent.id}`, rec.base, { apply: own }), files);
    record(`real-vs-${agent.id}-tests`, "real", "agent", agent.id, makeTree(clone, work, `r-${agent.id}`, rec.real.head, { apply: own }), files);
  }
  if (realTests.length) {
    const withReal = { takeFrom: rec.real.head, take: realTests };
    record("base-vs-real-tests", "base", "real", null, makeTree(clone, work, "b-real", rec.base, withReal), realTests);
    for (const agent of rec.runs) {
      record(`${agent.id}-fix-vs-real-tests`, agent.id, "real", null, makeTree(clone, work, agent.id, rec.base, { apply: agent.files, ...withReal }), realTests);
    }
  }
  const out = {
    schema: "impact-map/blast-tests/v1",
    pr: prId,
    recordedAt: new Date().toISOString(),
    sdk: sdk.out.trim(),
    base: rec.base,
    real: rec.real.head,
    how: "node scripts/blast-tests.mjs: git worktrees of the sample repository, the recorded changes applied with git apply, then dotnet test with a filter on the unit test classes. Run on a machine with a .NET SDK, not the one that recorded the agent runs.",
    runs,
  };
  fs.writeFileSync(path.join(ROOT, "data", "tieto", prId, "blast-tests.json"), JSON.stringify(out, null, 2) + "\n");
  for (const r of runs) console.log(`${r.id}: ${r.ran ? `${r.passed} of ${r.total} passed` : `not run (${r.why})`}`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
