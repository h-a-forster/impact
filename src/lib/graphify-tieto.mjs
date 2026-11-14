// The Impact map graph for a Tieto PR, built from a saved Graphify export.
//
// Graphify 0.9.108 was run on a clone of the Tieto repo at each PR's head commit
// (scripts/graphify-tieto.mjs). A slice of each graph.json is saved under
// data/graphify/tieto/. This file turns a slice into the node / edge shape the UI
// already uses. It never adds a link Graphify did not write. The only links that
// are not Graphify's are the PR's own ("this PR edits X", from the diff).
import fs from "node:fs";
import path from "node:path";
import { conceptOf } from "./ledger.mjs";
import { DATA } from "./paths.mjs";

const DIR = path.join(DATA, "graphify", "tieto");
const cache = new Map();
const readJson = (file) => {
  if (!cache.has(file)) cache.set(file, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
  return cache.get(file);
};
export const loadTietoSlice = (sha) => readJson(path.join(DIR, `${sha}.json`));
export const loadBaseLinks = () => readJson(path.join(DIR, "base-links.json"));

export const lineOf = (loc) => (loc ? Number(String(loc).replace(/^L/, "")) : null);
/** Graphify labels methods and constructors "Type.Name()". Types and files have no "()". */
export const isFunctionNode = (n) => Boolean(n?.source_file) && n.file_type === "code" && /\(\)$/.test(n.label ?? "");

/**
 * End line of the C# member that starts at `start` (1-based). Graphify gives no end line.
 * Handles `{ ... }` bodies, `=> expr;` bodies and `void F();` declarations.
 * `nextStart` (the next symbol in the file) is only a fallback bound.
 */
export function memberEnd(lines, start, nextStart) {
  let braces = 0, parens = 0, seenBrace = false, arrow = false;
  for (let i = start - 1; i < lines.length; i++) {
    const text = lines[i].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'/g, '""').replace(/\/\/.*$/, "");
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (ch === "(" || ch === "[") parens++;
      else if (ch === ")" || ch === "]") parens--;
      else if (ch === "=" && text[k + 1] === ">" && braces === 0 && parens === 0 && !seenBrace) arrow = true;
      else if (ch === "{") {
        braces++;
        seenBrace = true;
      } else if (ch === "}") {
        braces--;
        if (!arrow && seenBrace && braces <= 0) return i + 1;
      } else if (ch === ";" && braces <= 0 && parens <= 0) return i + 1;
    }
  }
  return nextStart ? Math.max(start, nextStart - 1) : start;
}

/** Line numbers (in the new file) that a diff touches. A removed line counts at the line that took its place. */
function changedLines(patch) {
  const out = new Set();
  let n = 0;
  for (const raw of patch.split("\n")) {
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (head) n = Number(head[1]);
    else if (raw[0] === "+") out.add(n++);
    else if (raw[0] === "-") out.add(n);
    else n++;
  }
  return out;
}

const WHY_MISSED = {
  field: "It is a field, not a function. Graphify maps functions, types and files.",
  fieldUse: "It only reads or writes a field the PR changed. Graphify has no links for field use.",
  other: "Graphify did not find a call from it to the edited code.",
};

/**
 * @param m     the recorded model (buildLedgerModel): diff, recorded graph, concepts
 * @param sha   the PR's head commit
 * @returns { nodes, edges, info } in the UI's graph shape, or null when no slice is saved
 */
