// Code Review Impact Map - frontend. No framework. One model per (PR, revision).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (sha) => (sha ?? "").slice(0, 7);
const chip = (text, cls) => `<span class="chip ${esc(cls ?? text)}">${esc(text)}</span>`;

const state = { revisions: null, prId: null, sha: null, level: "function", sel: null, model: null, notice: null };
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
const isLedger = (pr) => pr.source === "ledger";
const revList = () => {
  const pr = currentPr();
  const steps = pr.commits.map((c) => ({ sha: c.sha, label: isLedger(pr) ? c.label : `PR commit ${c.index}`, message: c.message, short: short(c.commitSha ?? c.sha) }));
  return isLedger(pr) ? steps : [{ sha: state.revisions.base.sha, label: "Base", message: state.revisions.base.message, short: short(state.revisions.base.sha) }, ...steps];
};
/** "commit 2 · 3d67ab6" for the shop sample, "After targeted checks · 9df83c3" for a recorded PR. */
const stepText = (m) => (m.source === "ledger" ? `${m.selected.stageLabel} · ${m.selected.short}${m.selected.sameCommit ? " · same commit, new evidence" : ""}` : `commit ${m.selected.index} · ${m.selected.short}`);
const ROW_CHIP = { proven: "ok", exercised: "info", open: "warn", refused: "warn", contradicted: "bad" };
const rowChip = (r) => chip(r.state + (r.proof ? ` · ${r.proof}` : ""), ROW_CHIP[r.state]);

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
function renderHeader() {
  const prSel = $("prSelect");
  const brandSub = document.querySelector(".brand .muted");
  if (brandSub) brandSub.textContent = `${currentPr().repo} · local demo`;
  const repos = [...new Set(state.revisions.prs.map((p) => p.repo))];
  prSel.innerHTML = repos.map((repo) => `<optgroup label="${esc(repo)}${state.revisions.prs.find((p) => p.repo === repo).source === "ledger" ? " (real Tieto sample, recorded)" : " (synthetic, analysed here)"}">${state.revisions.prs.filter((p) => p.repo === repo).map((p) => `<option value="${esc(p.id)}" ${p.id === state.prId ? "selected" : ""}>#${p.number} ${esc(p.kind === "eval" ? "[eval] " : "")}${esc(p.title)}</option>`).join("")}</optgroup>`).join("");
  const revs = revList();
  const i = revs.findIndex((r) => r.sha === state.sha);
  $("revPills").innerHTML = revs.map((r) => `<button type="button" class="pill ${r.sha === state.sha ? "active" : ""}" data-sha="${r.sha}" title="${esc(r.message)}">${esc(r.label)} <span class="mono">${r.short}</span></button>`).join("");
  $("prevBtn").disabled = i <= 0;
  $("nextBtn").disabled = i >= revs.length - 1;
  $("prevBtn").onclick = () => load(state.prId, revs[i - 1].sha);
  $("nextBtn").onclick = () => load(state.prId, revs[i + 1].sha);
  for (const b of $("revPills").querySelectorAll("button")) b.onclick = () => load(state.prId, b.dataset.sha);
  const n = $("notice");
  n.hidden = !state.notice;
  n.textContent = state.notice ?? "";
}

// ---------- route banner ----------
function renderRoute() {
  const m = state.model;
  const el = $("routeCard");
  const checksHtml = m.checks.length
    ? m.checks.map((c) => `<button type="button" class="check-row" data-run="1"><span><strong>${esc(c.name)}</strong> <span class="muted">required · ${esc(c.kind ? c.kind + " run" : "no run")}</span></span>${chip(c.status + (c.counts ? ` ${c.counts.passed}/${c.counts.total}` : ""), c.status)}</button>`).join("")
    : `<span class="muted">No required checks.</span>`;
  if (m.selected.isBase) {
    el.innerHTML = `<div class="route base"><div class="route-main">
      <div class="route-title">Base revision <span class="mono muted">${m.selected.short}</span></div>
      <div>This is the code before the PR. No route applies here. Step to a PR commit to review the change.</div>
      ${m.baselineNote ? `<div class="muted">${esc(m.baselineNote)}</div>` : ""}
      </div><div class="checks">${checksHtml}</div></div>`;
  } else {
    const c2 = m.classifier2;
    const signed = m.decisions.signedOff;
    const cls = signed ? "signed" : c2.route.startsWith("Waiting") ? "waiting" : c2.route.startsWith("Auto") ? "auto" : "human";
    el.innerHTML = `<div class="route ${cls}"><div class="route-main">
      <div class="route-title">${chip(c2.severity)} ${esc(c2.route)} <span class="mono muted">${esc(stepText(m))}</span></div>
      <div>${esc(c2.reason)} <span class="muted">(${esc(c2.rule)}; ${esc(m.policy.source)})</span></div>
      ${c2.blockers.length ? `<ul class="blockers">${c2.blockers.map((b) => `<li>${b.type === "evidence" && b.rowId ? `<button type="button" class="link" data-row="${esc(b.rowId)}">${esc(b.text)}</button>` : b.type === "evidence" ? `<button type="button" class="link" data-node="${esc(b.ref)}">${esc(b.text)}</button>` : esc(b.text)}${b.suggestedCheck ? `<div class="muted">Targeted check: ${esc(b.suggestedCheck)}</div>` : ""}</li>`).join("")}</ul>` : ""}
      ${c2.notes.map((n) => `<div><strong>${esc(n.text)}</strong> <span class="muted">(${esc(n.rule)})</span></div>`).join("")}
      ${c2.autoMergeDryRun ? `<div class="muted">Policy dry run only. This app never merges.</div>` : ""}
      ${m.provenance ? `<div class="muted">Real Tieto sample PR. Evidence, AI review, severity and route are recorded output of ${esc(m.provenance.producedBy)} (pack ${esc(m.provenance.packSha256.slice(0, 12))}). Shown here, not recomputed.</div>` : ""}
      <div class="signoff-line">${signed ? `✔ Signed off on this commit by ${esc(m.decisions.signOff.name)} (${esc(m.decisions.signOff.at.slice(0, 16).replace("T", " "))} UTC)` : `No human sign-off on this commit.`}</div>
      </div><div class="checks">${checksHtml}</div></div>`;
  }
  for (const b of el.querySelectorAll("[data-run]")) b.onclick = () => select({ type: "run" });
  for (const b of el.querySelectorAll("[data-node]")) b.onclick = () => selectNode(b.dataset.node);
  for (const b of el.querySelectorAll("[data-row]")) b.onclick = () => select({ type: "row", id: b.dataset.row });
}

// ---------- PR intent + claims ----------
function renderIntent() {
  const m = state.model;
  const el = $("intentCard");
  $("claimsCard").hidden = true;
  if (m.selected.isBase || !m.brief) {
    el.innerHTML = `<div class="card-head"><h2>PR intent</h2></div><div class="muted">${m.selected.isBase ? "Not shown on the base revision. The PR brief belongs to the PR commits." : "No PR brief saved for this PR."}</div>`;
    return;
  }
  const b = m.brief;
  const none = "<em>None recorded</em>";
  const field = (v) => (v ? esc(v) : none);
  el.innerHTML = `<div class="card-head"><h2>PR intent: ${esc(m.pr.title)}</h2><span>${m.pr.requirement ? `<button type="button" class="link" data-node="req:${esc(m.pr.requirement)}">${esc(m.pr.requirement)}</button>` : chip("No requirement linked", "warn")}</span></div>
    <dl class="intent-grid">
      <dt>Author</dt><dd>${esc(b.author)} ${chip(b.noTemplate ? "agent-written change, no brief" : b.authorKind === "agent" ? "AI-written brief" : "human-written", "plain")}</dd>
      <dt>Why</dt><dd>${field(b.why)}${b.noTemplate ? ` <span class="muted">(commit message; this PR did not use the brief template)</span>` : ""}</dd>
      <dt>Before → after</dt><dd>${b.before || b.after ? `${field(b.before)} → ${field(b.after)}` : none}</dd>
      <dt>Must preserve</dt><dd>${field(b.preserve)}</dd>
      <dt>Approach</dt><dd>${field(b.approach)}</dd>
      <dt>Alternatives</dt><dd>${b.alternatives ? esc(b.alternatives) : "<em>None recorded</em>"}</dd>
      <dt>Checks run</dt><dd>${(b.checksRun ?? []).length ? (b.checksRun ?? []).map((c) => esc(c.label)).join("; ") + " " + chip("local", "plain") : none}</dd>
      <dt>Open gaps</dt><dd>${(b.openGaps ?? []).map(esc).join("; ") || "<em>None stated by the author</em>"}</dd>
      <dt>Rollback</dt><dd>${field(b.rollback)}</dd>
    </dl>`;
  $("claimsCard").hidden = false;
  $("claimsCard").innerHTML = `<div class="card-head"><h2>${m.source === "ledger" ? "Requirement clauses and author claims, checked" : "Author claims, checked"}</h2><span class="muted">${m.claims.filter((c) => c.label === "Verified").length} verified · ${m.claims.filter((c) => c.label === "Inferred").length} inferred · ${m.claims.filter((c) => c.label === "Unverified").length} unverified${m.claims.some((c) => c.label === "Contradicted") ? ` · ${m.claims.filter((c) => c.label === "Contradicted").length} contradicted` : ""}</span></div>
    <h3 hidden>Author claims, checked <span class="muted" style="text-transform:none;letter-spacing:0">(${esc(m.labels.claimVerifier)})</span></h3>
    <ul class="claims">${m.claims.map((c) => `<li><button type="button" class="claim ${state.sel?.type === "claim" && state.sel.id === c.id ? "sel" : ""}" data-claim="${esc(c.id)}"><span>${chip(c.label)}</span><span><div>${esc(c.text)}</div><div class="reason">${esc(c.reason)}</div></span></button></li>`).join("")}</ul>`;
  for (const btn of $("claimsCard").querySelectorAll("[data-claim]")) btn.onclick = () => (m.claims.find((c) => c.id === btn.dataset.claim)?.link?.kind === "row" ? select({ type: "row", id: btn.dataset.claim }) : select({ type: "claim", id: btn.dataset.claim }));
  for (const btn of el.querySelectorAll("[data-node]")) btn.onclick = () => selectNode(btn.dataset.node);
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
function badgeFor(n, isBase) {
  if (n.type === "test") return n.testStatus === "passed" ? ["PASSED", "#17753a"] : n.testStatus === "failed" ? ["FAILED", "#c0261c"] : ["NO RESULT", "#9a5b00"];
  if (n.type === "pr" || n.type === "requirement" || isBase) return null;
  if (n.evidence === "contradicted") return ["CONTRADICTED BY A CHECK", "#8f1209"];
  if (n.evidence === "unverified") return ["UNVERIFIED", "#c0261c"];
  if (n.evidence === "exercised") return [n.state === "edited" ? "EDITED · EXERCISED ONLY" : "NOT EDITED · EXERCISED ONLY", "#9a5b00"];
  if (n.state === "edited") return [n.evidence === "supported" ? "EDITED · SUPPORTED" : "EDITED", "#b45309"];
  if (n.state === "downstream") return [n.evidence === "supported" ? "NOT EDITED · SUPPORTED" : "NOT EDITED · CALLER", n.evidence === "supported" ? "#17753a" : "#1d4ed8"];
  return null;
}
function renderGraph() {
  const m = state.model;
  for (const b of $("levelTabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.level === state.level);
    b.onclick = () => {
      state.level = b.dataset.level;
      if (state.sel?.type === "node" && !m.graph.nodes.some((n) => n.id === state.sel.id && n.level === state.level)) state.sel = null;
      if (state.sel?.type === "edge") state.sel = null;
      writeHash();
      render();
    };
  }
  const nodes = m.graph.nodes.filter((n) => n.level === state.level);
  const edges = m.graph.edges.filter((e) => e.level === state.level);
  const { pos, width, height } = layout(nodes, edges);
  const isBase = m.selected.isBase;
  const affected = (n) => isBase || n.state !== "none" || n.type === "pr" || n.type === "requirement";
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // A test is "in focus" when it reaches something affected.
  const focusTests = new Set(edges.filter((e) => e.kind === "tests" && affected(nodeById.get(e.to) ?? {})).map((e) => e.from));
  const lit = (n) => affected(n) || focusTests.has(n.id);

  let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Impact map">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#667085"/></marker></defs>`;
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
    svg += `<g class="edge ${e.kind} ${e.resolution === "inferred" && e.kind === "calls" ? "inferred" : ""} ${e.change === "added" ? "added" : ""} ${dim ? "dim" : ""} ${sel ? "selected" : ""}" data-edge="${esc(e.id)}"><title>${esc(e.kind)} · ${esc(e.confidence ?? "")}${e.change === "added" ? " · new in this PR" : ""}${e.anchor ? ` · ${esc(e.anchor.file)}:${e.anchor.line}` : ""}</title><path class="vis" d="${d}" marker-end="url(#arrow)"/><path class="hit" d="${d}"/></g>`;
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const cls = ["node", n.type, n.state !== "none" ? n.state : "", n.evidence === "unverified" ? "unverified" : n.evidence === "contradicted" ? "contradicted" : "", lit(n) ? "" : "dim", n.change === "added" ? "added" : "", state.sel?.type === "node" && state.sel.id === n.id ? "selected" : ""].join(" ");
    const badge = badgeFor(n, isBase);
    const extra = n.change === "added" ? "NEW" : null;
    svg += `<g class="${cls}" data-node="${esc(n.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(n.label)}"><title>${esc(n.label)}\n${esc(n.sub ?? "")}</title>
      <rect class="box" width="${NODE_W}" height="${NODE_H}" rx="8"/>
      <text x="10" y="${badge || extra ? 27 : 20}">${esc(clip(n.label, 29))}</text>
      <text class="sub" x="10" y="${badge || extra ? 40 : 35}">${esc(clip(n.sub ?? "", 33))}</text>
      ${badge ? `<text class="badge" x="10" y="13" fill="${badge[1]}">${esc(badge[0])}</text>` : ""}
      ${extra ? `<text class="badge" x="${NODE_W - 10}" y="13" text-anchor="end" fill="#17753a">${extra}</text>` : ""}
    </g>`;
  }
  svg += `</svg>`;
  $("graphWrap").innerHTML = svg;
  for (const g of $("graphWrap").querySelectorAll("[data-node]")) {
    g.onclick = () => selectNode(g.dataset.node);
    g.onkeydown = (ev) => (ev.key === "Enter" || ev.key === " ") && selectNode(g.dataset.node);
  }
  for (const g of $("graphWrap").querySelectorAll("[data-edge]")) g.onclick = () => select({ type: "edge", id: g.dataset.edge });

  // Counts: direct edits are counted separately from downstream code.
  const im = m.impact;
  $("impactSummary").innerHTML = isBase
    ? `<span class="muted">Baseline call graph at ${m.selected.short}. Click a node or a link to open the code.</span>`
    : `${chip(`${im.edited.length} edited`, "edited")} ${chip(`${im.downstream.length} downstream, not edited`, "info")} ${chip(`${im.unverified.length} unverified`, im.unverified.length ? "bad" : "ok")}
       <span class="muted">Workflows: ${im.workflows.map((w) => `${esc(w.label)} (${w.edited} edited, ${w.downstream} downstream${w.unverified ? `, ${w.unverified} unverified` : ""})`).join(" · ") || "none mapped"}</span>
       ${im.newLinks.length ? `<span class="muted">· New links: ${im.newLinks.length}</span>` : ""}${im.removedLinks.length ? `<span class="muted">· Removed links: ${im.removedLinks.map((r) => esc(r.text)).join("; ")}</span>` : ""}`;
  const c = m.coverage;
  $("coverage").innerHTML = `<summary>Index coverage and gaps in analysis</summary><ul><li>${esc(c.indexer)}</li><li>${esc(c.language)} ${esc(c.counts)}</li>${c.mappers.map((x) => `<li>${esc(x)}</li>`).join("")}${c.gaps.map((x) => `<li><strong>Gap:</strong> ${esc(x)}</li>`).join("")}</ul>`;
}

// ---------- review factory ----------
function renderReview() {
  const m = state.model;
  const el = $("reviewCard");
  if (m.selected.isBase) {
    el.innerHTML = `<div class="card-head"><h2>Review factory</h2></div><div class="muted">Runs on PR commits.</div>`;
    return;
  }
  const c1 = m.classifier1, c2 = m.classifier2, r = m.review;
  const cite = (c) => (c.valid ? `<button type="button" class="link mono" data-src="${esc(c.file)}" data-line="${c.line}">${esc(c.file)}:${c.line}</button>` : `<span class="mono" style="color:var(--bad)" title="${esc(c.problem)}">${esc(c.file)}:${esc(c.line)} (invalid)</span>`);
  el.innerHTML = `<div class="card-head"><h2>Review factory</h2><span class="muted">${esc(stepText(m))}</span></div>
    <div class="stage"><div class="stage-head"><strong>1 · Classifier 1</strong> ${chip(c1.severity)} <span class="muted">${esc(c1.kind)} · ${esc(c1.rule)}</span></div>
      <div>${esc(c1.reason)}</div>
      <div class="muted">${c1.fired.map((f) => `${esc(f.rule)}: ${f.facts.map(esc).join("; ") || "-"}`).join(" · ")}</div>
      <div class="muted">Facts: ${c1.facts.editedFunctions} edited, ${c1.facts.downstreamFunctions} downstream, workflows reached: ${c1.facts.workflowsReached.map(esc).join(", ") || "none"}, rollback ${c1.facts.rollbackRecorded ? "recorded" : "not recorded"}.</div></div>
    <div class="stage"><div class="stage-head"><strong>2 · Independent AI review</strong> ${r.available ? chip("available", "ok") : chip("unavailable", "warn")}</div>
      <div class="mode-banner ${r.mode === "rule-based-fallback" || !r.available ? "fallback" : ""}">${esc(r.modeLabel)}${r.runner ? ` · ${esc(r.runner)}` : ""}</div>
      <div>${esc(r.summary)}</div>
      ${r.findings.length ? r.findings.map((f) => `<div class="finding ${f.category === "Action required" ? "action" : "need"}">${chip(f.category, f.category === "Action required" ? "bad" : f.category === "Needs evidence" ? "warn" : "plain")} <strong>${esc(f.title)}</strong>
        <div>${esc(f.detail)}</div>
        <div>Cites: ${f.citations.map(cite).join(", ") || "<em>nothing</em>"}</div>
        ${f.suggestedCheck ? `<div><strong>Check that would help:</strong> ${esc(f.suggestedCheck)}</div>` : ""}
        ${f.note ? `<div class="note">${esc(f.note)}</div>` : ""}</div>`).join("") : `<div class="muted">No findings.</div>`}
      ${r.couldNotDecide.length ? `<h3>Could not decide</h3><ul class="list">${r.couldNotDecide.map((q) => `<li>${esc(q.question)}<div class="muted">Would help: ${esc(q.checkThatWouldHelp)}</div></li>`).join("")}</ul>` : ""}
      <details><summary class="muted">Saved inputs for this review (${esc(short(m.reviewInput.inputHash))})</summary><pre class="raw">${esc(m.reviewInput.prompt)}</pre></details></div>
    <div class="stage"><div class="stage-head"><strong>3 · Classifier 2</strong> ${chip(c2.severity)} <strong>${esc(c2.route)}</strong> <span class="muted">${esc(c2.kind)} · ${esc(c2.rule)}</span></div>
      <div>${esc(c2.reason)}</div>
      ${c2.notes.map((n) => `<div class="muted">${esc(n.rule)}: ${esc(n.text)}</div>`).join("")}
      <div class="muted">${esc(m.policy.source)}${m.policy.changedInThisPr ? ". This PR edits review-policy.yml; its edits are NOT applied to itself." : "."} The AI findings are shown as evidence for the human. Severity and route come from rules only.</div></div>`;
  for (const b of el.querySelectorAll("[data-src]")) b.onclick = () => select({ type: "source", file: b.dataset.src, line: Number(b.dataset.line) });
}

// ---------- decision ----------
function renderDecision() {
  const m = state.model;
  const el = $("decisionCard");
  const d = m.decisions;
  const historyHtml = d.history.length
    ? `<ul class="history">${[...d.history].reverse().map((h) => `<li class="${h.appliesToSelection ? "" : "other"}">
        <div><strong>${esc(h.action === "sign-off" ? "Signed off" : h.action === "escalate" ? "Escalated" : "Requested a check")}</strong> by ${esc(h.name)} on commit ${h.commitIndex} <span class="mono">${short(h.commit)}</span> · ${esc(h.at.slice(0, 16).replace("T", " "))} UTC
        ${h.appliesToSelection ? chip("applies to this commit", "ok") : chip("other commit · no effect here", "plain")}</div>
        <div class="muted">Route then: ${esc(h.severityAtDecision)} · ${esc(h.routeAtDecision)}</div>
        ${h.requestedCheck ? `<div>Requested: ${esc(h.requestedCheck)}</div>` : ""}${h.residualRisk ? `<div>Residual risk accepted: ${esc(h.residualRisk)}</div>` : ""}${h.note ? `<div>Note: ${esc(h.note)}</div>` : ""}
        <details><summary>What was checked, and by whom (${h.checked.length}) · what remains unchecked (${h.unchecked.length})</summary>
          <ul>${h.checked.map((c) => `<li><strong>${esc(c.by)}:</strong> ${esc(c.what)}</li>`).join("")}</ul>
          <ul>${h.unchecked.map((u) => `<li><strong>Unchecked:</strong> ${esc(u.what)} - ${esc(u.why)}</li>`).join("") || "<li>Nothing listed as unchecked.</li>"}</ul></details></li>`).join("")}</ul>`
    : `<div class="muted">No decisions recorded for this PR yet.</div>`;
  if (m.selected.isBase) {
    el.innerHTML = `<div class="card-head"><h2>Human decision</h2></div><div class="muted">Decisions are recorded on PR commits.</div><h3>History for this PR</h3>${historyHtml}`;
    return;
  }
  const suggested = m.classifier2.blockers.find((b) => b.suggestedCheck)?.suggestedCheck ?? "";
  el.innerHTML = `<div class="card-head"><h2>Human decision</h2><span class="muted">for ${esc(stepText(m))} only</span></div>
    <form id="decisionForm" class="form-grid">
      <label for="dName">Engineer name</label><input id="dName" type="text" autocomplete="name" placeholder="Your name" />
      <span>Action</span><div class="actions">
        <label><input type="radio" name="action" value="request-check" ${d.canSignOff ? "" : "checked"}/> Request a check</label>
        <label><input type="radio" name="action" value="escalate"/> Escalate</label>
        <label title="${d.canSignOff ? "" : "Not available until required checks and evidence are in for this commit."}"><input type="radio" name="action" value="sign-off" ${d.canSignOff ? "checked" : "disabled"}/> Sign off ${d.canSignOff ? "" : `<span class="muted">(blocked: evidence missing on this commit)</span>`}</label></div>
      <label for="dReq">Check requested</label><textarea id="dReq">${esc(suggested)}</textarea>
      <label for="dChecked">What I checked myself</label><textarea id="dChecked" placeholder="e.g. Opened the import test result and the call site."></textarea>
      <label for="dUnchecked">What stays unchecked, and why</label><textarea id="dUnchecked"></textarea>
      <label for="dRisk">Residual risk I accept</label><textarea id="dRisk" placeholder="Needed for sign-off. Write 'none' if none."></textarea>
      <span></span><div><button class="primary" type="submit">Record decision</button> <span class="muted">Machine-checked items and open gaps are added to the record automatically.</span><div id="decisionError" class="error"></div></div>
    </form>
    <h3>History for this PR</h3>${historyHtml}`;
  $("decisionForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const action = el.querySelector('input[name="action"]:checked')?.value;
    const res = await api("/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pr: state.prId, sha: state.sha, name: $("dName").value, action, requestedCheck: $("dReq").value, checkedByHuman: $("dChecked").value, uncheckedByHuman: $("dUnchecked").value, residualRisk: $("dRisk").value }),
    });
    if (!res.ok) {
      $("decisionError").textContent = res.error;
      return;
    }
    await load(state.prId, state.sha);
  };
}

// ---------- side panel ----------
function codeBlock(src, { range, marks = [], title }) {
  const lines = src.text.replace(/\n$/, "").split("\n");
  const markSet = new Map(marks.map((mk) => [mk.line, mk.label]));
  return `<div class="code"><div class="code-head"><span class="mono">${esc(src.file)}</span><span>${esc(title ?? "")} at commit <span class="mono">${short(src.sha)}</span></span></div>${lines
    .map((l, i) => {
      const n = i + 1;
      const cls = markSet.has(n) ? "mark" : range && n >= range[0] && n <= range[1] ? "range" : "";
      return `<div class="code-line ${cls}" ${markSet.has(n) ? `data-mark="1" title="${esc(markSet.get(n))}"` : ""}><span class="n">${n}</span><span>${esc(l) || " "}</span></div>`;
    })
    .join("")}</div>`;
}
function diffBlock(file) {
  const body = file.patch.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  return `<div class="code"><div class="code-head"><span class="mono">${esc(file.file)}</span><span>diff: base <span class="mono">${short(state.model.base.sha)}</span> → <span class="mono">${state.model.selected.short}</span></span></div>${body
    .map((l) => `<div class="code-line ${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}"><span class="n"></span><span>${esc(l) || " "}</span></div>`)
    .join("")}</div>`;
}
const nodeLink = (id, text) => `<button type="button" class="link" data-node="${esc(id)}">${esc(text)}</button>`;
const labelOf = (id) => state.model.graph.nodes.find((n) => n.id === id)?.label ?? id;

const srcLink = (file, line) => `<button type="button" class="link mono" data-src="${esc(file)}" data-line="${line}">${esc(file)}:${line}</button>`;
const rowLine = (r) => `<li><button type="button" class="link mono" data-row="${esc(r.id)}">${esc(r.id)}</button> ${rowChip(r)} ${esc(clip(r.title || r.detail || "", 110))}<div class="muted">${esc(clip(r.why ?? "", 220))}</div></li>`;
const outcome = (o) => chip(o ?? "absent", o === "Passed" ? "ok" : o === "Failed" ? "bad" : "plain");

async function rowHtml(r) {
  const m = state.model;
  let body = `<h2>${esc(r.id)}</h2><div class="where">${esc(r.type)} row · ${esc(stepText(m))}</div>
    <div class="callout ${r.state === "proven" ? "ok" : r.state === "contradicted" ? "bad" : r.state === "exercised" ? "info" : "bad"}">${rowChip(r)} ${esc(r.title || "")}<div>${esc(r.why ?? "")}</div></div>
    ${r.state === "exercised" ? `<div class="muted">Exercised means a passing test executed this line. It does not mean anything asserted its behaviour.</div>` : ""}
    ${r.proof === "changed" ? `<div class="muted">Proven · changed: the check fails before the change and passes after it.</div>` : r.proof === "held" ? `<div class="muted">Proven · held: the check passes before and after. The statement held; this does not show the change caused it.</div>` : ""}
    <dl class="kv">${r.detail ? `<dt>Text</dt><dd class="mono">${esc(r.detail)}</dd>` : ""}<dt>Why this row exists</dt><dd>${esc(r.rule)}</dd><dt>State decided by</dt><dd>${esc(r.decidedBy)}</dd>
    ${r.location ? `<dt>Place</dt><dd>${srcLink(r.location.file, r.location.line)} ${r.inDiff ? chip("in the diff", "edited") : chip("outside the diff", "info")}</dd>` : ""}
    ${r.member ? `<dt>Member</dt><dd>${nodeLink(r.member, labelOf(r.member))}</dd>` : ""}
    ${r.wouldResolve ? `<dt>Check that would settle it</dt><dd>${esc(r.wouldResolve)}</dd>` : ""}</dl>`;
  if (r.checks.length) {
    body += `<h3>Executed checks behind this row</h3><ul class="list">${r.checks.map((c) => `<li><div class="mono">${esc(c.test)}</div>
      <div>base ${outcome(c.base)} → head ${outcome(c.head)} <span class="muted">expected ${esc(c.expect)}${c.run ? ` · run ${esc(c.run)}` : " · not run at this step"}</span></div>
      ${c.why ? `<div class="muted">${esc(c.why)}</div>` : ""}
      <div class="muted">Link proposed by: ${esc(c.linkProposedBy ?? "-")}. Check written by: ${esc(c.writtenBy ?? "-")}.</div>
      ${c.baseMessage ? `<pre class="raw">base: ${esc(c.baseMessage)}</pre>` : ""}${c.headMessage ? `<pre class="raw">head: ${esc(c.headMessage)}</pre>` : ""}</li>`).join("")}</ul>`;
  } else body += `<div class="callout bad">No executed check stands behind this row at this step.</div>`;
  if (r.coverage.length) body += `<div class="muted">Coverage: ${r.coverage.map((c) => `line ${c.line} ${c.covered ? "executed" : "not executed"} in run ${esc(c.run)}`).join("; ")}.</div>`;
  const related = [...r.findings, ...r.refusals];
  if (related.length) body += `<div class="muted">Related reviewer items: ${related.map(esc).join(", ")} (see Review factory).</div>`;
  if (r.location) {
    const src = await getSource(m.selected.sha, r.location.file);
    if (!src.error) body += `<h3>Code at the head commit</h3>${codeBlock(src, { marks: [{ line: r.location.line, label: r.id }], title: "source" })}`;
  }
  return body;
}

async function ledgerNodeHtml(n) {
  const m = state.model;
  const ev = m.evidence.find((e) => e.nodeId === n.id);
  const mine = m.rows.filter((r) => r.member === n.id);
  const links = m.graph.edges.filter((e) => e.level === "function" && e.kind === "calls" && (e.from === n.id || e.to === n.id));
  let body = `<h2>${esc(n.label)}</h2><div class="where mono">${esc(n.file)}:${n.line}-${n.endLine}</div>`;
  body += n.state === "edited" ? `<div class="callout info">${chip("edited", "edited")} This member is edited in this PR.</div>` : `<div class="callout info">${chip("not edited", "info")} This member is <strong>not in the diff</strong>. It reads, writes or calls something the PR changed.</div>`;
  if (ev) body += `<div class="callout ${ev.status === "supported" ? "ok" : "bad"}"><strong>${esc(ev.statusLabel)}.</strong> ${esc(ev.missing ?? "")}${ev.suggestedCheck ? `<div style="margin-top:4px"><strong>Targeted check:</strong> ${esc(ev.suggestedCheck)}</div>` : ""}</div>`;
  if (mine.length) body += `<h3>Places in this member (${mine.length} rows)</h3><ul class="list">${mine.map(rowLine).join("")}</ul>`;
  if (links.length) body += `<h3>Links</h3><ul class="list">${links.map((e) => `<li>${nodeLink(e.from, labelOf(e.from))} <span class="muted">${esc(e.relation ?? "calls")}</span> ${nodeLink(e.to, labelOf(e.to))}</li>`).join("")}</ul>`;
  const src = await getSource(m.selected.sha, n.file);
  body += src.error ? `<div class="muted">${esc(src.error)}</div>` : `<h3>Code at the head commit</h3>${codeBlock(src, { range: [n.line, n.endLine], marks: mine.filter((r) => r.location).map((r) => ({ line: r.location.line, label: `${r.id}: ${r.state}` })), title: "source" })}`;
  return body;
}

function runHtml() {
  const m = state.model, run = m.run;
  if (m.runs) {
    return `<h2>Recorded check runs</h2><div class="where">dotnet test, recorded by the Impact Ledger project. Not re-run here.</div>
      <ul class="list">${m.runs.map((r) => `<li><strong>${esc(r.id)}</strong> ${chip(r.totals.failed ? `${r.totals.failed} failed` : "passed", r.totals.failed ? "bad" : "ok")} ${r.totals.passed} passed, ${r.totals.failed} failed
        <dl class="kv"><dt>Side</dt><dd>${esc(r.side)} · commit <span class="mono">${short(r.commit)}</span></dd><dt>Command</dt><dd class="mono">${esc(r.command)}</dd><dt>Tool</dt><dd>${esc(r.tool)}</dd>${r.overlay ? `<dt>Overlay</dt><dd>${esc(r.overlay)}</dd>` : ""}<dt>Collected</dt><dd>${esc(r.collectedAt)}</dd></dl></li>`).join("")}</ul>
      <div class="muted">A failure on the base side with the head tests is expected: it shows the test notices the change.</div>`;
  }
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
  if (!sel) {
    const im = m.impact;
    return `<h2>Overview</h2><div class="where">${m.selected.isBase ? "Base" : `PR commit ${m.selected.index}`} · <span class="mono">${m.selected.short}</span> · ${esc(m.selected.message)}</div>
      ${m.selected.isBase ? `<div class="callout info">Baseline. Click a function to read its code at this revision. Click a link to open the call site.</div>` : `
      <h3>Edited in this PR</h3><ul class="list">${im.edited.map((e) => `<li>${nodeLink(e.id, e.label)}</li>`).join("") || `<li class="muted">No indexed functions edited. See the Files level.</li>`}</ul>
      <h3>Downstream, not edited</h3><ul class="list">${im.downstream.map((e) => `<li>${nodeLink(e.id, e.label)} ${m.evidence.find((x) => x.nodeId === e.id) ? chip(m.evidence.find((x) => x.nodeId === e.id).statusLabel, /^Exercised/.test(m.evidence.find((x) => x.nodeId === e.id).statusLabel) ? "info" : m.evidence.find((x) => x.nodeId === e.id).status === "contradicted" ? "bad" : m.evidence.find((x) => x.nodeId === e.id).status) : ""}</li>`).join("") || `<li class="muted">None mapped.</li>`}</ul>
      <h3>Changed files</h3><ul class="list">${m.diff.files.map((f) => `<li><button type="button" class="link mono" data-diff="${esc(f.file)}">${esc(f.file)}</button> ${chip(f.status === "A" ? "added" : f.status === "D" ? "deleted" : "modified", "plain")}</li>`).join("")}</ul>`}
      ${m.source === "ledger" ? `<h3>Ledger rows at this step</h3><div>${Object.entries(m.rowCounts).map(([k, v]) => chip(`${v} ${k}`, ROW_CHIP[k])).join(" ")}</div><div class="muted" style="margin-top:6px">A row is one requirement clause, claim or place the change reaches. Only an executed check closes a row.</div><div style="margin-top:6px"><button type="button" class="link" data-run="1">Recorded check runs</button></div>` : `<h3>Tests at this revision</h3><ul class="list">${m.tests.map((t) => `<li>${chip(t.status, t.status === "passed" ? "passed" : t.status === "failed" ? "failed" : "warn")} ${t.proof ? chip(t.proof === "changed" ? "fails on base" : "held", t.proof === "changed" ? "ok" : "plain") : ""} ${nodeLink(t.id, t.name)}</li>`).join("")}</ul>`}`;
  }
  if (sel.type === "run") return runHtml();
  if (sel.type === "row") return rowHtml(m.rows.find((r) => r.id === sel.id));
  if (sel.type === "diff") {
    const f = m.diff.files.find((x) => x.file === sel.file);
    return f ? `<h2>Diff</h2>${diffBlock(f)}` : `<h2>Diff</h2><div class="muted">No diff for ${esc(sel.file)} at this revision.</div>`;
  }
  if (sel.type === "source") {
    const src = await getSource(sha, sel.file);
    if (src.error) return `<h2>Source</h2><div class="callout bad">${esc(src.error)}</div>`;
    return `<h2>${esc(sel.file)}:${sel.line}</h2><div class="where">Cited by the reviewer</div>${codeBlock(src, { marks: [{ line: sel.line, label: "cited line" }], title: "source" })}`;
  }
  if (sel.type === "claim") {
    const c = m.claims.find((x) => x.id === sel.id);
    let body = `<h2>Claim</h2><div class="where">${esc(m.brief.author)}</div><div class="callout ${c.label === "Verified" ? "ok" : c.label === "Inferred" ? "info" : "bad"}">${chip(c.label)} ${c.proof ? chip(c.proof === "changed" ? "fails on base, passes here" : "held: passes before and after", "plain") : ""} ${esc(c.text)}</div><div>${esc(c.reason)}</div>${c.missing ? `<div><strong>Missing:</strong> ${esc(c.missing)}</div>` : ""}`;
    if (c.link?.kind === "test") {
      const t = m.tests.find((x) => x.id === c.link.testId);
      const src = await getSource(sha, t.file);
      body += `<h3>Cited test</h3><div>${nodeLink(t.id, t.name)} ${chip(t.status, t.status === "passed" ? "passed" : "warn")} <button type="button" class="link" data-run="1">open run result</button></div>${codeBlock(src, { range: [t.line, t.endLine], marks: t.assertions.map((a) => ({ line: a.line, label: "assertion" })), title: "test" })}`;
    } else if (c.link?.kind === "source") {
      const src = await getSource(sha, c.link.file);
      body += `<h3>Cited source</h3>${c.link.nodeId ? `<div>${nodeLink(c.link.nodeId, labelOf(c.link.nodeId))}</div>` : ""}${codeBlock(src, { marks: [{ line: c.link.line, label: "cited call site" }], title: "source" })}`;
    } else if (c.link?.kind === "diff") {
      const f = c.link.file ? m.diff.files.find((x) => x.file === c.link.file) : null;
      body += `<h3>Cited diff</h3>${(f ? [f] : m.diff.files).map(diffBlock).join("")}`;
    } else if (c.link?.kind === "run") {
      body += `<div><button type="button" class="link" data-run="1">Open the run result</button></div>`;
    } else if (c.link?.kind === "node") body += `<div>${nodeLink(c.link.nodeId, labelOf(c.link.nodeId))}</div>`;
    return body;
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
      ${n.counts ? `<div>${chip(`${n.counts.edited} edited`, "edited")} ${chip(`${n.counts.downstream} downstream`, "info")} ${chip(`${n.counts.unverified} unverified`, n.counts.unverified ? "bad" : "ok")}</div>` : ""}
      ${n.indexed === false ? `<div class="callout info">Changed, but no symbols were indexed for this file. Shown at file level only.</div>` : ""}
      ${members.length ? `<h3>${n.type === "concept" ? "Files" : "Functions and tests"}</h3><ul class="list">${members.map((x) => `<li>${nodeLink(x.id, x.label)} ${x.state === "edited" ? chip("edited", "edited") : x.state === "downstream" ? chip("downstream", "info") : ""} ${x.evidence === "unverified" ? chip("Unverified", "bad") : x.evidence === "contradicted" ? chip("Contradicted", "bad") : ""}</li>`).join("")}</ul>` : ""}`;
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
  if (m.source === "ledger") return ledgerNodeHtml(n);
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
      ? `<div class="callout bad"><strong>Unverified.</strong> ${esc(ev.missing)}<div style="margin-top:4px"><strong>Targeted check:</strong> ${esc(ev.suggestedCheck)}</div></div>`
      : `<div class="callout ok"><strong>${esc(ev.statusLabel)}.</strong> ${ev.supportingTests.length} ${esc(m.pr.requirement)} test(s) passed on commit ${m.selected.short}:<ul>${ev.supportingTests.map((id) => `<li>${nodeLink(id, labelOf(id))}</li>`).join("")}</ul><button type="button" class="link" data-run="1">Open the run result</button></div>`;
    if (ev.rejected.length) body += `<h3>Tests that touch it but do not count</h3><ul class="list">${ev.rejected.map((r) => `<li>${nodeLink(r.testId, labelOf(r.testId))}<div class="muted">${esc(r.reason)}</div></li>`).join("")}</ul>`;
  } else if (testsHere.length) {
    body += `<h3>Tests that reach it</h3><ul class="list">${testsHere.map((t) => `<li>${chip(t.status, t.status === "passed" ? "passed" : "warn")} ${nodeLink(t.id, t.name)}</li>`).join("")}</ul>`;
  }
  body += `<dl class="kv"><dt>Called by</dt><dd>${inCalls.map((e) => nodeLink(e.from, labelOf(e.from))).join(", ") || "no mapped callers"}</dd><dt>Calls</dt><dd>${outCalls.map((e) => nodeLink(e.to, labelOf(e.to))).join(", ") || "nothing mapped"}</dd></dl>`;
  body += `<h3>Code at this revision</h3>${codeBlock(src, { range: [n.line, n.endLine], marks: affectedCalls.map((e) => ({ line: e.anchor.line, label: "calls edited code here" })), title: "source" })}`;
  if (diffFile && n.state === "edited") body += `<h3>Diff</h3>${diffBlock(diffFile)}`;
  return body;
}

let sideToken = 0;
async function renderSide() {
  const token = ++sideToken;
  const html = await sideHtml();
  if (token !== sideToken) return;
  const el = $("sidePanel");
  el.innerHTML = (state.sel ? `<div style="float:right"><button type="button" id="closeSel">Overview</button></div>` : "") + html;
  if ($("closeSel")) $("closeSel").onclick = () => select(null);
  for (const b of el.querySelectorAll("[data-node]")) b.onclick = () => selectNode(b.dataset.node);
  for (const b of el.querySelectorAll("[data-run]")) b.onclick = () => select({ type: "run" });
  for (const b of el.querySelectorAll("[data-diff]")) b.onclick = () => select({ type: "diff", file: b.dataset.diff });
  for (const b of el.querySelectorAll("[data-row]")) b.onclick = () => select({ type: "row", id: b.dataset.row });
  for (const b of el.querySelectorAll("[data-src]")) b.onclick = () => select({ type: "source", file: b.dataset.src, line: Number(b.dataset.line) });
  for (const code of el.querySelectorAll(".code")) {
    const mark = code.querySelector("[data-mark]") ?? code.querySelector(".code-line.range");
    if (mark) code.scrollTop = Math.max(0, mark.offsetTop - 70);
  }
}

// ---------- ledger rows (recorded PRs) ----------
function renderRows() {
  const m = state.model, el = $("rowsCard");
  const rows = (m.rows ?? []).filter((r) => r.type === "reach" || r.type === "change");
  el.hidden = !rows.length;
  if (!rows.length) return;
  const order = ["contradicted", "open", "refused", "exercised", "proven"];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  const outside = rows.filter((r) => !r.inDiff).length;
  el.innerHTML = `<div class="card-head"><h2>Places this change reaches</h2><span class="muted">${rows.length} rows · ${outside} outside the diff</span></div>
    <div>${order.filter((s) => rows.some((r) => r.state === s)).map((s) => chip(`${rows.filter((r) => r.state === s).length} ${s}`, ROW_CHIP[s])).join(" ")}
    <span class="muted">Only an executed check closes a row. "Exercised" is weak: executed by a passing test, nothing asserted.</span></div>
    <details ${rows.some((r) => r.state === "contradicted") ? "open" : ""}><summary class="muted">Show the rows (open and contradicted first)</summary><ul class="list">${sorted.map(rowLine).join("")}</ul></details>`;
  for (const b of el.querySelectorAll("[data-row]")) b.onclick = () => select({ type: "row", id: b.dataset.row });
}

// ---------- track record: planted faults ----------
function renderTrack() {
  const m = state.model, el = $("trackCard"), t = m.trackRecord;
  el.hidden = !t;
  if (!t) return;
  if (t.kind === "planted-faults-upstream") {
    el.innerHTML = `<div class="card-head"><h2>Track record of this review system</h2><span class="muted">planted faults · area ${esc(t.area)}</span></div>
      <div>${esc(t.basis)}</div>
      <div class="muted">Reading depth for the named engineer: <strong>${esc(m.readingList.depth)}</strong>. By rows alone the reading list is ${m.readingList.rows} rows on ${m.readingList.lines} lines of a ${m.readingList.diffLines}-line diff. Measured by the Impact Ledger project; not re-run here.</div>`;
    return;
  }
  const s = t.summary;
  const flag = (f) => (f.mapFlag === "unverified" ? chip("Unverified", "bad") : f.mapFlag === "supported" ? chip("Supported", "ok") : chip("not affected by this PR", "plain"));
  el.innerHTML = `<div class="card-head"><h2>Track record of this review system</h2><span class="muted">planted faults · ${esc(stepText(m))}</span></div>
    <div>We planted <strong>${s.planted}</strong> known bugs into a copy of this commit and ran the same green suite. The tests caught <strong>${s.caughtByTests}</strong>. <strong>${s.escapedTests}</strong> got past them.</div>
    <ul>
      <li>${s.escapedWhereMapSaidUnverified.length} escaped where the map said <strong>Unverified</strong>${s.escapedWhereMapSaidUnverified.length ? ` (${s.escapedWhereMapSaidUnverified.join(", ")})` : ""}. The map warned about these.</li>
      <li>${s.escapedWhereMapSaidSupported.length} escaped where the map said <strong>Supported</strong>${s.escapedWhereMapSaidSupported.length ? ` (${s.escapedWhereMapSaidSupported.join(", ")})` : ""}. A miss: "supported" covers the tested case only.</li>
      <li>${s.escapedOutsideThePr.length} escaped in code this PR does not touch or reach${s.escapedOutsideThePr.length ? ` (${s.escapedOutsideThePr.join(", ")})` : ""}. The map makes no claim there.</li>
    </ul>
    <details><summary class="muted">Show each planted fault</summary><ul class="list">${t.faults.filter((f) => f.applied).map((f) => `<li><strong>${esc(f.id)}</strong> ${f.caughtByTests ? chip("caught by tests", "ok") : chip("escaped the tests", "bad")} map said: ${flag(f)} · ${nodeLink(f.node, labelOf(f.node))}<div class="muted">${esc(f.what)}${f.caughtByTests ? ` Caught by: ${f.failingTests.map(esc).join("; ")}` : ""}</div></li>`).join("")}</ul></details>
    <div class="muted">Rule-based, no model. One small sample: an observation, not an accuracy figure. See docs/measurement.md.</div>`;
  for (const b of el.querySelectorAll("[data-node]")) b.onclick = () => selectNode(b.dataset.node);
}

function render() {
  renderHeader();
  if (!state.model) return;
  renderRoute();
  renderIntent();
  renderGraph();
  renderRows();
  renderReview();
  renderTrack();
  renderDecision();
  renderSide();
}

async function init() {
  state.revisions = await api("/api/revisions");
  const h = readHash();
  // Link form used by the GitHub replica: /?repo=<owner/name>&pr=<number>&sha=<sha>&embed=1
  const q = new URLSearchParams(location.search);
  if (q.get("embed") === "1") document.body.classList.add("embed");
  const linkedRepo = q.get("repo");
  const linkedPr = q.get("pr") ? state.revisions.prs.find((p) => String(p.number) === q.get("pr") && (!linkedRepo || p.repo === linkedRepo)) : null;
  if (linkedRepo && !linkedPr) {
    // Never show another repo's analysis under this PR's name.
    document.querySelector("main").innerHTML = `<div class="card"><h2>No impact analysis for this pull request yet</h2>
      <p><span class="mono">${esc(linkedRepo)}</span> PR #${esc(q.get("pr"))} has not been indexed by this Impact Map.</p>
      <p class="muted">This build covers: ${[...new Set(state.revisions.prs.map((p) => p.repo))].map((r) => `<span class="mono">${esc(r)}</span>`).join(", ")}.
      Its status for this PR is: queued, nothing claimed.</p></div>`;
    document.querySelector(".topbar").classList.add("bare");
    return;
  }
  if (!h.rev && linkedPr && q.get("sha")) h.rev = q.get("sha");
  const pr = state.revisions.prs.find((p) => p.id === h.pr) ?? linkedPr ?? state.revisions.prs[0];
  if (["concept", "file", "function"].includes(h.level)) state.level = h.level;
  const revs = [state.revisions.base.sha, ...pr.commits.map((c) => c.sha)];
  // The Open Impact Map link lands on the first step unless a revision is named.
  // A plain commit SHA for a recorded PR means its first evidence stage.
  const sha = revs.includes(h.rev) && !(isLedger(pr) && h.rev === state.revisions.base.sha) ? h.rev : pr.commits[0].sha;
  $("prSelect").onchange = (ev) => {
    const next = state.revisions.prs.find((p) => p.id === ev.target.value);
    state.notice = null;
    load(next.id, next.commits[0].sha, { keepSelection: false });
  };
  if (h.sel) state.sel = { type: "node", id: h.sel, label: h.sel.split("#").pop() };
  await load(pr.id, sha, { keepSelection: Boolean(h.sel) });
}
init().catch((err) => {
  document.body.insertAdjacentHTML("afterbegin", `<div class="notice">Could not load the demo: ${esc(err.message)}. Run <code>npm run setup</code>, then <code>npm start</code>.</div>`);
});
