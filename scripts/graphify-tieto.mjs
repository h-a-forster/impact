// Run Graphify on the Tieto repo and save what the demo needs, so the Impact map
// can replay it offline.
//
//   node scripts/graphify-tieto.mjs <path to a clone of the Tieto repo> [--raw <dir>]
//
// Needs: git, and Graphify 0.9.108 (`uv tool install graphifyy --python 3.12`).
// For the base commit and the head commit of each of the 4 demo PRs it runs
//   GRAPHIFY_BACKEND=none graphify extract . --code-only --out <outside the tree>
// A full export is about 14 MB per commit (9,500 nodes), so only a slice is saved:
//   data/graphify/tieto/<head sha>.json   the part of graph.json around the PR's changed code
//   data/graphify/tieto/base-links.json   file-to-file call counts for the whole repo (Full map)
// Nodes and links in a slice are copied from Graphify's graph.json as they are.
// What this script adds sits under "adapter" and is labelled as ours.
// `--raw <dir>` keeps (and reuses) the full exports in <dir>/raw-<sha>/graphify-out/graph.json.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA } from "../src/lib/paths.mjs";
import { GRAPHIFY_COMMAND, graphifyBin } from "../src/lib/graphify.mjs";
import { isFunctionNode, lineOf, memberEnd } from "../src/lib/graphify-tieto.mjs";

const repo = process.argv[2];
if (!repo || !fs.existsSync(path.join(repo, ".git"))) {
  console.error("Usage: node scripts/graphify-tieto.mjs <path to a clone of te-industry-tech-office/junction26-messagepack-csharp> [--raw <dir>]");
  process.exit(1);
}
const rawArg = process.argv.indexOf("--raw");
const rawDir = rawArg > 0 ? path.resolve(process.argv[rawArg + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), "graphify-tieto-"));
const OUT = path.join(DATA, "graphify", "tieto");
const index = JSON.parse(fs.readFileSync(path.join(DATA, "tieto", "index.json"), "utf8"));
const git = (...args) => {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

function fullExport(sha) {
  const file = path.join(rawDir, `raw-${sha}`, "graphify-out", "graph.json");
  if (!fs.existsSync(file)) {
    console.log(`Graphify: indexing ${sha.slice(0, 8)} (about a minute)…`);
    git("checkout", "-q", "-f", sha);
    const r = spawnSync(graphifyBin(), ["extract", ".", "--code-only", "--out", path.join(rawDir, `raw-${sha}`)], {
      cwd: repo, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, GRAPHIFY_BACKEND: "none", PYTHONUTF8: "1" },
    });
    if (r.status !== 0 || !fs.existsSync(file)) throw new Error(`graphify failed for ${sha}: ${r.stderr || r.stdout}`);
  }
  const graph = JSON.parse(fs.readFileSync(file, "utf8"));
  // Graphify stamps the HEAD it finds. Here that is the right repo, but `revision` is the one we trust.
  delete graph.built_at_commit;
  return graph;
}
const linesAt = (sha, file) => git("show", `${sha}:${file}`).split("\n");

