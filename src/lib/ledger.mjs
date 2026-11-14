// Adapter: recorded Impact Ledger packs (data/tieto/) -> the model the Impact Map shows.
//
// The packs come from the teammate project (https://github.com/h-a-forster/junction26-earned-trust).
// They hold the real Tieto sample PRs: git facts, Roslyn symbol links, recorded `dotnet test` runs
// on base and head, one recorded AI review per change, and the ledger rows built from them.
// Nothing is recomputed here. Severity and route are read from that project's factory.json.
import fs from "node:fs";
import path from "node:path";
import { matchesAny, ROUTES } from "./classifier.mjs";
import { DATA } from "./paths.mjs";
import { contestClaims } from "./claims.mjs";

const TIETO = path.join(DATA, "tieto");
const short = (sha) => (sha ?? "").slice(0, 7);
const cache = new Map();
const readJson = (file) => {
  if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(file, "utf8")));
  return cache.get(file);
};

export function ledgerIndex() {
  const file = path.join(TIETO, "index.json");
  return fs.existsSync(file) ? readJson(file) : null;
}
const packOf = (id) => readJson(path.join(TIETO, id, "pack.json"));
const factoryOf = (id) => readJson(path.join(TIETO, id, "factory.json"));

/** One step = one commit plus the evidence that existed at that point. */
export const revKey = (sha, stage) => `${sha}~${stage}`;
export const parseRev = (key) => {
  const [sha, stage] = String(key).split("~");
  return { sha, stage };
};

/** The real Tieto PRs, in the same shape as the shop sample's entries in revisions.json. */
export function ledgerPrs() {
  const index = ledgerIndex();
  if (!index) return [];
  return index.changes.map((c) => ({
    id: c.id,
    number: c.number,
    repo: index.repo,
    source: "ledger",
    title: c.title,
    requirement: c.requirement,
    kind: "real",
    branch: c.id,
    baseSha: c.base,
    commits: c.stages.map((s, i) => ({
      sha: revKey(c.head, s.id),
      commitSha: c.head,
      stage: s.id,
      label: s.label,
      sameCommit: i > 0,
      message: i === 0 ? "As submitted" : `${s.label} (same commit, new evidence)`,
      index: i + 1,
    })),
  }));
}

/** Source text of a changed file at the head commit. The packs only carry changed, non-test files. */
export function ledgerSource(prId, file) {
  const f = packOf(prId).files.find((x) => x.path === file);
  if (!f) return { error: `${file} is not part of this change. The recorded pack only holds changed files.` };
  if (!f.head_text) return { error: `The recorded pack holds no text for ${file} (test or deleted file). See the diff.` };
  return { text: f.head_text.join("\n") };
}

const CLAIM_LABEL = { proven: "Verified", exercised: "Inferred", open: "Unverified", refused: "Unverified", contradicted: "Contradicted" };
const NODE_STATUS_RANK = { contradicted: 4, unverified: 3, exercised: 2, supported: 1 };
const ROW_TO_STATUS = { contradicted: "contradicted", open: "unverified", refused: "unverified", exercised: "exercised", proven: "supported" };
const ROUTE_LABEL = { waiting: ROUTES.WAITING, "human-review": ROUTES.HUMAN, "auto-merge-eligible": ROUTES.AUTO };

function patchOf(f) {
  return f.hunks
    .map((h) => [`@@ -${h.base_start},${h.base_lines} +${h.head_start},${h.head_lines} @@`, ...h.lines.map((l) => `${l.t}${l.text}`)].join("\n"))
    .join("\n");
}

export function conceptOf(file, concepts) {
  // More specific groups first; "docs" and "tests" are broad catch-alls.
  const ordered = [...concepts].sort((a, b) => Math.max(...b.patterns.map((p) => p.length)) - Math.max(...a.patterns.map((p) => p.length)));
  const hit = ordered.find((c) => matchesAny(file, c.patterns));
  return hit ? { id: `concept:${hit.id}`, label: hit.name, labelled: true, folder: hit.patterns[0] } : { id: "concept:other", label: "Other files", labelled: false, folder: "" };
}

