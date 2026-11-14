import fs from "node:fs";
import path from "node:path";
import { changedFiles as gitChangedFiles, changedLineRanges, readFileAt, unifiedDiff } from "./git.mjs";
import { loadIndex } from "./graphify.mjs";
import { mapTests, TEST_MAPPER_LABEL } from "./testmap.mjs";
import { loadBaseRun, loadRun } from "./runner.mjs";
import { buildLedgerModel, ledgerPrs } from "./ledger.mjs";
import { classifier1, classifier2, loadApprovedPolicy } from "./classifier.mjs";
import { CLAIM_VERIFIER_LABEL, verifyClaims } from "./claims.mjs";
import { buildReviewInput, finalizeReview, loadReview } from "./reviewer.mjs";
import { BRIEFS, DATA, REVISIONS_FILE, ROOT } from "./paths.mjs";

const short = (sha) => (sha ?? "").slice(0, 7);
const concepts = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "concepts.json"), "utf8")).groups;

/**
 * All pull requests the map can show:
 *  - the shop sample (built and analysed here), and
 *  - the real Tieto sample PRs (recorded packs from the Impact Ledger project, data/tieto/).
 */
export function loadRevisions() {
  const revisions = JSON.parse(fs.readFileSync(REVISIONS_FILE, "utf8"));
  const shop = revisions.prs.map((p) => ({ ...p, repo: revisions.github.fullName, source: "shop" }));
  return { ...revisions, prs: [...shop, ...ledgerPrs()] };
}

