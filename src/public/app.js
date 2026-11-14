// Code Review Impact Map - frontend. No framework. One model per (PR, revision).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (sha) => (sha ?? "").slice(0, 7);
const chip = (text, cls) => `<span class="chip ${esc(cls ?? text)}">${esc(text)}</span>`;

const state = { revisions: null, prId: null, sha: null, level: "function", sel: null, model: null, notice: null, descView: "author", mapScope: "pr", full: null, fullCommit: "all" };
const sourceCache = new Map();

// ---------- data ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok && !body.error) throw new Error(`Request failed: ${res.status}`);
  return body;
}
async function getSource(sha, file) {
  const key = `${state.prId}:${sha}:${file}`;
  if (!sourceCache.has(key)) sourceCache.set(key, await api(`/api/source?pr=${encodeURIComponent(state.prId)}&sha=${encodeURIComponent(sha)}&file=${encodeURIComponent(file)}`));
  return sourceCache.get(key);
}
const currentPr = () => state.revisions.prs.find((p) => p.id === state.prId);
const revList = () => currentPr().commits.map((c) => ({ sha: c.sha, label: `Commit ${c.index}${c.madeUp ? " · made up" : ""}`, message: c.message, short: short(c.sha) }));
const stepText = (m) => `commit ${m.selected.index} · ${m.selected.short}`;
/** Escape, then turn `code` into a code span. */
const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { pr: p.get("pr"), rev: p.get("rev"), level: p.get("level"), sel: p.get("sel") };
}
function writeHash() {
  const p = new URLSearchParams({ pr: state.prId, rev: state.sha, level: state.level });
  if (state.sel?.type === "node") p.set("sel", state.sel.id);
  history.replaceState(null, "", "#" + p.toString());
}

async function load(prId, sha, { keepSelection = true } = {}) {
  state.prId = prId;
  state.sha = sha;
  const model = await api(`/api/model?pr=${encodeURIComponent(prId)}&sha=${sha}`);
  if (model.error) {
    state.notice = model.error;
    render();
    return;
  }
  state.model = model;
  state.notice = null;
  // If the selected thing does not exist at this revision, say so and go back to the overview.
  if (state.sel && keepSelection) {
    const gone = selectionMissing(state.sel);
    if (gone) {
      state.notice = `${gone} does not exist at ${model.selected.isBase ? "the base" : "PR commit " + model.selected.index} (${model.selected.short}). Showing the overview for this revision.`;
      state.sel = null;
    }
  } else if (!keepSelection) state.sel = null;
  writeHash();
  render();
}
function selectionMissing(sel) {
  const g = state.model.graph;
  if (sel.type === "node") {
    const anyLevel = g.nodes.find((n) => n.id === sel.id);
    if (!anyLevel) return `"${sel.label ?? sel.id}"`;
    if (!g.nodes.some((n) => n.id === sel.id && n.level === state.level)) state.level = anyLevel.level;
    return null;
  }
  if (sel.type === "edge") return g.edges.some((e) => e.id === sel.id && e.level === state.level) ? null : "That link";
  if (sel.type === "claim") return state.model.claims.some((c) => c.id === sel.id) ? null : "That claim";
  if (sel.type === "row") return state.model.rows?.some((r) => r.id === sel.id) ? null : `Row ${sel.id}`;
  if (sel.type === "run") return state.model.run ? null : "A run result";
  return null;
}
function select(sel) {
  state.sel = sel;
  state.notice = null;
  writeHash();
  render();
}
function selectNode(id) {
  const n = state.model.graph.nodes.find((x) => x.id === id && x.level === state.level) ?? state.model.graph.nodes.find((x) => x.id === id);
  if (!n) return;
  state.level = n.level;
  select({ type: "node", id, label: n.label });
  writeHash();
}

// ---------- header ----------
const GITHUB_URL = "http://localhost:3000"; // the GitHub replica
function renderHeader() {
  $("prSelect").innerHTML = state.revisions.prs.map((p) => `<option value="${esc(p.id)}" ${p.id === state.prId ? "selected" : ""}>#${p.number} ${esc(p.title)}</option>`).join("");
  $("revPills").innerHTML = revList().map((r) => `<button type="button" class="pill ${r.sha === state.sha ? "active" : ""}" data-sha="${r.sha}" title="${esc(r.message)}">${esc(r.label)} <span class="mono">${r.short}</span></button>`).join("");
  for (const b of $("revPills").querySelectorAll("button")) b.onclick = () => load(state.prId, b.dataset.sha);
  $("backLink").href = `${GITHUB_URL}/${currentPr().repo}/pull/${currentPr().number}`;
  const n = $("notice");
  n.hidden = !state.notice;
  n.textContent = state.notice ?? "";
}