function rowView(row, stage) {
  const s = row.states[stage];
  const checks = (s.evidence ?? []).filter((e) => e.kind === "check");
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    detail: row.detail,
    rule: row.rule,
    inDiff: row.in_diff,
    member: row.member,
    location: row.location,
    state: s.state,
    proof: s.proof ?? null,
    why: s.why,
    decidedBy: s.decided_by,
    wouldResolve: s.would_resolve ?? null,
    reasonCode: s.reason_code ?? null,
    checks: checks.map((e) => ({
      test: e.test, run: e.run, base: e.base, head: e.head, expect: e.expect, why: e.why,
      linkProposedBy: e.link_proposed_by, writtenBy: e.check_written_by, baseMessage: e.base_message, headMessage: e.head_message,
    })),
    coverage: (s.evidence ?? []).filter((e) => e.kind === "coverage").map((e) => ({ run: e.run, file: e.file, line: e.line, covered: e.covered })),
    findings: row.findings ?? [],
    refusals: row.refusals ?? [],
  };
}

/**
 * The pack's findings in the shape contestClaims reads. A finding is linked to the rows it is filed against
 * (either side may record the link) and covers the lines it cites plus the lines of those rows.
 */
function disputesOf(pack, rows) {
  const span = (l) => ({ file: l.file, line: l.line, endLine: l.end_line ?? l.line, side: l.side });
  return pack.findings.map((f) => {
    const rowIds = [...new Set([...(f.rows ?? []), ...rows.filter((r) => r.findings.includes(f.id)).map((r) => r.id)])];
    const filedOn = rows.filter((r) => rowIds.includes(r.id) && r.location).map((r) => span(r.location));
    return { id: f.id, category: f.severity === "important" ? "Important" : "Minor", title: f.title, kind: f.kind, rowIds, spans: [...(f.refs ?? []).map(span), ...filedOn] };
  });
}