function loadPlanted(prId, sha) {
  const file = path.join(DATA, "planted", `${prId}.json`);
  if (!fs.existsSync(file)) return null;
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  const here = all.commits.find((c) => c.sha === sha);
  return here ? { kind: "planted-faults", ranAt: all.ranAt, ...here } : null;
}
export function loadBrief(prId) {
  const file = path.join(BRIEFS, `${prId}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** Concept mapper (rule-based): folder group, with a behaviour label when the team config has one. */
function conceptOf(file) {
  const match = Object.keys(concepts)
    .filter((prefix) => file === prefix || file.startsWith(prefix + "/"))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return { id: `concept:${match}`, label: concepts[match], labelled: true, folder: match };
  const folder = file.includes("/") ? file.split("/").slice(0, -1).join("/") : "(repo root)";
  return { id: `concept:${folder}`, label: `Folder: ${folder}`, labelled: false, folder };
}

const overlaps = (ranges, start, end) => (ranges ?? []).some(([a, b]) => a <= end && b >= start);

function editedSymbolIds(index, baseIndex, ranges) {
  const ids = new Set();
  for (const s of index.symbols) if (s.kind === "function" && overlaps(ranges[s.file]?.added, s.line, s.endLine)) ids.add(s.id);
  for (const s of baseIndex.symbols) {
    if (s.kind === "function" && overlaps(ranges[s.file]?.removed, s.line, s.endLine) && index.symbols.some((x) => x.id === s.id)) ids.add(s.id);
  }
  return [...ids];
}

function downstreamOf(index, edited) {
  const callersOf = new Map();
  for (const c of index.calls) {
    if (!callersOf.has(c.to)) callersOf.set(c.to, []);
    callersOf.get(c.to).push(c.from);
  }
  const seen = new Set(edited);
  const out = [];
  const queue = [...edited];
  while (queue.length) {
    for (const caller of callersOf.get(queue.shift()) ?? []) {
      if (seen.has(caller)) continue;
      seen.add(caller);
      out.push(caller);
      queue.push(caller);
    }
  }
  return out;
}

function edgeKeys(index, tests) {
  const keys = new Set();
  for (const c of index.calls) keys.add(`calls|${c.from}|${c.to}`);
  for (const t of tests) for (const d of t.directCalls) keys.add(`tests|${t.id}|${d.to}`);
  return keys;
}

/**
 * Build everything the app shows for one PR at one selected revision.
 * Graph, diff, evidence, claims, route and sign-off state all come from this
 * one call, so they always match the selection.
 *
 * `opts` lets evals replay altered evidence: { run, brief, reviewRecord, decisions }.
 */
export function buildModel(revisions, prId, sha, opts = {}) {
  const pr = revisions.prs.find((p) => p.id === prId);
  if (!pr) throw new Error(`unknown PR: ${prId}`);
  if (pr.source === "ledger") return buildLedgerModel(pr, sha);
  const baseSha = revisions.base.sha;
  const commit = pr.commits.find((c) => c.sha === sha);
  const isBase = sha === baseSha;
  if (!isBase && !commit) throw new Error(`commit ${sha} is not part of PR ${prId}`);

  const index = loadIndex(sha);
  const baseIndex = isBase ? index : loadIndex(baseSha);
  if (!index || !baseIndex) throw new Error(`no code index saved for ${sha}. Run: npm run setup`);
  const tests = mapTests(sha, index);
  const baseTests = isBase ? tests : mapTests(baseSha, baseIndex);
  const policy = loadApprovedPolicy(baseSha);
  const brief = opts.brief ?? loadBrief(prId);
  const briefRev = (!isBase && brief?.revisions?.[String(commit.index)]) || { claims: [], openGaps: [], checksRun: [] };
  const fnLabel = (id) => (id.startsWith("test:") ? `"${id.split("#")[1]}"` : `${id.split("#")[1]}()`);

  // ---- Diff -------------------------------------------------------------
  const changed = isBase ? [] : gitChangedFiles(baseSha, sha);
  const ranges = isBase ? {} : changedLineRanges(baseSha, sha);
  const diffFiles = changed.map((f) => ({ ...f, patch: unifiedDiff(baseSha, sha, f.file) }));
  const edited = isBase ? [] : editedSymbolIds(index, baseIndex, ranges);
  const downstream = downstreamOf(index, edited);
  const symbolById = new Map(index.symbols.map((s) => [s.id, s]));

  // ---- Checks (joined by commit SHA, never by "latest") -----------------
  const run = opts.run !== undefined ? opts.run : loadRun(sha);
  const runCounts = run && run.revision === sha;
  const checks = policy.required_checks.map((name) => {
    if (!run || run.check !== name) return { name, required: true, status: "missing", resultRevision: null };
    if (run.status === "pending") return { name, required: true, status: "pending", resultRevision: run.revision };
    if (run.revision !== sha) return { name, required: true, status: "stale", resultRevision: run.revision, kind: run.kind, kindLabel: run.kindLabel };
    return { name, required: true, status: run.status, resultRevision: run.revision, kind: run.kind, kindLabel: run.kindLabel, command: run.command, counts: run.counts };
  });
  const testStatus = (testId) => (runCounts ? (run.tests.find((t) => t.id === testId)?.status ?? "not in run") : "no result for this commit");
  // Before/after: the same test run against the base code. Fails before + passes after = the change caused it.
  const baseRun = isBase ? null : loadBaseRun(sha);
  const proofOf = (testId) => {
    const before = baseRun?.tests.find((t) => t.id === testId)?.status;
    const after = testStatus(testId);
    if (!before || after !== "passed") return null;
    return before === "failed" ? "changed" : before === "passed" ? "held" : null;
  };

  // ---- Evidence per affected function -----------------------------------
  const requirement = pr.requirement;
  const needsEvidence = !isBase && requirement && policy.evidence?.require_requirement_test_per_affected_workflow;
  const affectedIds = [...edited, ...downstream];
  const evidence = !needsEvidence
    ? []
    : affectedIds.map((nodeId) => {
        const sym = symbolById.get(nodeId);
        const supportingTests = [];
        const rejected = [];
        for (const t of tests) {
          if (!t.reaches.includes(nodeId)) continue;
          const status = testStatus(t.id);
          if (!t.requirementIds.includes(requirement)) rejected.push({ testId: t.id, reason: `Reaches ${sym.name}() but does not cite ${requirement}. It checks something else.` });
          else if (!run) rejected.push({ testId: t.id, reason: "No result recorded for this commit." });
          else if (run.revision !== sha) rejected.push({ testId: t.id, reason: `The result on file is for commit ${short(run.revision)}, not this commit.` });
          else if (status !== "passed") rejected.push({ testId: t.id, reason: `Result on this commit: ${status}.` });
          else supportingTests.push(t.id);
        }
        const supported = supportingTests.length > 0;
        return {
          nodeId,
          label: `${sym.name}()`,
          file: sym.file,
          line: sym.line,
          concept: conceptOf(sym.file).label,
          role: edited.includes(nodeId) ? "edited" : "downstream",
          status: supported ? "supported" : "unverified",
          statusLabel: supported ? `Supported for the tested case` : "Unverified",
          supportingTests,
          rejected,
          missing: supported ? null : `No test that cites ${requirement} and reaches ${sym.name}() has passed on commit ${short(sha)}.`,
          suggestedCheck: supported ? null : `Add a ${requirement} test that calls ${sym.name}() for the requirement's case, and run it on this commit.`,
        };
      });
  const evidenceByNode = new Map(evidence.map((e) => [e.nodeId, e]));

  // ---- Shared graph: concepts -> files -> functions ----------------------
  const baseKeys = edgeKeys(baseIndex, baseTests);
  const currentKeys = edgeKeys(index, tests);
  const baseNodeIds = new Set([...baseIndex.symbols.map((s) => s.id), ...baseTests.map((t) => t.id)]);
  const nodes = [];
  const edges = [];
  const stateOf = (id) => (edited.includes(id) ? "edited" : downstream.includes(id) ? "downstream" : "none");

  for (const s of index.symbols.filter((x) => x.kind === "function")) {
    nodes.push({
      id: s.id, level: "function", type: "function", label: `${s.name}()`, sub: `${s.file}:${s.line}`,
      file: s.file, line: s.line, endLine: s.endLine, parent: `file:${s.file}`, concept: conceptOf(s.file).id,
      state: stateOf(s.id), evidence: evidenceByNode.get(s.id)?.status ?? null,
      change: !isBase && !baseNodeIds.has(s.id) ? "added" : null,
    });
  }
  for (const t of tests) {
    nodes.push({
      id: t.id, level: "function", type: "test", label: t.name, sub: `${t.file}:${t.line}`,
      file: t.file, line: t.line, endLine: t.endLine, parent: `file:${t.file}`, concept: conceptOf(t.file).id,
      state: "none", testStatus: testStatus(t.id), requirementIds: t.requirementIds,
      change: !isBase && !baseNodeIds.has(t.id) ? "added" : null,
    });
  }
  for (const c of index.calls) {
    edges.push({
      id: `calls|${c.from}|${c.to}`, level: "function", from: c.from, to: c.to, kind: "calls", confidence: c.confidence,
      resolution: c.confidence === "EXTRACTED" ? "resolved" : "inferred", anchor: { file: c.file, line: c.line },
      change: !isBase && !baseKeys.has(`calls|${c.from}|${c.to}`) ? "added" : null,
    });
  }
  for (const t of tests) {
    for (const d of t.directCalls) {
      edges.push({
        id: `tests|${t.id}|${d.to}`, level: "function", from: t.id, to: d.to, kind: "tests", confidence: d.confidence,
        resolution: "resolved", mapper: "rule-based test mapper", anchor: { file: d.file, line: d.line },
        change: !isBase && !baseKeys.has(`tests|${t.id}|${d.to}`) ? "added" : null,
      });
    }
  }
  const removedLinks = isBase ? [] : [...baseKeys].filter((k) => !currentKeys.has(k)).map((k) => {
    const [kind, from, to] = k.split("|");
    return { kind, from, to, text: `${fnLabel(from)} no longer ${kind === "calls" ? "calls" : "tests"} ${fnLabel(to)}` };
  });

  // Files. Changed files with no indexed symbols (docs, config) still get a node.
  const fileSet = new Set([...index.files, ...changed.map((f) => f.file).filter((f) => readFileAt(sha, f) !== null)]);
  const changedSet = new Set(changed.map((f) => f.file));
  const fnNodes = nodes.filter((n) => n.level === "function");
  const rollState = (members, selfEdited) => (selfEdited || members.some((m) => m.state === "edited") ? "edited" : members.some((m) => m.state === "downstream") ? "downstream" : "none");
  const rollEvidence = (members) => (members.some((m) => m.evidence === "unverified") ? "unverified" : members.some((m) => m.evidence === "supported") ? "supported" : null);
  const countsOf = (members) => ({
    edited: members.filter((m) => m.state === "edited").length,
    downstream: members.filter((m) => m.state === "downstream").length,
    unverified: members.filter((m) => m.evidence === "unverified").length,
  });
  for (const file of [...fileSet].sort()) {
    const members = fnNodes.filter((n) => n.file === file);
    const isTestFile = /^tests\//.test(file);
    nodes.push({
      id: `file:${file}`, level: "file", type: isTestFile ? "testfile" : "file", label: file.split("/").pop(), sub: file,
      file, line: 1, parent: conceptOf(file).id, concept: conceptOf(file).id, members: members.map((m) => m.id),
      state: isTestFile ? "none" : rollState(members, changedSet.has(file)), evidence: rollEvidence(members), counts: countsOf(members),
      fileChanged: changedSet.has(file), indexed: index.files.includes(file),
    });
    // Unindexed changed files also appear at function level, so the edit is never hidden.
    if (!index.files.includes(file)) {
      nodes.push({ id: `file:${file}`, level: "function", type: "file", label: file.split("/").pop(), sub: `${file} (no symbols indexed)`, file, line: 1, concept: conceptOf(file).id, state: "edited", evidence: null, fileChanged: true, indexed: false });
    }
  }
  const fileNodes = nodes.filter((n) => n.level === "file");
  const conceptIds = [...new Set(fileNodes.map((n) => n.concept))];
  for (const cid of conceptIds) {
    const files = fileNodes.filter((n) => n.concept === cid);
    const members = fnNodes.filter((n) => n.concept === cid);
    const info = conceptOf(files[0].file);
    nodes.push({
      id: cid, level: "concept", type: "concept", label: info.label, sub: info.labelled ? info.folder : "unlabelled folder group",
      labelled: info.labelled, members: files.map((f) => f.id),
      state: rollState(members, files.some((f) => f.fileChanged && f.type !== "testfile")), evidence: rollEvidence(members), counts: countsOf(members),
    });
  }
  // Roll function-level links up to files and concepts.
  const rollup = (level, keyOf) => {
    const grouped = new Map();
    for (const e of edges.filter((x) => x.level === "function")) {
      const a = keyOf(e.from);
      const b = keyOf(e.to);
      if (!a || !b || a === b) continue;
      const id = `${e.kind}|${a}|${b}`;
      if (!grouped.has(id)) grouped.set(id, { id, level, from: a, to: b, kind: e.kind, confidence: e.confidence, resolution: e.resolution, anchor: e.anchor, count: 0, underlying: [], change: e.change });
      const g = grouped.get(id);
      g.count++;
      g.underlying.push(e.id);
      if (!e.change) g.change = null;
      if (e.confidence !== "EXTRACTED") { g.confidence = e.confidence; g.resolution = "inferred"; }
    }
    edges.push(...grouped.values());
  };
  const fnById = new Map(fnNodes.map((n) => [n.id, n]));
  rollup("file", (id) => fnById.get(id)?.parent);
  rollup("concept", (id) => fnById.get(id)?.concept);

  // PR and requirement nodes, linked to edits and to possibly affected callers.
  if (!isBase) {
    for (const level of ["function", "file", "concept"]) {
      const levelNodes = nodes.filter((n) => n.level === level);
      nodes.push({ id: `pr:${pr.id}`, level, type: "pr", label: `PR: ${pr.title}`, sub: `commit ${commit.index} of ${pr.commits.length} · ${short(sha)}`, state: "none" });
      if (requirement) {
        nodes.push({ id: `req:${requirement}`, level, type: "requirement", label: requirement, sub: `requirements/${requirement}.md`, file: `requirements/${requirement}.md`, line: 1, state: "none" });
        edges.push({ id: `implements|${level}`, level, from: `req:${requirement}`, to: `pr:${pr.id}`, kind: "implements", confidence: "author claim", resolution: "claimed" });
      }
      for (const n of levelNodes) {
        if (n.type === "test" || n.type === "testfile") continue;
        if (n.state === "edited") edges.push({ id: `edits|${n.id}`, level, from: `pr:${pr.id}`, to: n.id, kind: "edits", confidence: "git diff", resolution: "resolved" });
        if (n.state === "downstream") edges.push({ id: `may-affect|${n.id}`, level, from: `pr:${pr.id}`, to: n.id, kind: "may-affect", confidence: "via call links", resolution: "inferred" });
      }
    }
  }

  // ---- Impact summary ----------------------------------------------------
  const workflows = nodes
    .filter((n) => n.level === "concept" && n.type === "concept" && (n.counts.edited || n.counts.downstream || n.state === "edited"))
    .map((n) => ({ id: n.id, label: n.label, ...n.counts, state: n.state }));
  const inferredCalls = index.calls.filter((c) => c.confidence !== "EXTRACTED").length;
  const unresolvedTargets = [...new Set(index.unresolved.map((u) => u.target))];
  const coverage = {
    indexer: `Graphify ${index.graphifyVersion} (schema ${index.schemaVersion}), code-only, no model. Export saved for commit ${short(sha)}.`,
    language: "TypeScript only. Function-level links.",
    counts: `${index.symbols.filter((s) => s.kind === "function").length} functions, ${index.calls.length} call links (${index.calls.length - inferredCalls} resolved, ${inferredCalls} inferred), ${tests.length} tests.`,
    mappers: ["Concept mapper: rule-based folder groups, labels from config/concepts.json", "Dependency mapper: Graphify call and import links", TEST_MAPPER_LABEL],
    gaps: [
      unresolvedTargets.length ? `Unresolved boundaries (not analysed): ${unresolvedTargets.map((t) => t.replace(/^ref_/, "").replace(/_/g, ":")).join(", ")}` : null,
      "Dynamic calls, callbacks and consumers outside this repo are not indexed.",
      "Function end lines come from brace matching, not from the indexer.",
      ...changed.filter((f) => !index.files.includes(f.file)).map((f) => `${f.file}: changed, but no symbols indexed (file-level only).`),
    ].filter(Boolean),
  };
  const impact = {
    edited: edited.map((id) => ({ id, label: fnLabel(id) })),
    downstream: downstream.map((id) => ({ id, label: fnLabel(id) })),
    unverified: evidence.filter((e) => e.status === "unverified").map((e) => ({ id: e.nodeId, label: e.label })),
    workflows,
    removedLinks,
    newLinks: edges.filter((e) => e.level === "function" && e.change === "added").map((e) => ({ id: e.id, text: `${fnLabel(e.from)} ${e.kind === "calls" ? "calls" : "tests"} ${fnLabel(e.to)}` })),
  };

  // ---- Base view stops here ---------------------------------------------
  const common = {
    source: "shop",
    pr: { id: pr.id, number: pr.number, repo: pr.repo, title: pr.title, requirement, kind: pr.kind, branch: pr.branch, commits: pr.commits, source: "shop" },
    base: revisions.base,
    selected: { sha, short: short(sha), isBase, index: commit?.index ?? 0, message: isBase ? revisions.base.message : commit.message },
    graph: { nodes, edges },
    tests: tests.map((t) => ({ ...t, status: testStatus(t.id), proof: proofOf(t.id), statusOnBase: baseRun?.tests.find((x) => x.id === t.id)?.status ?? null })),
    baseRun: baseRun ? { revision: baseRun.revision, overlay: baseRun.overlay, counts: baseRun.counts, kindLabel: baseRun.kindLabel } : null,
    trackRecord: isBase ? null : loadPlanted(pr.id, sha),
    run: run ? { ...run, countsForSelection: runCounts } : null,
    checks,
    coverage,
    impact,
    policy: { source: `Approved policy from base commit ${short(baseSha)}`, revision: baseSha, changedInThisPr: changed.some((f) => f.file === policy.file), rules: policy },
    requirementText: requirement ? readFileAt(sha, `requirements/${requirement}.md`) : null,
    baselineNote: brief?.before ? `Author's description of the baseline: ${brief.before}` : null,
  };
  if (isBase) {
    return { ...common, diff: { files: [] }, evidence: [], brief: null, claims: [], classifier1: null, review: null, classifier2: null, labels: {} };
  }

  // ---- Claims, classifiers, review --------------------------------------
  const ctx = {
    sha, baseSha, pr, index, tests, run, checks, evidence, evidenceByNode, editedIds: edited, changedFiles: changed, labelOf: fnLabel, proofOf,
    brief, briefRev, requirementText: common.requirementText, diffText: unifiedDiff(baseSha, sha),
    affected: affectedIds.map((id) => ({ ...symbolById.get(id), label: fnLabel(id), role: edited.includes(id) ? "edited" : "downstream" })),
  };
  const claims = verifyClaims(briefRev.claims, ctx);

  const sharedEdits = edited
    .map((id) => {
      const own = conceptOf(symbolById.get(id).file).label;
      const callerConcepts = [...new Set(index.calls.filter((c) => c.to === id).map((c) => conceptOf(symbolById.get(c.from).file).label))].filter((c) => c !== own);
      return { id, label: fnLabel(id), callerConcepts };
    })
    .filter((s) => s.callerConcepts.length > 0);
  const c1 = classifier1(policy, {
    changedFiles: changed,
    editedCount: edited.length,
    downstreamCount: downstream.length,
    sharedEdits,
    workflowsReached: workflows.map((w) => w.label),
    rollbackRecorded: Boolean(brief?.rollback),
  });

  const reviewInput = buildReviewInput(ctx);
  const reviewRecord = opts.reviewRecord !== undefined ? opts.reviewRecord : loadReview(sha);
  const review = finalizeReview(reviewRecord, ctx, reviewInput);
  const c2 = classifier2(policy, { initial: c1, checks, evidence, review, changedFiles: changed });

  return {
    ...common,
    diff: { files: diffFiles },
    evidence,
    brief: brief ? { ...brief, revisions: undefined, checksRun: briefRev.checksRun, openGaps: briefRev.openGaps } : null,
    claims,
    classifier1: c1,
    review,
    reviewInput,
    classifier2: c2,
    labels: { claimVerifier: CLAIM_VERIFIER_LABEL },
  };
}
