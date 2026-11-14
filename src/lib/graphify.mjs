import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileAt } from "./git.mjs";
import { DATA, DEMO } from "./paths.mjs";

const EXPORTS = path.join(DATA, "graphify");
export const GRAPHIFY_COMMAND = "GRAPHIFY_BACKEND=none graphify extract . --code-only --out <outside the tree>";

export function graphifyBin() {
  const exe = process.platform === "win32" ? "graphify.exe" : "graphify";
  const local = path.join(os.homedir(), ".local", "bin", exe);
  return fs.existsSync(local) ? local : exe;
}

export function graphifyAvailable() {
  const r = spawnSync(graphifyBin(), ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Run Graphify on a clean snapshot of one commit. Saves the export with its SHA. */
export function runGraphify(sha, snapshotDir) {
  const outDir = path.join(DEMO, "graphify-work", sha);
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(graphifyBin(), ["extract", ".", "--code-only", "--out", outDir], {
    cwd: snapshotDir,
    encoding: "utf8",
    env: { ...process.env, GRAPHIFY_BACKEND: "none", PYTHONUTF8: "1" },
  });
  const graphFile = path.join(outDir, "graphify-out", "graph.json");
  if (r.status !== 0 || !fs.existsSync(graphFile)) {
    throw new Error(`graphify failed for ${sha}: ${r.stderr || r.stdout}`);
  }
  const graph = JSON.parse(fs.readFileSync(graphFile, "utf8"));
  // Graphify stamps the Git HEAD it finds above the snapshot. That is this
  // project's commit, not the sample's. Drop it; `revision` is authoritative.
  delete graph.built_at_commit;
  const record = {
    revision: sha,
    tool: "graphify",
    graphifyVersion: graph.graph?.graphify_version ?? null,
    schemaVersion: graph.graph?.schema_version ?? null,
    command: GRAPHIFY_COMMAND,
    graph,
  };
  fs.mkdirSync(EXPORTS, { recursive: true });
  fs.writeFileSync(path.join(EXPORTS, `${sha}.json`), JSON.stringify(record, null, 1) + "\n");
  return record;
}

export function loadExport(sha) {
  const file = path.join(EXPORTS, `${sha}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

const lineOf = (loc) => (loc ? Number(String(loc).replace(/^L/, "")) : null);
const isCode = (file) => /^(src|tests)\/.+\.ts$/.test(file ?? "");

/** End line of the block that opens at or after `startLine` (brace matching). */
export function blockEnd(lines, startLine) {
  let depth = 0;
  let seen = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") depth--;
    }
    if (seen && depth <= 0) return i + 1;
  }
  return startLine;
}

/**
 * Adapter: Graphify export -> shared index with stable IDs.
 * IDs are `fn:<file>#<name>`, so a symbol keeps its ID across commits.
 * Graphify's EXTRACTED / INFERRED labels are kept on every edge.
 */
export function loadIndex(sha) {
  const record = loadExport(sha);
  if (!record) return null;
  const { nodes, links } = record.graph;
  const byGraphifyId = new Map();
  const symbols = [];
  const files = new Set();
  const sourceCache = new Map();
  const linesOf = (file) => {
    if (!sourceCache.has(file)) sourceCache.set(file, (readFileAt(sha, file) ?? "").split("\n"));
    return sourceCache.get(file);
  };

  for (const n of nodes) {
    if (!isCode(n.source_file)) continue;
    files.add(n.source_file);
    if (!n._callable) {
      byGraphifyId.set(n.id, { kind: "file", file: n.source_file });
      continue;
    }
    const isType = Boolean(n._callable_class);
    const name = n.label.replace(/\(\)$/, "");
    const line = lineOf(n.source_location);
    const sym = {
      id: `${isType ? "type" : "fn"}:${n.source_file}#${name}`,
      kind: isType ? "type" : "function",
      name,
      file: n.source_file,
      line,
      endLine: blockEnd(linesOf(n.source_file), line),
      graphifyId: n.id,
    };
    symbols.push(sym);
    byGraphifyId.set(n.id, { kind: "symbol", symbol: sym });
  }

  const calls = [];
  const imports = [];
  const unresolved = [];
  for (const e of links) {
    const a = byGraphifyId.get(e.source);
    const b = byGraphifyId.get(e.target);
    if (e.relation === "calls" && a?.kind === "symbol" && b?.kind === "symbol") {
      // The export is undirected. The call site lives in the caller's file,
      // so orient the edge by where the call site is.
      const line = lineOf(e.source_location);
      let from = a.symbol;
      let to = b.symbol;
      const inA = a.symbol.file === e.source_file && line >= a.symbol.line && line <= a.symbol.endLine;
      const inB = b.symbol.file === e.source_file && line >= b.symbol.line && line <= b.symbol.endLine;
      if (!inA && inB) [from, to] = [to, from];
      calls.push({ from: from.id, to: to.id, file: e.source_file, line, confidence: e.confidence ?? "EXTRACTED" });
    } else if (e.relation === "imports" || e.relation === "imports_from") {
      if (!isCode(e.source_file)) continue;
      // The importing file is the endpoint that is the file node of the edge's source file.
      const other = a?.kind === "file" && a.file === e.source_file ? e.target : e.source;
      const target = byGraphifyId.get(other);
      if (!target) {
        // A boundary the index cannot see into (for example node:test).
        if (e.relation === "imports_from") unresolved.push({ file: e.source_file, line: lineOf(e.source_location), target: other });
        continue;
      }
      if (e.relation === "imports" && target.kind === "symbol") {
        imports.push({ fromFile: e.source_file, to: target.symbol.id, line: lineOf(e.source_location), confidence: e.confidence ?? "EXTRACTED" });
      }
    }
  }

  return {
    revision: sha,
    tool: "graphify",
    graphifyVersion: record.graphifyVersion,
    schemaVersion: record.schemaVersion,
    files: [...files].sort(),
    symbols: symbols.sort((x, y) => x.id.localeCompare(y.id)),
    calls,
    imports,
    unresolved,
  };
}