// ---------- verdict: one stamp per decision, each says who made it ----------
const SEVERITY_TONE = { High: "bad", Medium: "warn", Low: "info" };
const stamp = (label, value, tone, by, attrs = "") => `<${attrs ? "button type=\"button\"" : "div"} class="stamp ${tone}" ${attrs}><span class="stamp-label">${esc(label)}</span><span class="stamp-value">${esc(value)}</span><span class="stamp-by">${esc(by)}</span></${attrs ? "button" : "div"}>`;
function renderVerdict() {
  const m = state.model, el = $("routeCard"), c1 = m.classifier1, c2 = m.classifier2, r = m.review;
  const signed = m.decisions.signedOff;
  const routeTone = c2.route.startsWith("Waiting") ? "warn" : c2.route.startsWith("Auto") ? "ok" : "info";
  const checkTone = (s) => (s === "passed" ? "ok" : s === "failed" ? "bad" : "warn");
  el.innerHTML = `<div class="stamps">
      ${stamp("Severity", c2.severity, SEVERITY_TONE[c2.severity] ?? "plain", `Classifier 1 · rule ${c1.rule}`)}
      ${stamp("Route", c2.route, routeTone, `Classifier 2 · rule ${c2.rule}`)}
      ${m.checks.map((c) => stamp(c.label ?? "Check", `${c.name} · ${c.status}${c.counts ? ` ${c.counts.passed}/${c.counts.total}` : ""}`, checkTone(c.status), c.by ?? "Test run on this commit", m.run ? 'data-run="1"' : "")).join("")}
      ${stamp("AI review", !r.available ? "Not available" : r.findings.length ? `${r.findings.length} finding${r.findings.length > 1 ? "s" : ""}` : "No findings", !r.available ? "plain" : r.findings.length ? "warn" : "ok", "AI reviewer · advice only", 'data-jump="reviewCard"')}
      ${stamp("Sign-off", signed ? m.decisions.signOff.name : "None yet", signed ? "ok" : "plain", "Human · this commit only", 'data-jump="decisionCard"')}
    </div>
    ${c2.blockers.length ? `<ul class="blockers">${c2.blockers.map((b) => `<li>${b.type === "evidence" ? `<button type="button" class="link" data-node="${esc(b.ref)}">${esc(b.text)}</button>` : esc(b.text)}</li>`).join("")}</ul>` : `<div class="verdict-reason">${esc(c2.reason)}</div>`}
    ${c2.notes.map((n) => `<div class="verdict-reason"><strong>${esc(n.text)}</strong></div>`).join("")}
    ${m.since ? `<div class="since"><span class="tag warn">Made-up commit for the demo</span> <strong>Since commit ${m.since.from}:</strong> ${m.since.items.map(rich).join(" · ")} · <button type="button" class="link" data-since="1">Show the code change</button></div>` : ""}`;
  // After a merge: a person can mark this PR as one that broke the system.
  el.insertAdjacentHTML("beforeend", m.evalCase
    ? `<div class="evalcase on"><span class="tag bad">Eval test case</span> <span>This PR was merged and broke the system. It is saved as a test case for the AI review agent: a good reviewer must flag it. <span class="muted">Marked ${esc(m.evalCase.markedAt.slice(0, 16).replace("T", " "))} UTC</span></span> <button type="button" class="link" data-evalcase="off">Remove</button></div>`
    : `<div class="evalcase"><button type="button" class="danger" data-evalcase="on">Eval test case</button> <span class="muted">Did this PR merge and then break the system? Mark it, and it becomes a test case for the AI review agent.</span></div>`);
  for (const b of el.querySelectorAll("[data-evalcase]")) b.onclick = async () => {
    await api("/api/evalcase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pr: state.prId, on: b.dataset.evalcase === "on" }) });
    await load(state.prId, state.sha);
  };
  for (const b of el.querySelectorAll("[data-since]")) b.onclick = () => select({ type: "since" });
  for (const b of el.querySelectorAll("[data-run]")) b.onclick = () => select({ type: "run" });
  for (const b of el.querySelectorAll("[data-node]")) b.onclick = () => selectNode(b.dataset.node);
  for (const b of el.querySelectorAll("[data-jump]")) b.onclick = () => $(b.dataset.jump).scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- PR description: the author's, or the AI-written PR in the team's shape ----------
/** The agent's saved context for this PR. The Q&A agent answers from it. */
const openContext = () => select({ type: "doc", file: `context/${state.prId}.md`, title: "context.md" });
function renderDescription() {
  const m = state.model, el = $("intentCard"), d = m.description;
  const view = d.ai ? state.descView : "author";
  const body = view === "ai"
    ? `<div class="tags">${d.ai.tags.map((t) => `<span class="tag ${esc(t.tone)}">${esc(t.label)}</span>`).join("")}</div>
       <p class="lead">${rich(d.ai.summary)}</p>
       <dl class="desc-grid">${d.ai.sections.map((s) => `<dt>${esc(s.title)}</dt><dd>${rich(s.text)}</dd>`).join("")}</dl>
       <div class="byline">${esc(d.ai.generatedBy)}</div>`
    : `${d.author.text.split("\n\n").map((p) => `<p>${rich(p)}</p>`).join("")}
       <div class="byline">Written by: ${esc(d.author.by)}</div>`;
  el.innerHTML = `<div class="card-head"><h2>${esc(m.pr.title)}</h2>
      <div class="tabs" role="tablist"><button type="button" data-view="author" class="${view === "author" ? "active" : ""}">Author's description</button><button type="button" data-view="ai" class="${view === "ai" ? "active" : ""}" ${d.ai ? "" : "disabled"}>AI PR</button></div></div>${body}${m.agent ? `<div class="byline">Agent snapshot (demo data): ${esc(m.agent.model)} · ${esc(m.agent.snapshot)} · <button type="button" class="link" data-ctx="1">context.md</button> (what the agent knew and decided)</div>` : ""}`;
  for (const b of el.querySelectorAll("[data-ctx]")) b.onclick = openContext;
  for (const b of el.querySelectorAll("[data-view]")) b.onclick = () => {
    state.descView = b.dataset.view;
    renderDescription();
  };
}

// ---------- graph ----------
const NODE_W = 196, NODE_H = 48, COL_GAP = 46, ROW_GAP = 14, PAD = 16;
function layout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map();
  for (const e of edges) if (e.kind === "calls" || e.kind === "tests") (out.get(e.from) ?? out.set(e.from, []).get(e.from)).push(e.to);
  const depthMemo = new Map();
  const depth = (id, seen = new Set()) => {
    if (depthMemo.has(id)) return depthMemo.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...(out.get(id) ?? []).filter((t) => byId.has(t)).map((t) => depth(t, seen))) + 1;
    depthMemo.set(id, d);
    return d;
  };
  const hasPr = nodes.some((n) => n.type === "pr");
  const hasReq = nodes.some((n) => n.type === "requirement");
  const offset = (hasPr ? 1 : 0) + (hasReq ? 1 : 0);
  const cols = new Map();
  for (const n of nodes) {
    const col = n.type === "requirement" ? 0 : n.type === "pr" ? (hasReq ? 1 : 0) : offset + depth(n.id);
    (cols.get(col) ?? cols.set(col, []).get(col)).push(n);
  }
  const pos = new Map();
  const rank = { edited: 0, downstream: 1, none: 2 };
  const colIds = [...cols.keys()].sort((a, b) => a - b);
  for (const col of colIds) {
    const list = cols.get(col);
    const bary = (n) => {
      const ys = (out.get(n.id) ?? []).map((t) => pos.get(t)?.row).filter((r) => r !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
    };
    list.sort((a, b) => {
      const ba = bary(a), bb = bary(b);
      if (ba !== null && bb !== null && ba !== bb) return ba - bb;
      if ((ba === null) !== (bb === null)) return ba === null ? 1 : -1;
      return rank[a.state ?? "none"] - rank[b.state ?? "none"] || a.label.localeCompare(b.label);
    });
    list.forEach((n, row) => pos.set(n.id, { row, col }));
  }
  const maxRows = Math.max(...[...cols.values()].map((l) => l.length));
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
  for (const col of colIds) {
    const list = cols.get(col);
    const colH = list.length * NODE_H + (list.length - 1) * ROW_GAP;
    const top = col < offset ? (height - colH) / 2 : PAD; // centre the PR and requirement
    list.forEach((n, row) => {
      const p = pos.get(n.id);
      p.x = PAD + colIds.indexOf(col) * (NODE_W + COL_GAP);
      p.y = top + row * (NODE_H + ROW_GAP);
    });
  }
  return { pos, width: PAD * 2 + colIds.length * NODE_W + (colIds.length - 1) * COL_GAP, height };
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function badgeFor(n) {
  if (n.badge !== undefined) return n.badge;
  if (n.type === "test") return n.testStatus === "passed" ? ["PASSED", "ok"] : n.testStatus === "failed" ? ["FAILED", "bad"] : ["NO RESULT", "warn"];
  if (n.type === "pr" || n.type === "requirement") return null;
  if (n.evidence === "contradicted") return [n.state === "edited" ? "EDITED · UNIT TEST FAILS" : "AFFECTED · UNIT TEST FAILS", "bad"];
  if (n.state === "edited") return ["EDITED", "edited"];
  if (n.state === "downstream") return ["AFFECTED", "info"];
  return null;
}
function renderGraph() {
  const m = state.model;
  for (const b of $("levelTabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.level === state.level);
    b.onclick = () => {
      state.level = b.dataset.level;
      if (state.sel?.type === "node" && !m.graph.nodes.some((n) => n.id === state.sel.id && n.level === state.level)) state.sel = null;
      if (["edge", "fullnode"].includes(state.sel?.type)) state.sel = null;
      writeHash();
      render();
    };
  }
  const full = state.mapScope === "full";
  for (const b of $("scopeTabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.scope === state.mapScope);
    b.onclick = () => setScope(b.dataset.scope);
  }
  $("fullBar").hidden = !full;
  $("legendPr").hidden = full;
  $("legendFull").hidden = !full;
  if (full) return renderFull();
  drawGraph($("graphWrap"), m.graph.nodes.filter((n) => n.level === state.level), m.graph.edges.filter((e) => e.level === state.level), selectNode, (id) => select({ type: "edge", id }));
}
function drawGraph(el, nodes, edges, onNode, onEdge) {
  const { pos, width, height } = layout(nodes, edges);
  const affected = (n) => n.state !== "none" || n.type === "pr" || n.type === "requirement";
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // A test is "in focus" when it reaches something affected.
  const focusTests = new Set(edges.filter((e) => e.kind === "tests" && affected(nodeById.get(e.to) ?? {})).map((e) => e.from));
  const lit = (n) => affected(n) || focusTests.has(n.id);

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Impact map">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 L10 5 L0 10 z"/></marker></defs>`;
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const leftToRight = a.x < b.x;
    const x1 = leftToRight ? a.x + NODE_W : a.x, x2 = leftToRight ? b.x : b.x + NODE_W;
    const y1 = a.y + NODE_H / 2, y2 = b.y + NODE_H / 2;
    const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (leftToRight ? 1 : -1);
    const d = a.x === b.x ? `M${a.x} ${y1} C${a.x - 40} ${y1}, ${b.x - 40} ${y2}, ${b.x} ${y2}` : `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    const dim = !(lit(nodeById.get(e.from)) && lit(nodeById.get(e.to)));
    const sel = state.sel?.type === "edge" && state.sel.id === e.id;
    svg += `<g class="edge ${e.kind} ${e.resolution === "inferred" && e.kind === "calls" ? "inferred" : ""} ${e.change === "added" ? "added" : ""} ${dim ? "dim" : ""} ${sel ? "selected" : ""}" data-edge="${esc(e.id)}"><title>${esc(e.kind)}${e.change === "added" ? " · new in this PR" : ""}${e.anchor ? ` · ${esc(e.anchor.file)}:${e.anchor.line}` : ""}</title><path class="vis" d="${d}" marker-end="url(#arrow)"/><path class="hit" d="${d}"/></g>`;
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const cls = ["node", n.type, n.state !== "none" ? n.state : "", n.evidence === "contradicted" ? "failing" : "", lit(n) ? "" : "dim", ["node", "fullnode"].includes(state.sel?.type) && state.sel.id === n.id ? "selected" : ""].join(" ");
    const badge = badgeFor(n);
    const extra = n.change === "added" ? "NEW" : null;
    svg += `<g class="${cls}" data-node="${esc(n.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(n.label)}"><title>${esc(n.label)}\n${esc(n.sub ?? "")}</title>
      <rect class="box" width="${NODE_W}" height="${NODE_H}" rx="8"/>
      <text x="10" y="${badge || extra ? 27 : 20}">${esc(clip(n.label, 29))}</text>
      <text class="sub" x="10" y="${badge || extra ? 40 : 35}">${esc(clip(n.sub ?? "", 33))}</text>
      ${badge ? `<text class="badge ${badge[1]}" x="10" y="13">${esc(badge[0])}</text>` : ""}
      ${extra ? `<text class="badge ok" x="${NODE_W - 10}" y="13" text-anchor="end">${extra}</text>` : ""}
    </g>`;
  }
  svg += `</svg>`;
  el.innerHTML = svg;
  for (const g of el.querySelectorAll("[data-node]")) {
    g.onclick = () => onNode(g.dataset.node);
    g.onkeydown = (ev) => (ev.key === "Enter" || ev.key === " ") && onNode(g.dataset.node);
  }
  if (onEdge) for (const g of el.querySelectorAll("[data-edge]")) g.onclick = () => onEdge(g.dataset.edge);
}

// ---------- full map: the whole repo, with commits from every PR laid over it ----------
async function setScope(scope) {
  state.mapScope = scope;
  state.sel = null;
  if (scope === "full") {
    state.level = "concept";
    if (!state.full) state.full = await api("/api/fullmap");
  }
  writeHash();
  render();
}
const pickedCommits = () => (state.fullCommit === "all" ? state.full.commits : state.full.commits.filter((c) => c.sha === state.fullCommit));
const FULL_HINT = {
  concept: "Whole repo, by area. A link means one area uses the other.",
  file: "Every file a demo PR edits or reaches. The rest of the repo is not indexed at this level.",
  function: "Every function a demo PR edits or reaches. The rest of the repo is not indexed at this level.",
};
function renderFull() {
  const f = state.full, level = state.level;
  $("fullHint").textContent = `${FULL_HINT[level]} Snapshot of ${f.repo}: ${f.totals.files} files, taken ${f.takenAt.slice(0, 10)}.`;
  $("fullPills").innerHTML = `<button type="button" class="pill ${state.fullCommit === "all" ? "active" : ""}" data-sha="all">All commits</button>` +
    f.commits.map((c) => `<button type="button" class="pill ${state.fullCommit === c.sha ? "active" : ""}" data-sha="${c.sha}" title="${esc(c.message)}">PR #${c.prNumber} · commit ${c.index} <span class="mono">${c.short}</span>${c.madeUp ? " · made up" : ""}</button>`).join("");
  for (const b of $("fullPills").querySelectorAll("button")) b.onclick = () => {
    state.fullCommit = b.dataset.sha;
    render();
  };
  const picked = pickedCommits();
  // At the concept level, an area that uses an edited area (directly or through others) is affected.
  const editedIds = new Set(picked.flatMap((c) => c.edited[level]));
  const usesEdited = new Set();
  for (let grew = level === "concept"; grew; ) {
    grew = false;
    for (const e of f.levels[level].edges) {
      if (editedIds.has(e.from) || usesEdited.has(e.from) || !(editedIds.has(e.to) || usesEdited.has(e.to))) continue;
      usesEdited.add(e.from);
      grew = true;
    }
  }
  const nodes = f.levels[level].nodes.map((n) => {
    const editedBy = picked.filter((c) => c.edited[level].includes(n.id)).length;
    const affected = !editedBy && (usesEdited.has(n.id) || picked.some((c) => c.affected[level].includes(n.id)));
    return { ...n, state: editedBy ? "edited" : affected ? "downstream" : "none", badge: editedBy ? [`EDITED${editedBy > 1 ? ` · ${editedBy} COMMITS` : ""}`, "edited"] : affected ? ["AFFECTED", "info"] : null };
  });
  drawGraph($("graphWrap"), nodes, f.levels[level].edges, (id) => select({ type: "fullnode", id }), null);
}
function fullNodeHtml(id) {
  const f = state.full, level = state.level;
  const n = f.levels[level].nodes.find((x) => x.id === id);
  if (!n) return "";
  const name = (x) => f.levels[level].nodes.find((y) => y.id === x)?.label ?? x;
  const link = (x) => `<button type="button" class="link" data-fullnode="${esc(x)}">${esc(name(x))}</button>`;
  const uses = f.levels[level].edges.filter((e) => e.from === id).map((e) => e.to);
  const usedBy = f.levels[level].edges.filter((e) => e.to === id).map((e) => e.from);
  const row = (c) => `<li><strong>PR #${c.prNumber}</strong> · commit ${c.index} <span class="mono">${c.short}</span>${c.madeUp ? ` <span class="tag warn">made up</span>` : ""}
      <div>${esc(c.message)}</div>
      <button type="button" class="link" data-openpr="${esc(c.pr)}" data-sha="${c.sha}">Open this commit's impact map</button></li>`;
  const edits = f.commits.filter((c) => c.edited[level].includes(id));
  const reaches = f.commits.filter((c) => c.affected[level].includes(id));
  return `<h2>${esc(n.label)}</h2><div class="where mono">${esc(n.file ?? n.sub ?? "")}</div>
    <dl class="kv"><dt>Uses</dt><dd>${uses.map(link).join(", ") || "nothing mapped"}</dd><dt>Used by</dt><dd>${usedBy.map(link).join(", ") || "nothing mapped"}</dd></dl>
    <h3>Commits that edit it</h3>${edits.length ? `<ul class="list">${edits.map(row).join("")}</ul>` : `<div class="muted">None in the demo.</div>`}
    ${reaches.length ? `<h3>Commits that affect it without editing it</h3><ul class="list">${reaches.map(row).join("")}</ul>` : ""}`;
}
/** One file's change in a made-up commit. */
const patchBlock = (file, from, to) => changeBlock(file.file, parseHunks(file.patch), `commit ${from} → commit ${to}`);

// ---------- AI review (advice only) ----------
function renderReview() {
  const m = state.model, el = $("reviewCard"), r = m.review;
  const cite = (c) => (c.valid ? `<button type="button" class="link mono" data-src="${esc(c.file)}" data-line="${c.line}">${esc(c.file)}:${c.line}</button>` : `<span class="mono bad-text" title="${esc(c.problem)}">${esc(c.file)}:${esc(c.line)} (invalid)</span>`);
  const c1 = m.classifier1, c2 = m.classifier2;
  const sev = (s) => `<span class="tag ${SEVERITY_TONE[s] ?? ""}">${esc(s)}</span>`;
  el.innerHTML = `<div class="card-head"><h2>Review steps</h2><span class="muted">The rules come from <button type="button" class="link" data-doc="REVIEW.md">REVIEW.md</button> and <button type="button" class="link" data-doc="review-policy.yml">review-policy.yml</button></span></div>
    <div class="step"><div class="step-head"><span class="step-n">1</span><strong>Classifier 1</strong> ${sev(c1.severity)} <span class="muted">rule ${esc(c1.rule)} · before the AI review</span></div>
      <div>${esc(c1.reason)}</div></div>
    <div class="step"><div class="step-head"><span class="step-n">2</span><strong>AI review</strong> <span class="tag ${r.findings.length ? "warn" : "ok"}">${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}</span> <span class="muted">advice only</span></div>
    <div>${esc(r.summary)}</div>
    ${r.findings.map((f) => `<details class="finding ${f.category === "Minor" ? "plain" : "warn"}" ${f.category === "Minor" ? "" : "open"}>
        <summary><span class="tag ${f.category === "Minor" ? "" : "warn"}">${esc(f.category)}</span> <strong>${esc(f.title)}</strong></summary>
        <div>${esc(f.detail)}</div>
        ${f.suggestedCheck ? `<div><strong>Check to add:</strong> ${esc(f.suggestedCheck)}</div>` : ""}
        ${f.citations.length ? `<div class="muted">Code: ${f.citations.map(cite).join(", ")}</div>` : ""}</details>`).join("")}
    ${r.couldNotDecide.length ? `<details class="finding plain"><summary><strong>${r.couldNotDecide.length} questions the AI could not answer</strong></summary>${r.couldNotDecide.map((q) => `<div>${esc(q.question)}<div class="muted">Would help: ${esc(q.checkThatWouldHelp)}</div></div>`).join("")}</details>` : ""}
    <div class="byline">${esc(r.modeLabel)}</div></div>
    <div class="step"><div class="step-head"><span class="step-n">3</span><strong>Classifier 2</strong> ${sev(c2.severity)} <span class="tag">${esc(c2.route)}</span> <span class="muted">rule ${esc(c2.rule)} · after the AI review</span></div>
      <div>${esc(c2.reason)}</div></div>`;
  for (const b of el.querySelectorAll("[data-doc]")) b.onclick = () => select({ type: "doc", file: b.dataset.doc });
  for (const b of el.querySelectorAll("[data-src]")) b.onclick = () => select({ type: "source", file: b.dataset.src, line: Number(b.dataset.line) });
}

// ---------- human decision ----------
const NOTE_LABEL = { "request-check": "Check to request", escalate: "Reason", "sign-off": "Risk you accept (write: none)" };
function renderDecision() {
  const m = state.model, el = $("decisionCard"), d = m.decisions;
  const suggested = m.classifier2.blockers.find((b) => b.suggestedCheck)?.suggestedCheck ?? "";
  const verb = { "sign-off": "Signed off", escalate: "Escalated", "request-check": "Requested a check" };
  const historyHtml = d.history.length
    ? `<ul class="history">${[...d.history].reverse().map((h) => `<li class="${h.appliesToSelection ? "" : "other"}"><strong>${esc(verb[h.action])}</strong> by ${esc(h.name)} on commit ${h.commitIndex} <span class="mono">${short(h.commit)}</span>${h.appliesToSelection ? "" : ` <span class="muted">· other commit, no effect here</span>`}${h.requestedCheck || h.residualRisk ? `<div class="muted">${esc(h.requestedCheck || h.residualRisk)}</div>` : ""}</li>`).join("")}</ul>`
    : "";
  el.innerHTML = `<div class="card-head"><h2>Your decision</h2><span class="muted">Counts for ${esc(stepText(m))} only</span></div>
    <form id="decisionForm" class="form-grid">
      <label for="dName">Your name</label><input id="dName" type="text" autocomplete="name" />
      <span>Action</span><div class="actions">
        <label><input type="radio" name="action" value="request-check" ${d.canSignOff ? "" : "checked"}/> Request a check</label>
        <label><input type="radio" name="action" value="escalate"/> Escalate</label>
        <label><input type="radio" name="action" value="sign-off" ${d.canSignOff ? "checked" : "disabled"}/> Sign off${d.canSignOff ? "" : ` <span class="muted">(blocked until the evidence is in)</span>`}</label></div>
      <label for="dNote" id="dNoteLabel"></label><textarea id="dNote"></textarea>
      <span></span><div><button class="primary" type="submit">Record decision</button><div id="decisionError" class="error"></div></div>
    </form>${historyHtml}`;
  const action = () => el.querySelector('input[name="action"]:checked')?.value;
  const syncNote = () => {
    $("dNoteLabel").textContent = NOTE_LABEL[action()];
    $("dNote").value = action() === "request-check" ? suggested : "";
  };
  for (const r of el.querySelectorAll('input[name="action"]')) r.onchange = syncNote;
  syncNote();
  $("decisionForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const note = $("dNote").value;
    const res = await api("/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pr: state.prId, sha: state.sha, name: $("dName").value, action: action(), requestedCheck: action() === "request-check" ? note : "", residualRisk: action() === "sign-off" ? note : "", checkedByHuman: action() === "escalate" ? note : "" }),
    });
    if (!res.ok) {
      $("decisionError").textContent = res.error;
      return;
    }
    await load(state.prId, state.sha);
  };
}

// ---------- side panel ----------
/** `slice: [from, to]` shows only those lines (1-based), for one function out of a long file. */
function codeBlock(src, { range, marks = [], title, slice }) {
  const lines = src.text.replace(/\n$/, "").split("\n");
  const markSet = new Map(marks.map((mk) => [mk.line, mk.label]));
  return `<div class="code"><div class="code-head"><span class="mono">${esc(src.file)}</span><span>${esc(title ?? "")} at commit <span class="mono">${short(src.sha)}</span></span></div>${lines
    .map((l, i) => {
      const n = i + 1;
      if (slice && (n < slice[0] || n > slice[1])) return "";
      const cls = markSet.has(n) ? "mark" : range && n >= range[0] && n <= range[1] ? "range" : "";
      return `<div class="code-line ${cls}" ${markSet.has(n) ? `data-mark="1" title="${esc(markSet.get(n))}"` : ""}><span class="n">${n}</span><span>${esc(l) || " "}</span></div>`;
    })
    .join("")}</div>`;
}
/** Split a diff into its changed blocks. Every line gets its line number in the new file. */
function parseHunks(patch) {
  const hunks = [];
  let hunk = null, newNo = 0;
  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    const head = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (head) {
      newNo = Number(head[1]);
      hunk = { start: newNo, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || /^(diff --git|index |--- |\+\+\+ |\\ No newline)/.test(raw)) continue;
    const t = raw[0] === "+" ? "add" : raw[0] === "-" ? "del" : "";
    // `at` is where the line sits in the new file. A removed line sits where the next line is.
    hunk.lines.push({ t, text: raw.slice(1), newNo: t === "del" ? null : newNo, at: newNo });
    if (t !== "del") newNo += 1;
  }
  return hunks;
}
/** A diff view: removed lines red, added lines green, with line numbers. `right` is trusted HTML. */
function changeBlock(file, hunks, right) {
  return `<div class="code"><div class="code-head"><span class="mono">${esc(file)}</span><span>${right}</span></div>${hunks
    .map((h) => `<div class="code-line hunk"><span class="n"></span><span>Around line ${h.start}</span></div>` +
      h.lines.map((l) => `<div class="code-line ${l.t}"><span class="n">${l.newNo ?? ""}</span><span>${l.t === "add" ? "+" : l.t === "del" ? "-" : " "}${esc(l.text) || " "}</span></div>`).join(""))
    .join("")}</div>`;
}
function diffBlock(file) {
  return changeBlock(file.file, parseHunks(file.patch), `before <span class="mono">${short(state.model.base.sha)}</span> → after <span class="mono">${state.model.selected.short}</span>`);
}
const nodeLink = (id, text) => `<button type="button" class="link" data-node="${esc(id)}">${esc(text)}</button>`;
const labelOf = (id) => state.model.graph.nodes.find((n) => n.id === id)?.label ?? id;

function runHtml() {
  const m = state.model, run = m.run;
  if (!run) return `<h2>Run result</h2><div class="callout bad">No test run is recorded for commit ${m.selected.short}.</div>`;
  const stale = run.revision !== m.selected.sha;
  return `<h2>Run result: ${esc(run.check)}</h2><div class="where">${esc(run.kindLabel)}</div>
    ${stale ? `<div class="callout bad">This result is for commit ${short(run.revision)}, not the selected commit ${m.selected.short}. It does not count here.</div>` : ""}
    <dl class="kv"><dt>Status</dt><dd>${chip(run.status, run.status)} ${run.counts.passed}/${run.counts.total} passed</dd><dt>Tested commit</dt><dd class="mono">${esc(run.revision)}</dd><dt>Command</dt><dd class="mono">${esc(run.command)}</dd><dt>Ran at</dt><dd>${esc(run.ranAt)}</dd><dt>Node</dt><dd>${esc(run.nodeVersion)}</dd></dl>
    ${m.baseRun ? `<div class="callout info"><strong>Before/after.</strong> The same tests were also run against the base code (${esc(m.baseRun.overlay)}): ${m.baseRun.counts.failed} fail there, ${m.baseRun.counts.passed} pass there.</div>` : ""}
    <h3>Tests in this run</h3><ul class="list">${run.tests.map((t) => `<li>${chip(t.status, t.status)} ${nodeLink(t.id, t.name)} <span class="muted mono">${esc(t.file)}</span></li>`).join("")}</ul>
    <h3>Raw output</h3><pre class="raw">${esc(run.rawOutput)}</pre>`;
}

async function sideHtml() {
  const m = state.model, sel = state.sel, sha = m.selected.sha;
  if (!sel) return "";
  if (sel.type === "fullnode") return fullNodeHtml(sel.id);
  if (sel.type === "doc") {
    const text = await (await fetch(`demo/${sel.file}`)).text();
    const note = sel.file.startsWith("context/") ? "Demo version, made up. The coding agent saves this file with the pull request. The Q&A agent reads it to answer your questions." : "Demo version. In a real repo this file sits at the top of the repo, and the copy on the base branch is the one that counts.";
    return `<h2>${esc(sel.title ?? sel.file)}</h2><div class="where">${note}</div><pre class="raw doc">${esc(text)}</pre>`;
  }
  if (sel.type === "since") return `<h2>Code change in commit ${m.selected.index}</h2><div class="where">${esc(m.selected.message)} · made up for the demo</div>${m.since.files.map((f) => patchBlock(f, m.since.from, m.selected.index)).join("<div style='height:8px'></div>")}`;
  if (sel.type === "run") return runHtml();
  if (sel.type === "diff") {
    const f = m.diff.files.find((x) => x.file === sel.file);
    return f ? `<h2>Diff</h2>${diffBlock(f)}` : `<h2>Diff</h2><div class="muted">No diff for ${esc(sel.file)} at this revision.</div>`;
  }
  if (sel.type === "source") {
    const src = await getSource(sha, sel.file);
    if (src.error) return `<h2>Source</h2><div class="callout bad">${esc(src.error)}</div>`;
    return `<h2>${esc(sel.file)}:${sel.line}</h2><div class="where">Cited by the reviewer</div>${codeBlock(src, { marks: [{ line: sel.line, label: "cited line" }], title: "source" })}`;
  }
  if (sel.type === "edge") {
    const e = m.graph.edges.find((x) => x.id === sel.id && x.level === state.level);
    const verb = { calls: "calls", tests: "tests", edits: "edits", "may-affect": "may affect", implements: "is implemented by" }[e.kind];
    let body = `<h2>${esc(clip(labelOf(e.from), 40))} ${verb} ${esc(clip(labelOf(e.to), 40))}</h2>
      <dl class="kv"><dt>Link type</dt><dd>${esc(e.kind)} ${e.change === "added" ? chip("new in this PR", "ok") : ""}</dd><dt>Confidence</dt><dd>${chip(e.confidence ?? "-", "plain")} ${esc(e.resolution ?? "")}${e.mapper ? ` · ${esc(e.mapper)}` : ""}</dd>${e.count > 1 ? `<dt>Rolled up</dt><dd>${e.count} function-level links</dd>` : ""}<dt>From</dt><dd>${nodeLink(e.from, labelOf(e.from))}</dd><dt>To</dt><dd>${nodeLink(e.to, labelOf(e.to))}</dd></dl>
      <div class="muted">A link shows a path to inspect. It is not a test result.</div>`;
    if (e.anchor) {
      const src = await getSource(sha, e.anchor.file);
      body += `<h3>${e.kind === "tests" ? "Where the test calls it" : "Call site"}</h3>${codeBlock(src, { marks: [{ line: e.anchor.line, label: "call site" }], title: "source" })}`;
    }
    return body;
  }
  // node
  const n = m.graph.nodes.find((x) => x.id === sel.id && x.level === state.level) ?? m.graph.nodes.find((x) => x.id === sel.id);
  if (n.type === "pr") {
    return `<h2>${esc(n.label)}</h2><div class="where">${esc(n.sub)} · branch <span class="mono">${esc(m.pr.branch)}</span></div><h3>Full diff against base</h3>${m.diff.files.map(diffBlock).join("<div style='height:8px'></div>")}`;
  }
  if (n.type === "requirement") {
    return `<h2>${esc(n.label)}</h2><div class="where mono">${esc(n.file)} at ${m.selected.short}</div><pre class="raw" style="white-space:pre-wrap">${esc(m.requirementText ?? "")}</pre>`;
  }
  if (n.type === "concept" || n.type === "file" || n.type === "testfile") {
    const members = (n.members ?? []).map((id) => m.graph.nodes.find((x) => x.id === id)).filter(Boolean);
    const diffFile = n.file ? m.diff.files.find((f) => f.file === n.file) : null;
    let body = `<h2>${esc(n.label)}</h2><div class="where">${n.type === "concept" ? (n.labelled ? `Concept · folder group <span class="mono">${esc(n.sub)}</span> (rule-based)` : "Unlabelled folder group (meaning unclear)") : `<span class="mono">${esc(n.sub)}</span>`}</div>
      ${n.counts ? `<div>${chip(`${n.counts.edited} edited`, "edited")} ${chip(`${n.counts.downstream} affected`, "info")}</div>` : ""}
      ${n.indexed === false ? `<div class="callout info">Changed, but no symbols were indexed for this file. Shown at file level only.</div>` : ""}
      ${members.length ? `<h3>${n.type === "concept" ? "Files" : "Functions and tests"}</h3><ul class="list">${members.map((x) => `<li>${nodeLink(x.id, x.label)} ${x.state === "edited" ? chip("edited", "edited") : x.state === "downstream" ? chip("affected", "info") : ""} ${x.evidence === "contradicted" ? chip("unit test fails", "bad") : ""}</li>`).join("")}</ul>` : ""}`;
    if (diffFile) body += `<h3>Diff</h3>${diffBlock(diffFile)}`;
    if (n.file) {
      const src = await getSource(sha, n.file);
      if (!src.error) body += `<h3>Source</h3>${codeBlock(src, { title: "source" })}`;
    }
    return body;
  }
  if (n.type === "test") {
    const t = m.tests.find((x) => x.id === n.id);
    const src = await getSource(sha, t.file);
    return `<h2>${esc(t.name)}</h2><div class="where mono">${esc(t.file)}:${t.line}</div>
      <dl class="kv"><dt>Result here</dt><dd>${chip(t.status, t.status === "passed" ? "passed" : t.status === "failed" ? "failed" : "warn")} on commit <span class="mono">${m.selected.short}</span> · <button type="button" class="link" data-run="1">open run result</button></dd>
      <dt>Before / after</dt><dd>${t.statusOnBase ? `${chip(t.statusOnBase + " on base", t.statusOnBase === "failed" ? "bad" : "plain")} → ${chip(t.status + " here", t.status === "passed" ? "passed" : "warn")} ${t.proof === "changed" ? "The change caused this result." : t.proof === "held" ? "Held: this behaviour was the same before the change." : ""}` : "<span class='muted'>not run against the base code</span>"}</dd>
      <dt>Cites</dt><dd>${t.requirementIds.map(esc).join(", ") || "no requirement ID"}</dd>
      <dt>Calls directly</dt><dd>${t.directCalls.map((d) => nodeLink(d.to, labelOf(d.to))).join(", ") || "nothing mapped"}</dd>
      <dt>Static reach</dt><dd>${t.reaches.map((r) => nodeLink(r, labelOf(r))).join(", ") || "nothing mapped"} <span class="muted">(call paths that exist, not proof each one ran)</span></dd></dl>
      <div class="muted">A focused test confirms the case it exercises, nothing wider.</div>
      <h3>Test and assertions</h3>${codeBlock(src, { range: [t.line, t.endLine], marks: t.assertions.map((a) => ({ line: a.line, label: "assertion" })), title: "test" })}`;
  }
  // function
  if (m.source === "tieto") return tietoNodeHtml(n);
  const ev = m.evidence.find((e) => e.nodeId === n.id);
  const outCalls = m.graph.edges.filter((e) => e.level === "function" && e.kind === "calls" && e.from === n.id);
  const inCalls = m.graph.edges.filter((e) => e.level === "function" && e.kind === "calls" && e.to === n.id);
  const affectedCalls = outCalls.filter((e) => ["edited", "downstream"].includes(m.graph.nodes.find((x) => x.id === e.to)?.state));
  const src = await getSource(sha, n.file);
  const diffFile = m.diff.files.find((f) => f.file === n.file);
  const testsHere = m.tests.filter((t) => t.reaches.includes(n.id));
  let body = `<h2>${esc(n.label)}</h2><div class="where mono">${esc(n.file)}:${n.line}-${n.endLine}</div>`;
  if (n.state === "edited") body += `<div class="callout info">${chip("edited", "edited")} This function is edited in this PR.</div>`;
  if (n.state === "downstream") body += `<div class="callout info">${chip("not edited", "info")} This function is <strong>not in the diff</strong>. It calls edited code${affectedCalls.length ? ` at line ${affectedCalls.map((e) => e.anchor.line).join(", ")}` : ""}, so its behaviour can change.</div>`;
  if (ev) {
    body += ev.status === "unverified"
      ? `<div class="callout bad"><strong>Not tested.</strong> ${esc(ev.missing)}<div style="margin-top:4px"><strong>Check to add:</strong> ${esc(ev.suggestedCheck)}</div></div>`
      : `<div class="callout ok"><strong>Tested.</strong> ${ev.supportingTests.length} ${esc(m.pr.requirement)} test(s) passed on commit ${m.selected.short}:<ul>${ev.supportingTests.map((id) => `<li>${nodeLink(id, labelOf(id))}</li>`).join("")}</ul><button type="button" class="link" data-run="1">Open the run result</button></div>`;
    if (ev.rejected.length) body += `<h3>Tests that touch it but do not count</h3><ul class="list">${ev.rejected.map((r) => `<li>${nodeLink(r.testId, labelOf(r.testId))}<div class="muted">${esc(r.reason)}</div></li>`).join("")}</ul>`;
  } else if (testsHere.length) {
    body += `<h3>Tests that reach it</h3><ul class="list">${testsHere.map((t) => `<li>${chip(t.status, t.status === "passed" ? "passed" : "warn")} ${nodeLink(t.id, t.name)}</li>`).join("")}</ul>`;
  }
  body += `<dl class="kv"><dt>Called by</dt><dd>${inCalls.map((e) => nodeLink(e.from, labelOf(e.from))).join(", ") || "no mapped callers"}</dd><dt>Calls</dt><dd>${outCalls.map((e) => nodeLink(e.to, labelOf(e.to))).join(", ") || "nothing mapped"}</dd></dl>`;
  body += `<h3>Code at this revision</h3>${codeBlock(src, { range: [n.line, n.endLine], marks: affectedCalls.map((e) => ({ line: e.anchor.line, label: "calls edited code here" })), title: "source" })}`;
  if (diffFile && n.state === "edited") body += `<h3>Diff</h3>${diffBlock(diffFile)}`;
  return body;
}

/** A function in a Tieto PR: where it is, why it is on the map, its links, its code. */
async function tietoNodeHtml(n) {
  const m = state.model;
  const links = m.graph.edges.filter((e) => e.level === "function" && e.kind === "calls" && (e.from === n.id || e.to === n.id));
  let body = `<h2>${esc(n.label)}</h2><div class="where mono">${esc(n.file)}:${n.line}${n.endLine > n.line ? `-${n.endLine}` : ""}</div>`;
  body += n.state === "edited"
    ? `<div class="callout info">${chip("edited", "edited")} This PR edits this code.</div>`
    : `<div class="callout info">${chip("not edited", "info")} This code is <strong>not in the diff</strong>. It uses code the PR changed, so its behaviour can change.</div>`;
  if (n.evidence === "contradicted") body += `<div class="callout bad"><strong>A targeted unit test fails here.</strong> It passes before this change and fails after it.</div>`;
  if (links.length) body += `<h3>Links</h3><ul class="list">${links.map((e) => `<li>${nodeLink(e.from, labelOf(e.from))} <span class="muted">${esc(e.relation ?? "calls")}</span> ${nodeLink(e.to, labelOf(e.to))}</li>`).join("")}</ul>`;
  // The changed lines that sit inside this function. Made-up commits come last in m.diff.files.
  const madeUpFrom = m.diff.files.length - (m.since?.files.length ?? 0);
  const inside = (l) => l.t && l.at >= n.line && l.at <= n.endLine;
  const changes = m.diff.files
    .map((f, i) => ({ f, madeUp: i >= madeUpFrom }))
    .filter((x) => x.f.file === n.file)
    .map((x) => ({ ...x, hunks: parseHunks(x.f.patch).filter((h) => h.lines.some(inside)) }))
    .filter((x) => x.hunks.length);
  if (changes.length) {
    body += `<h3>What changed here</h3>${changes.map((x) => changeBlock(n.file, x.hunks, x.madeUp ? `commit ${m.since.from} → commit ${m.selected.index} · made up` : "before → after this PR")).join("<div style='height:8px'></div>")}`;
  } else if (n.state === "edited") {
    body += `<div class="muted">No changed line was found inside this function.</div>`;
  }
  const src = await getSource(m.selected.sha, n.file);
  if (src.error) return body + `<div class="muted">Code not shown: this file is not changed by the PR.</div>`;
  const added = changes.filter((x) => !x.madeUp).flatMap((x) => x.hunks.flatMap((h) => h.lines.filter((l) => l.t === "add" && inside(l)).map((l) => ({ line: l.newNo, label: "changed in this PR" }))));
  // Recorded code is from commit 1. A made-up commit 2 only exists as the diff above.
  const shown = m.since ? { ...src, sha: currentPr().commits[0].sha } : src;
  body += `<h3>${changes.length ? "The function after the change" : "The function"}</h3>${codeBlock(shown, { slice: [n.line, n.endLine], marks: added, title: "code" })}`;
  return body;
}

let sideToken = 0;
async function renderSide() {
  const token = ++sideToken;
  const html = await sideHtml();
  if (token !== sideToken) return;
  const el = $("sidePanel");
  document.querySelector(".layout").classList.toggle("has-sel", Boolean(state.sel));
  el.innerHTML = state.sel ? `<button type="button" id="closeSel" class="close" aria-label="Close">✕</button>${html}` : "";
  if ($("closeSel")) $("closeSel").onclick = () => select(null);
  for (const b of el.querySelectorAll("[data-node]")) b.onclick = () => selectNode(b.dataset.node);
  for (const b of el.querySelectorAll("[data-run]")) b.onclick = () => select({ type: "run" });
  for (const b of el.querySelectorAll("[data-src]")) b.onclick = () => select({ type: "source", file: b.dataset.src, line: Number(b.dataset.line) });
  for (const b of el.querySelectorAll("[data-fullnode]")) b.onclick = () => select({ type: "fullnode", id: b.dataset.fullnode });
  for (const b of el.querySelectorAll("[data-openpr]")) b.onclick = () => {
    state.mapScope = "pr";
    load(b.dataset.openpr, b.dataset.sha, { keepSelection: false });
  };
  for (const code of el.querySelectorAll(".code")) {
    const mark = code.querySelector("[data-mark]") ?? code.querySelector(".code-line.range");
    if (mark) code.scrollTop = Math.max(0, mark.offsetTop - 70);
  }
}

function render() {
  renderHeader();
  if (!state.model) return;
  renderVerdict();
  renderDescription();
  renderGraph();
  renderReview();
  renderDecision();
  renderAgent();
  renderSide();
}

// ---------- ask the agent that wrote the PR (demo: sample answers saved with the PR) ----------
const chat = { open: false, logs: {} };
function renderAgent() {
  const a = state.model.agent, btn = $("agentBtn"), box = $("agentChat");
  btn.hidden = !a;
  box.hidden = !a || !chat.open;
  if (!a) return;
  btn.onclick = () => {
    chat.open = !chat.open;
    renderAgent();
  };
  if (!chat.open) return;
  const log = (chat.logs[state.prId] ??= []);
  const open = a.chat.filter((c) => !log.some((x) => x.text === c.q));
  box.innerHTML = `<div class="agent-head"><div><strong>Ask the agent that wrote this PR</strong><div class="muted">${esc(a.model)} · snapshot ${esc(a.snapshot)}</div><div class="muted">Answers come from <button type="button" class="link" data-ctx="1">context.md</button>: ${esc(a.context)}</div></div><button type="button" id="agentClose" class="close" aria-label="Close">✕</button></div>
    <div class="agent-log" id="agentLog">${log.map((x) => `<div class="msg ${x.who}">${rich(x.text)}</div>`).join("") || `<div class="muted">Pick a question, or type your own.</div>`}</div>
    <div class="agent-suggest">${open.map((c) => `<button type="button" data-q="${esc(c.q)}">${esc(c.q)}</button>`).join("")}</div>
    <form id="agentForm"><input id="agentInput" type="text" placeholder="Ask a question" autocomplete="off" /><button class="primary" type="submit">Send</button></form>
    <div class="byline">Demo data: sample answers saved with the snapshot. No live model is called.</div>`;
  const ask = (q) => {
    const words = q.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    const best = a.chat.map((c) => ({ c, n: words.filter((w) => `${c.q} ${c.keys ?? ""}`.toLowerCase().includes(w)).length })).sort((x, y) => y.n - x.n)[0];
    log.push({ who: "me", text: q }, { who: "agent", text: best.n ? best.c.a : "This demo snapshot only holds answers to the suggested questions." });
    renderAgent();
  };
  $("agentClose").onclick = () => {
    chat.open = false;
    renderAgent();
  };
  for (const b of box.querySelectorAll("[data-q]")) b.onclick = () => ask(b.dataset.q);
  for (const b of box.querySelectorAll("[data-ctx]")) b.onclick = openContext;
  $("agentForm").onsubmit = (ev) => {
    ev.preventDefault();
    const q = $("agentInput").value.trim();
    if (q) ask(q);
  };
  $("agentLog").scrollTop = $("agentLog").scrollHeight;
}

// ---------- light / dark ----------
function initTheme() {
  const root = document.documentElement, btn = $("themeBtn");
  let saved = null;
  try { saved = localStorage.getItem("impact-map-theme"); } catch {}
  const apply = (t) => {
    root.dataset.theme = t;
    btn.textContent = t === "dark" ? "☀ Light" : "☾ Dark";
  };
  apply(new URLSearchParams(location.search).get("theme") ?? saved ?? "light");
  btn.onclick = () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    apply(next);
    try { localStorage.setItem("impact-map-theme", next); } catch {}
  };
}

async function init() {
  initTheme();
  state.revisions = await api("/api/revisions");
  const h = readHash();
  // Link form used by the GitHub replica: /?repo=<owner/name>&pr=<number>&sha=<sha>&embed=1
  const q = new URLSearchParams(location.search);
  if (q.get("embed") === "1") document.body.classList.add("embed");
  if (q.get("chat") === "1") chat.open = true;
  if (["author", "ai"].includes(q.get("desc"))) state.descView = q.get("desc");
  const linkedRepo = q.get("repo");
  const linkedPr = q.get("pr") ? state.revisions.prs.find((p) => String(p.number) === q.get("pr") && (!linkedRepo || p.repo === linkedRepo)) : null;
  if (linkedRepo && !linkedPr) {
    // Never show another repo's analysis under this PR's name.
    document.querySelector("main").innerHTML = `<div class="card"><h2>No impact map for this pull request</h2>
      <p><span class="mono">${esc(linkedRepo)}</span> PR #${esc(q.get("pr"))} has not been analysed.</p></div>`;
    document.querySelector(".topbar").classList.add("bare");
    return;
  }
  if (!h.rev && linkedPr && q.get("sha")) h.rev = q.get("sha");
  const pr = state.revisions.prs.find((p) => p.id === h.pr) ?? linkedPr ?? state.revisions.prs[0];
  if (["concept", "file", "function"].includes(h.level)) state.level = h.level;
  const sha = pr.commits.some((c) => c.sha === h.rev) ? h.rev : pr.commits[0].sha;
  $("prSelect").onchange = (ev) => {
    const next = state.revisions.prs.find((p) => p.id === ev.target.value);
    state.notice = null;
    load(next.id, next.commits[0].sha, { keepSelection: false });
  };
  if (h.sel) state.sel = { type: "node", id: h.sel, label: h.sel.split("#").pop() };
  await load(pr.id, sha, { keepSelection: Boolean(h.sel) });
  if (q.get("since") === "1" && state.model.since) select({ type: "since" });
  if (q.get("doc") === "context") openContext();
  else if (q.get("doc")) select({ type: "doc", file: q.get("doc") });
  if (q.get("map") === "full") {
    if (q.get("commit")) state.fullCommit = q.get("commit");
    const level = state.level;
    await setScope("full");
    if (h.level) {
      state.level = level;
      render();
    }
    if (q.get("node")) select({ type: "fullnode", id: q.get("node") });
  }
}
init().catch((err) => {
  document.body.insertAdjacentHTML("afterbegin", `<div class="notice">Could not load the demo: ${esc(err.message)}. Run <code>npm run setup</code>, then <code>npm start</code>.</div>`);
});