export function buildLedgerModel(pr, key) {
  const { sha, stage } = parseRev(key);
  const step = pr.commits.find((c) => c.sha === key);
  if (!step) throw new Error(`${key} is not a recorded step of ${pr.id}`);
  const pack = packOf(pr.id);
  const factory = factoryOf(pr.id);
  const concepts = readJson(path.join(TIETO, "concepts.json")).concepts;
  const index = ledgerIndex();
  const stageDef = pack.stages.find((s) => s.id === stage);
  const rows = pack.rows.map((r) => rowView(r, stage));
  const rowById = new Map(rows.map((r) => [r.id, r]));

  // ---- Graph: members from the pack's map, rolled up to files and concepts ----
  const nodes = [];
  const edges = [];
  const statusOf = (rs) => rs.map((r) => ROW_TO_STATUS[r.state]).sort((a, b) => NODE_STATUS_RANK[b] - NODE_STATUS_RANK[a])[0] ?? null;
  for (const n of pack.map.nodes) {
    const mine = rows.filter((r) => r.member === n.id);
    const edited = n.kind === "changed-member" || n.kind === "new-member";
    nodes.push({
      id: n.id, level: "function", type: "function", label: n.kind === "written-member" ? n.label : `${n.label}()`, sub: `${n.file.split("/").pop()}:${n.start_line}`,
      file: n.file, line: n.start_line, endLine: n.end_line, parent: `file:${n.file}`, concept: conceptOf(n.file, concepts).id,
      state: edited ? "edited" : "downstream", evidence: statusOf(mine), change: n.kind === "new-member" ? "added" : null,
      memberKind: n.kind, rowIds: mine.map((r) => r.id),
    });
  }
  for (const e of pack.map.edges) {
    const from = pack.map.nodes.find((n) => n.id === e.from);
    edges.push({
      id: `${e.kind}|${e.from}|${e.to}`, level: "function", from: e.from, to: e.to, kind: "calls", relation: e.kind,
      confidence: "EXTRACTED", resolution: "resolved", mapper: "Roslyn (compiler-bound reference)", anchor: from ? { file: from.file, line: e.lines?.[0] ?? from.start_line } : null,
      rowIds: e.rows ?? [], change: null,
    });
  }
  const fnNodes = nodes.filter((n) => n.level === "function");
  const roll = (members, self) => (self || members.some((m) => m.state === "edited") ? "edited" : members.some((m) => m.state === "downstream") ? "downstream" : "none");
  const rollEv = (members) => members.map((m) => m.evidence).filter(Boolean).sort((a, b) => NODE_STATUS_RANK[b] - NODE_STATUS_RANK[a])[0] ?? null;
  const counts = (members) => ({
    edited: members.filter((m) => m.state === "edited").length,
    downstream: members.filter((m) => m.state === "downstream").length,
    unverified: members.filter((m) => m.evidence === "unverified" || m.evidence === "contradicted").length,
  });
  // Large changes: show at most 40 changed files as nodes; the rest are counted, not hidden silently.
  const FILE_CAP = 40;
  const withMembers = new Set(fnNodes.map((n) => n.file));
  const fileList = [...pack.files].sort((a, b) => Number(withMembers.has(b.path)) - Number(withMembers.has(a.path)) || Number(a.is_test) - Number(b.is_test));
  const shownFiles = fileList.slice(0, FILE_CAP);
  for (const f of shownFiles) {
    const members = fnNodes.filter((n) => n.file === f.path);
    nodes.push({
      id: `file:${f.path}`, level: "file", type: f.is_test ? "testfile" : "file", label: f.path.split("/").pop(), sub: f.path, file: f.path, line: 1,
      parent: conceptOf(f.path, concepts).id, concept: conceptOf(f.path, concepts).id, members: members.map((m) => m.id),
      state: f.is_test ? "none" : roll(members, true), evidence: rollEv(members), counts: counts(members), fileChanged: true, indexed: members.length > 0 || f.language === "csharp",
    });
  }
  const fileNodes = nodes.filter((n) => n.level === "file");
  for (const cid of [...new Set(pack.files.map((f) => conceptOf(f.path, concepts).id))]) {
    const files = fileNodes.filter((n) => n.concept === cid);
    const all = pack.files.filter((f) => conceptOf(f.path, concepts).id === cid);
    const members = fnNodes.filter((n) => n.concept === cid);
    const info = conceptOf(all[0].path, concepts);
    nodes.push({
      id: cid, level: "concept", type: "concept", label: info.label, sub: `${all.length} changed file(s)`, labelled: info.labelled, members: files.map((f) => f.id),
      state: cid === "concept:tests" ? "none" : roll(members, all.some((f) => !f.is_test)), evidence: rollEv(members), counts: counts(members),
    });
  }
  const levels = ["function", "file", "concept"];
  for (const level of levels) {
    nodes.push({ id: `pr:${pr.id}`, level, type: "pr", label: `PR #${pr.number}: ${pr.title}`, sub: `${short(sha)} · ${step.label}`, state: "none" });
    nodes.push({ id: `req:${pr.requirement}`, level, type: "requirement", label: pr.requirement, sub: `${pack.requirement.clauses.length} clauses`, state: "none" });
    edges.push({ id: `implements|${level}`, level, from: `req:${pr.requirement}`, to: `pr:${pr.id}`, kind: "implements", confidence: "author claim", resolution: "claimed" });
    for (const n of nodes.filter((x) => x.level === level && !["pr", "requirement", "testfile"].includes(x.type))) {
      if (n.state === "edited") edges.push({ id: `edits|${n.id}`, level, from: `pr:${pr.id}`, to: n.id, kind: "edits", confidence: "git diff", resolution: "resolved" });
      if (n.state === "downstream") edges.push({ id: `may-affect|${n.id}`, level, from: `pr:${pr.id}`, to: n.id, kind: "may-affect", confidence: "via Roslyn links", resolution: "inferred" });
    }
  }

  // ---- Checks: the recorded runs available at this stage ----
  const runs = pack.provenance.evidence.filter((e) => stageDef.runs.includes(e.run_id)).map((e) => ({
    id: e.run_id, side: e.side, commit: e.commit, command: e.command, tool: e.tool, overlay: e.overlay, collectedAt: e.collected_at, totals: e.totals,
    countsForSelection: e.side === "head" && e.commit === sha,
  }));
  const headFull = runs.find((r) => r.id === "head-full");
  const checks = [{
    name: "head-full", required: true, kind: "recorded", kindLabel: "Recorded dotnet test run from the Impact Ledger pack. Not re-run here.",
    status: !headFull ? "missing" : headFull.commit !== sha ? "stale" : headFull.totals.failed === 0 ? "passed" : "failed",
    resultRevision: headFull?.commit ?? null, command: headFull?.command,
    counts: headFull ? { passed: headFull.totals.passed, total: headFull.totals.passed + headFull.totals.failed, failed: headFull.totals.failed } : null,
  }];

  // ---- Evidence per affected member, from its rows ----
  const evidence = fnNodes.filter((n) => n.rowIds.length).map((n) => {
    const mine = n.rowIds.map((id) => rowById.get(id));
    const bad = mine.filter((r) => ["open", "refused", "contradicted"].includes(r.state));
    const status = n.evidence === "contradicted" ? "contradicted" : n.evidence === "unverified" ? "unverified" : "supported";
    return {
      nodeId: n.id, label: n.label, file: n.file, line: n.line, concept: nodes.find((c) => c.id === n.concept)?.label, role: n.state,
      status,
      statusLabel: status === "contradicted" ? "Contradicted by an executed check" : status === "unverified" ? "Unverified" : n.evidence === "exercised" ? "Exercised only (executed, not asserted)" : "Proven by an executed check",
      supportingTests: [], rejected: [],
      missing: bad.length ? `${bad.length} of ${mine.length} places in ${n.label} have no check behind them at this step (${bad.slice(0, 4).map((r) => r.id).join(", ")}${bad.length > 4 ? ", …" : ""}).` : null,
      suggestedCheck: bad.find((r) => r.wouldResolve)?.wouldResolve ?? null,
      rowIds: n.rowIds,
    };
  });

  // ---- Claims and requirement clauses, labelled from row states ----
  const labelRow = (r) => ({
    id: r.id, text: r.type === "requirement" ? pack.requirement.clauses.find((c) => c.id === r.id)?.text ?? r.title : r.detail || r.title,
    kind: r.type, label: CLAIM_LABEL[r.state],
    reason: `${r.why}${r.state === "proven" && r.proof === "changed" ? " The check fails before the change and passes after it." : r.state === "proven" && r.proof === "held" ? " The check passes before and after: the statement held; this does not show the change caused it." : ""}`,
    missing: r.wouldResolve, link: { kind: "row", rowId: r.id },
    where: r.location ? { file: r.location.file, line: r.location.line, endLine: r.location.end_line, side: r.location.side } : null,
    clauseKind: r.type === "requirement" ? pack.requirement.clauses.find((c) => c.id === r.id)?.kind ?? null : null,
  });
  const claims = contestClaims([...rows.filter((r) => r.type === "requirement"), ...rows.filter((r) => r.type === "claim")].map(labelRow), disputesOf(pack, rows));

  // ---- Classifiers: read, not recomputed ----
  const f1 = factory.classifier_1;
  const f2 = factory.stages[stage].classifier_2;
  const fired1 = f1.considered.filter((c) => c.matched).map((c) => ({ rule: c.rule, severity: c.severity, reason: c.detail, facts: [c.detail] }));
  const edited = fnNodes.filter((n) => n.state === "edited");
  const downstream = fnNodes.filter((n) => n.state === "downstream");
  const workflows = nodes.filter((n) => n.level === "concept" && n.type === "concept" && n.state !== "none").map((n) => ({ id: n.id, label: n.label, ...n.counts, state: n.state }));
  const classifier1 = {
    name: "Classifier 1", kind: "deterministic rules (Impact Ledger factory, recorded)", severity: f1.severity, rule: f1.rule, reason: f1.reason, fired: fired1,
    facts: { changedFiles: pack.files.map((f) => f.path), editedFunctions: edited.length, downstreamFunctions: downstream.length, workflowsReached: workflows.map((w) => w.label), rollbackRecorded: false },
  };
  const blockers = (f2.waiting_on ?? []).map((w) => {
    const r = rowById.get(w.row);
    return { type: "evidence", ref: r?.member ?? null, rowId: w.row, status: r?.state ?? "open", text: `${w.row} is ${r?.state ?? "open"}: ${r?.title ?? ""}`.trim(), suggestedCheck: w.what };
  });
  const classifier2 = {
    name: "Classifier 2", kind: "deterministic rules (Impact Ledger factory, recorded)", initialSeverity: f2.initial_severity, severity: f2.severity,
    rule: f2.route_rule, reason: f2.route_reason, route: ROUTE_LABEL[f2.route] ?? f2.route_label, blockers,
    notes: f2.raised ? [{ rule: f2.severity_rule, text: `Severity raised from ${f2.initial_severity} to ${f2.severity}: ${f2.severity_reason}` }] : [],
    autoMergeDryRun: Boolean(f2.auto_merge?.eligible),
  };

  // ---- Recorded AI review ----
  const rv = pack.provenance.review ?? {};
  const review = {
    available: true, mode: "recorded-llm",
    modeLabel: `Recorded AI review from the Impact Ledger pack (${rv.model ?? "model not stated"}${rv.recorded_at ? ", " + String(rv.recorded_at).slice(0, 10) : ""}). ${pack.validation.items_kept} of ${pack.validation.items_total} items and ${pack.validation.refs_valid} of ${pack.validation.refs_total} references passed validation.`,
    model: rv.model ?? null, runner: rv.context ?? null, ranAt: rv.recorded_at ?? null, inputsMatch: true, inputHash: pack.pack_sha256,
    summary: "The reviewer can find, link and refuse. It cannot approve. The labels Important and Minor are the reviewer's own.",
    findings: pack.findings.map((f) => ({
      id: f.id, category: f.severity === "important" ? "Important" : "Minor", title: f.title, detail: f.detail, suggestedCheck: null,
      citations: (f.refs ?? []).map((r) => ({ file: r.file, line: r.line, side: r.side, valid: true, problem: null })), citationsValid: (f.refs ?? []).length > 0, note: f.kind ? `Kind: ${f.kind}` : null,
    })),
    couldNotDecide: pack.refusals.map((r) => ({ id: r.id, question: r.question, checkThatWouldHelp: r.would_resolve, reasonCode: r.reason_code, why: r.why, rows: r.rows ?? [] })),
  };

  const stateCounts = rows.reduce((a, r) => ((a[r.state] = (a[r.state] ?? 0) + 1), a), {});
  const sym = pack.provenance.facts.symbols.head;
  return {
    source: "ledger",
    pr: { id: pr.id, number: pr.number, repo: pr.repo, title: pr.title, requirement: pr.requirement, kind: pr.kind, branch: pr.branch, commits: pr.commits, source: "ledger" },
    base: { sha: pr.baseSha, branch: "base", message: pack.change.base.subject },
    selected: { sha: key, commitSha: sha, short: short(sha), isBase: false, index: step.index, message: step.message, stage, stageLabel: step.label, sameCommit: step.sameCommit },
    graph: { nodes, edges },
    tests: [],
    run: null,
    runs,
    checks,
    rows,
    rowCounts: stateCounts,
    coverage: {
      indexer: `Roslyn via CsFacts ${sym.tool.version} (Roslyn ${sym.tool.roslyn}), from the Impact Ledger pack ${pack.pack_sha256.slice(0, 12)}. ${sym.binding.references_resolved} of ${sym.binding.references_total} references resolved.`,
      language: "C#. Member-level links, one step from the change.",
      counts: `${fnNodes.length} members on the map, ${pack.map.edges.length} links, ${rows.length} ledger rows.`,
      mappers: ["Concept mapper: groups declared by hand in the Impact Ledger project (data/tieto/concepts.json)", "Dependency mapper: Roslyn reads, writes, calls", "Test mapper: recorded AI review proposed which test stands behind which row; outcomes are executed"],
      gaps: [...pack.blind_spots.map((b) => b.text), ...(pack.files.length > FILE_CAP ? [`${pack.files.length - FILE_CAP} of ${pack.files.length} changed files are not drawn at file level (counted in their concept).`] : [])],
    },
    impact: {
      edited: edited.map((n) => ({ id: n.id, label: n.label })),
      downstream: downstream.map((n) => ({ id: n.id, label: n.label })),
      unverified: evidence.filter((e) => e.status !== "supported").map((e) => ({ id: e.nodeId, label: e.label })),
      workflows, removedLinks: [], newLinks: [],
    },
    policy: { source: `Impact Ledger policy (data/tieto/review-policy.upstream.yml, sha ${factory.policy.sha256.slice(0, 8)}); severity and route recorded, not recomputed here`, revision: pr.baseSha, changedInThisPr: false, rules: null },
    requirementText: pack.requirement.source_lines.join("\n"),
    baselineNote: null,
    diff: { files: pack.files.map((f) => ({ file: f.path, status: f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M", patch: patchOf(f), isTest: f.is_test })) },
    evidence,
    brief: {
      author: pack.change.head.author, authorKind: "agent", why: pack.change.head.subject, before: null, after: null, preserve: null, approach: null, alternatives: null, rollback: null,
      checksRun: [], openGaps: [], noTemplate: true,
    },
    claims,
    classifier1,
    review,
    reviewInput: { prompt: `Inputs listed in the pack: ${(rv.inputs ?? []).join("; ")}. Prompt: ${rv.prompt ?? "prompts/reviewer.md"} in the Impact Ledger repository.`, inputHash: pack.pack_sha256 },
    classifier2,
    trackRecord: { kind: "planted-faults-upstream", area: pack.area_trust.area, tier: pack.area_trust.tier, basis: pack.area_trust.basis },
    readingList: { depth: pack.routing[stage].depth, rows: pack.routing[stage].reading_list.length, lines: pack.routing[stage].reading_lines, diffLines: pack.routing[stage].diff_lines },
    labels: { claimVerifier: "Labels from ledger row states (rule-based)" },
    provenance: { producedBy: "Impact Ledger", source: index.source, sourceCommit: index.sourceCommit, packSha256: pack.pack_sha256 },
  };
}