/** End line of every function node in the given files (Graphify gives start lines only). */
function endLines(sha, graph, files) {
  const out = {};
  for (const file of files) {
    const starts = graph.nodes.filter((n) => n.source_file === file && lineOf(n.source_location)).map((n) => lineOf(n.source_location)).sort((a, b) => a - b);
    let lines = null;
    for (const n of graph.nodes) {
      if (n.source_file !== file || !isFunctionNode(n)) continue;
      lines ??= linesAt(sha, file);
      const start = lineOf(n.source_location);
      out[n.id] = memberEnd(lines, start, starts.find((s) => s > start) ?? null);
    }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
const write = (name, body) => {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(body, null, 1) + "\n");
  console.log(`wrote data/graphify/tieto/${name} (${Math.round(fs.statSync(path.join(OUT, name)).size / 1024)} KB)`);
};
const meta = (graph, sha) => ({
  revision: sha,
  tool: "graphify",
  graphifyVersion: graph.graph?.graphify_version ?? null,
  schemaVersion: graph.graph?.schema_version ?? null,
  command: GRAPHIFY_COMMAND,
  repo: index.repo,
});

for (const change of index.changes) {
  const pack = JSON.parse(fs.readFileSync(path.join(DATA, "tieto", change.id, "pack.json"), "utf8"));
  const graph = fullExport(change.head);
  // Seeds: the functions in the changed code files. Unit test files are left out
  // (PR #4 changes 223 of them); a unit test that calls a seed still comes in as a caller.
  const seedFiles = new Set(pack.files.filter((f) => f.language === "csharp" && !f.is_test && f.status !== "deleted").map((f) => f.path));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const keep = new Set(graph.nodes.filter((n) => seedFiles.has(n.source_file)).map((n) => n.id));
  const seedFns = new Set([...keep].filter((id) => isFunctionNode(byId.get(id))));
  // One step out along "calls" links, both ways: who calls a seed, and what a seed calls.
  for (const e of graph.links) {
    if (e.relation !== "calls") continue;
    const a = byId.get(e.source), b = byId.get(e.target);
    if (!a || !b || !isFunctionNode(a) || !isFunctionNode(b)) continue;
    if (seedFns.has(e.source)) keep.add(e.target);
    if (seedFns.has(e.target)) keep.add(e.source);
  }
  const nodes = graph.nodes.filter((n) => keep.has(n.id));
  const links = graph.links.filter((e) => keep.has(e.source) && keep.has(e.target));
  write(`${change.head}.json`, {
    ...meta(graph, change.head),
    pr: change.id,
    slice: {
      note: "A slice of Graphify's graph.json, not the whole file. Nodes and links are copied as Graphify wrote them.",
      rule: "Every node in a changed C# code file (unit test files left out), plus every function one 'calls' link away from a function in those files, plus every link between kept nodes.",
      seedFiles: [...seedFiles].sort(),
      kept: { nodes: nodes.length, links: links.length },
      full: { nodes: graph.nodes.length, links: graph.links.length },
    },
    adapter: {
      note: "Added by scripts/graphify-tieto.mjs, not by Graphify. Graphify gives a start line only; the end line is found by matching braces in the file at this commit.",
      endLines: endLines(change.head, graph, new Set(nodes.map((n) => n.source_file).filter(Boolean))),
    },
    graph: { directed: graph.directed, multigraph: graph.multigraph, graph: graph.graph, nodes, links, hyperedges: [] },
  });
}

// Whole repo at the base commit: how many "calls" links run from one file to another.
const base = index.changes[0].base;
const graph = fullExport(base);
const byId = new Map(graph.nodes.map((n) => [n.id, n]));
const pairs = new Map();
for (const e of graph.links) {
  if (e.relation !== "calls") continue;
  const a = byId.get(e.source), b = byId.get(e.target);
  // The call site is in the caller's file.
  if (!a?.source_file || !b?.source_file || a.source_file === b.source_file || !isFunctionNode(a) || !isFunctionNode(b)) continue;
  const [from, to] = e.source_file === b.source_file && e.source_file !== a.source_file ? [b.source_file, a.source_file] : [a.source_file, b.source_file];
  const key = `${from}>${to}`;
  const p = pairs.get(key) ?? pairs.set(key, { from, to, extracted: 0, inferred: 0 }).get(key);
  p[e.confidence === "EXTRACTED" ? "extracted" : "inferred"] += 1;
}
write("base-links.json", {
  ...meta(graph, base),
  note: "Rolled up from Graphify's graph.json for the base commit: for each pair of files, the number of 'calls' links between functions, split by Graphify's EXTRACTED / INFERRED label.",
  full: { nodes: graph.nodes.length, links: graph.links.length, calls: graph.links.filter((e) => e.relation === "calls").length },
  fileLinks: [...pairs.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to)),
});
git("checkout", "-q", "-f", index.changes[0].head);