export function graphifyGraph(m, sha) {
  const slice = loadTietoSlice(sha);
  if (!slice) return null;
  const pr = m.pr;
  const concepts = readJson(path.join(DATA, "tieto", "concepts.json")).concepts;
  const recorded = m.graph.nodes.filter((n) => n.level === "function" && n.type === "function");
  const diffOf = new Map(m.diff.files.map((f) => [f.file, f]));
  const changed = new Map([...diffOf].filter(([, f]) => !f.isTest).map(([file, f]) => [file, changedLines(f.patch)]));

  // ---- Functions: Graphify's function nodes, with a line range each ----
  const fns = new Map();
  for (const n of slice.graph.nodes) {
    if (!isFunctionNode(n)) continue;
    const line = lineOf(n.source_location);
    const rec = recorded.find((r) => r.file === n.source_file && r.line === line && r.memberKind !== "written-member");
    fns.set(n.id, { g: n, rec, file: n.source_file, line, endLine: rec?.endLine ?? slice.adapter.endLines[n.id] ?? line });
  }
  const touched = (f) => {
    const lines = changed.get(f.file);
    if (!lines) return false;
    for (const l of lines) if (l >= f.line && l <= f.endLine) return true;
    return false;
  };
  const edited = new Set([...fns].filter(([, f]) => touched(f)).map(([id]) => id));

  // ---- Calls. The export is undirected, so the call site decides who the caller is. ----
  const calls = [];
  for (const e of slice.graph.links) {
    if (e.relation !== "calls") continue;
    let a = fns.get(e.source), b = fns.get(e.target);
    if (!a || !b || a === b) continue;
    const site = lineOf(e.source_location);
    const holds = (f) => f.file === e.source_file && site >= f.line && site <= f.endLine;
    if (!holds(a) && holds(b)) [a, b] = [b, a];
    calls.push({ from: a.g.id, to: b.g.id, file: e.source_file, line: site, confidence: e.confidence ?? "EXTRACTED", score: e.confidence_score ?? null });
  }
  // Affected: not edited, calls edited code. Context: what the edited code calls.
  const affected = new Set(calls.filter((c) => edited.has(c.to) && !edited.has(c.from)).map((c) => c.from));
  const context = new Set(calls.filter((c) => edited.has(c.from) && !edited.has(c.to) && !affected.has(c.to)).map((c) => c.to));
  const drawn = new Set([...edited, ...affected, ...context]);
  const idOf = (gid) => fns.get(gid).rec?.id ?? `gfy:${gid}`;

  const nodes = [];
  const edges = [];
  for (const gid of drawn) {
    const f = fns.get(gid);
    const state = edited.has(gid) ? "edited" : affected.has(gid) ? "downstream" : "none";
    nodes.push({
      id: idOf(gid), level: "function", type: "function", label: f.g.label.split(".").pop(), sub: `${f.file.split("/").pop()}:${f.line}`,
      file: f.file, line: f.line, endLine: f.endLine, parent: `file:${f.file}`, concept: conceptOf(f.file, concepts).id,
      state, evidence: f.rec?.evidence ?? null, change: f.rec?.change ?? null, rowIds: f.rec?.rowIds ?? [],
      graphifyId: gid, fullName: f.g.label, inDiff: diffOf.has(f.file),
    });
  }
  const tool = `Graphify ${slice.graphifyVersion}`;
  for (const c of calls) {
    if (!drawn.has(c.from) || !drawn.has(c.to) || !(edited.has(c.from) || edited.has(c.to))) continue;
    const inferred = c.confidence !== "EXTRACTED";
    edges.push({
      id: `calls|${idOf(c.from)}|${idOf(c.to)}`, level: "function", from: idOf(c.from), to: idOf(c.to), kind: "calls", relation: "calls",
      confidence: c.confidence, score: c.score, resolution: inferred ? "inferred" : "resolved", mapper: tool,
      // The side panel can only show code for files the PR changes.
      anchor: diffOf.has(c.file) && c.line ? { file: c.file, line: c.line } : null, site: c.line ? `${c.file}:${c.line}` : null, change: null,
    });
  }
  const fnNodes = [...nodes];
  const fnEdges = [...edges];

  // ---- Files and concepts: the recorded boxes for changed files, plus the files Graphify reached ----
  const roll = (members, self) => (self || members.some((x) => x.state === "edited") ? "edited" : members.some((x) => x.state === "downstream") ? "downstream" : "none");
  const counts = (members) => ({ edited: members.filter((x) => x.state === "edited").length, downstream: members.filter((x) => x.state === "downstream").length, unverified: 0 });
  const worst = (members) => (members.some((x) => x.evidence === "contradicted") ? "contradicted" : null);
  const fileNodes = [];
  for (const r of m.graph.nodes.filter((n) => n.level === "file" && n.type !== "pr" && n.type !== "requirement")) {
    const members = fnNodes.filter((x) => x.file === r.file);
    fileNodes.push({ ...r, members: members.map((x) => x.id), state: r.type === "testfile" ? "none" : roll(members, true), evidence: worst(members), counts: counts(members) });
  }
  for (const file of new Set(fnNodes.map((x) => x.file))) {
    if (fileNodes.some((x) => x.file === file)) continue;
    const members = fnNodes.filter((x) => x.file === file);
    const cid = conceptOf(file, concepts).id;
    fileNodes.push({
      id: `file:${file}`, level: "file", type: "file", label: file.split("/").pop(), sub: file, file, line: 1, parent: cid, concept: cid,
      members: members.map((x) => x.id), state: roll(members, false), evidence: worst(members), counts: counts(members), fileChanged: diffOf.has(file), indexed: true,
    });
  }
  const conceptNodes = [];
  for (const r of m.graph.nodes.filter((n) => n.level === "concept" && n.type === "concept")) {
    const members = fnNodes.filter((x) => x.concept === r.id);
    conceptNodes.push({ ...r, members: fileNodes.filter((x) => x.concept === r.id).map((x) => x.id), evidence: worst(members), counts: counts(members) });
  }
  for (const cid of new Set(fileNodes.map((x) => x.concept))) {
    if (conceptNodes.some((x) => x.id === cid)) continue;
    const files = fileNodes.filter((x) => x.concept === cid);
    const members = fnNodes.filter((x) => x.concept === cid);
    const info = conceptOf(files[0].file, concepts);
    conceptNodes.push({
      id: cid, level: "concept", type: "concept", label: info.label, sub: "no changed file", labelled: info.labelled, members: files.map((x) => x.id),
      state: roll(members, false), evidence: worst(members), counts: counts(members),
    });
  }
  nodes.push(...fileNodes, ...conceptNodes);

  // Function links rolled up. A rolled-up link is "inferred" only when every link under it is.
  const rollUp = (level, keyOf) => {
    const seen = new Map();
    for (const e of fnEdges) {
      const from = keyOf(fnNodes.find((x) => x.id === e.from)), to = keyOf(fnNodes.find((x) => x.id === e.to));
      if (from === to) continue;
      const r = seen.get(`${from}>${to}`) ?? seen.set(`${from}>${to}`, { id: `calls|${from}|${to}`, level, from, to, kind: "calls", relation: "calls", count: 0, extracted: 0, mapper: tool, anchor: null, change: null }).get(`${from}>${to}`);
      r.count += 1;
      if (e.resolution === "resolved") r.extracted += 1;
    }
    for (const r of seen.values()) {
      r.resolution = r.extracted ? "resolved" : "inferred";
      r.confidence = r.extracted ? "EXTRACTED" : "INFERRED";
      edges.push(r);
    }
  };
  rollUp("file", (x) => `file:${x.file}`);
  rollUp("concept", (x) => x.concept);

  // ---- The PR and its requirement, with "edits" links from the diff (not from Graphify) ----
  for (const level of ["function", "file", "concept"]) {
    for (const n of m.graph.nodes.filter((x) => x.level === level && (x.type === "pr" || x.type === "requirement"))) nodes.push(n);
    edges.push(...m.graph.edges.filter((e) => e.level === level && e.kind === "implements"));
    for (const n of nodes.filter((x) => x.level === level && x.state === "edited")) edges.push({ id: `edits|${n.id}`, level, from: `pr:${pr.id}`, to: n.id, kind: "edits", confidence: "git diff", resolution: "resolved" });
  }

  // ---- What the recorded compiler check (Roslyn) has that Graphify does not ----
  const drawnRec = new Set(fnNodes.map((x) => x.id));
  const missed = recorded.filter((r) => !drawnRec.has(r.id)).map((r) => {
    const mine = m.graph.edges.filter((e) => e.level === "function" && e.kind === "calls" && (e.from === r.id || e.to === r.id));
    const why = r.memberKind === "written-member" ? "field" : mine.length && mine.every((e) => e.relation !== "calls") ? "fieldUse" : "other";
    return { id: r.id, label: r.label, file: r.file, line: r.line, kind: r.memberKind, why, reason: WHY_MISSED[why] };
  });
  const recCalls = m.graph.edges.filter((e) => e.level === "function" && e.relation === "calls");
  const missedCalls = recCalls.filter((e) => !fnEdges.some((g) => g.from === e.from && g.to === e.to)).map((e) => ({ from: e.from, to: e.to }));
  return {
    nodes,
    edges,
    info: {
      tool,
      revision: slice.revision,
      command: slice.command,
      full: slice.slice.full,
      kept: slice.slice.kept,
      drawn: { functions: fnNodes.length, links: fnEdges.length, extracted: fnEdges.filter((e) => e.resolution === "resolved").length, inferred: fnEdges.filter((e) => e.resolution === "inferred").length },
      missed,
      missedCalls,
      added: fnNodes.filter((x) => x.state === "downstream" && x.id.startsWith("gfy:")).map((x) => ({ id: x.id, label: x.label, file: x.file, line: x.line })),
    },
  };
}
