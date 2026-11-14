// Code Review Impact Map - frontend. No framework. One model per (PR, revision).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (sha) => (sha ?? "").slice(0, 7);
const chip = (text, cls) => `<span class="chip ${esc(cls ?? text)}">${esc(text)}</span>`;

const state = { hidden: {}, revisions: null, prId: null, sha: null, level: "function", sel: null, model: null, notice: null, mapScope: "pr", full: null, fullStep: 0, fullRun: 0, fullTimer: null, blast: {} };
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
// Only the AI PR is shown. The author's commit message is no longer on screen (user's choice, 2026-11-14).
// A PR with no AI PR saved still falls back to the author's text, so the card is never empty.
function renderDescription() {
  const m = state.model, el = $("intentCard"), d = m.description;
  const body = d.ai
    ? `<div class="tags">${d.ai.tags.map((t) => `<span class="tag ${esc(t.tone)}">${esc(t.label)}</span>`).join("")}</div>
       <p class="lead">${rich(d.ai.summary)}</p>
       <dl class="desc-grid">${d.ai.sections.map((s) => `<dt>${esc(s.title)}</dt><dd>${rich(s.text)}</dd>`).join("")}</dl>
       <div class="byline">${esc(d.ai.generatedBy)}</div>`
    : `${d.author.text.split("\n\n").map((p) => `<p>${rich(p)}</p>`).join("")}
       <div class="byline">Written by: ${esc(d.author.by)}</div>`;
  el.innerHTML = `<div class="card-head"><div class="head-left"><h2>${d.ai ? "AI PR" : "Description"}</h2><span class="muted">${esc(m.pr.title)}</span></div>${cardToggle("intentCard")}</div>${body}${m.agent ? `<div class="byline">Agent snapshot (demo data): ${esc(m.agent.model)} · ${esc(m.agent.snapshot)} · <button type="button" class="link" data-ctx="1">context.md</button> (what the agent knew and decided)</div>` : ""}`;
  for (const b of el.querySelectorAll("[data-ctx]")) b.onclick = openContext;
}

// ---------- show / hide for the big cards: AI PR, Impact map, Review steps ----------
const cardToggle = (id) => `<button type="button" class="card-toggle" data-card="${id}" aria-expanded="${!state.hidden?.[id]}">${state.hidden?.[id] ? "▸ Show" : "▾ Hide"}</button>`;
function applyCardToggles() {
  for (const id of ["intentCard", "mapCard", "reviewCard"]) {
    const hidden = Boolean(state.hidden?.[id]);
    $(id)?.classList.toggle("collapsed", hidden);
    const b = $(id)?.querySelector(".card-toggle");
    if (b) {
      b.textContent = hidden ? "▸ Show" : "▾ Hide";
      b.setAttribute("aria-expanded", String(!hidden));
    }
  }
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest?.(".card-toggle");
  if (!b) return;
  state.hidden = { ...state.hidden, [b.dataset.card]: !state.hidden?.[b.dataset.card] };
  applyCardToggles();
  // The map is drawn to fit its box, so draw it again when it comes back.
  if (b.dataset.card === "mapCard" && !state.hidden.mapCard) renderGraph();
});

// ---------- graph ----------
// Two ways to draw, picked by level (see drawGraph):
// - Concepts and Files: boxes, drawn by React Flow + Dagre (src/graph/main.jsx -> graph.bundle.js).
// - Functions: dots, drawn the Graphify way. Graphify's own graph.html draws its graph.json with
//   vis-network 9.1.6: dots sized by how many links they have, a force layout (forceAtlas2Based),
//   solid lines for links read from the code (EXTRACTED), dashed for links it guessed (INFERRED).
//   Same library (vendored, no CDN), same settings. A dot's colour shows its review state.
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
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const gfy = { network: null, nodeSet: null, edgeSet: null, key: null, look: null, fontScale: 1, timer: null, onNode: null, onEdge: null, nodeIds: new Set(), edgeIds: new Set() };
const isUnitTest = (n) => n.type === "testfile" || n.type === "test" || n.id === "concept:tests";
/** Show which dot or link is picked, without redrawing (so the layout and zoom stay put). */
function markSelection() {
  const sel = state.sel;
  gfy.network.unselectAll();
  if (["node", "fullnode"].includes(sel?.type) && gfy.nodeIds.has(sel.id)) gfy.network.selectNodes([sel.id], false);
  else if (sel?.type === "edge" && gfy.edgeIds.has(sel.id)) gfy.network.selectEdges([sel.id]);
}
function dropDots() {
  clearInterval(gfy.timer);
  gfy.network?.destroy();
  gfy.network = null;
  gfy.key = null;
}
/** Picks the drawing for the level: dots (Graphify way) for Functions, boxes (React Flow) for Concepts and Files. */
function drawGraph(nodes, edges, onNode, onEdge) {
  const dots = state.level === "function";
  $("graphFlow").hidden = dots;
  $("graphVis").hidden = !dots;
  $("graphWrap").parentElement.dataset.draw = dots ? "dots" : "boxes";
  if (dots) return drawDots($("graphVis"), nodes, edges, onNode, onEdge);
  dropDots();
  drawBoxes($("graphFlow"), nodes, edges, onNode, onEdge);
}
function drawDots(el, nodes, allEdges, onNode, onEdge) {
  const ids = new Set(nodes.map((n) => n.id));
  const edges = allEdges.filter((e) => ids.has(e.from) && ids.has(e.to));
  gfy.onNode = onNode;
  gfy.onEdge = onEdge;
  // key = what is on the map (a change rebuilds it). look = how it is coloured (a change only repaints, so dots stay put).
  const key = JSON.stringify([document.documentElement.dataset.theme, state.mapScope, state.fullRun, nodes.map((n) => n.id), edges.map((e) => [e.id, e.resolution])]);
  const look = JSON.stringify(nodes.map((n) => [n.state, n.evidence, n.badge, n.now]));

  const C = Object.fromEntries(["ink", "muted", "line", "card", "bg", "soft", "edited", "down", "bad", "req", "test"].map((k) => [k, cssVar(`--${k}`)]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const lit = (n) => n.state !== "none" || n.type === "pr" || n.type === "requirement";
  const degree = new Map();
  for (const e of edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const maxDeg = Math.max(1, ...degree.values());
  const crowded = nodes.length > 40;

  const visNodes = nodes.map((n, i) => {
    const deg = degree.get(n.id) ?? 0;
    const anchor = n.type === "pr" || n.type === "requirement";
    const fill = n.evidence === "contradicted" ? C.bad : n.state === "edited" ? C.edited : n.state === "downstream" ? C.down : n.type === "pr" ? C.ink : n.type === "requirement" ? C.req : isUnitTest(n) ? C.card : C.line;
    const border = n.now ? C.ink : lit(n) ? fill : isUnitTest(n) ? C.test : C.muted;
    const badge = badgeFor(n);
    return {
      id: n.id,
      label: clip(n.type === "pr" ? n.label.split(":")[0] : n.label, 30),
      title: [n.label, n.sub, badge?.[0]].filter(Boolean).join("\n"),
      shape: anchor ? "diamond" : "dot",
      // Graphify's rule: a dot grows with the number of links it has. A dot edited in this step is bigger and glows.
      size: (anchor ? 13 : 9 + 19 * (deg / maxDeg)) * (n.now ? 1.35 : 1),
      color: { background: fill, border, highlight: { background: fill, border: C.ink }, hover: { background: fill, border: C.ink } },
      borderWidth: n.now ? 3.5 : lit(n) ? 1.5 : 1.2,
      borderWidthSelected: 4,
      shadow: n.now ? { enabled: true, color: fill, size: 26, x: 0, y: 0 } : { enabled: false },
      // On a crowded map, Graphify only names the busy dots. The rest show their name on hover.
      font: { size: crowded && !lit(n) && deg < maxDeg * 0.15 ? 0 : lit(n) ? 15 : 13, color: lit(n) ? C.ink : C.muted, face: "system-ui, Segoe UI, sans-serif", strokeWidth: 3, strokeColor: C.bg },
      // Graphify's start positions: a spiral. The same graph always settles the same way.
      x: 30 * Math.sqrt(i) * Math.cos(i * 2.4),
      y: 30 * Math.sqrt(i) * Math.sin(i * 2.4),
    };
  });
  const name = (id) => byId.get(id)?.label ?? id;
  const visEdges = edges.map((e) => {
    const call = e.kind === "calls" || e.kind === "tests";
    const guessed = call && e.resolution === "inferred";
    const faint = !(lit(byId.get(e.from)) || lit(byId.get(e.to)));
    const title = call
      ? [`${name(e.from)} uses ${name(e.to)}`, guessed ? `Guessed by Graphify${e.score ? ` (${Math.round(e.score * 100)}% sure)` : ""}` : "Read from the code", e.count > 1 ? `${e.count} links between functions${e.extracted !== undefined ? `: ${e.extracted} read from the code, ${e.count - e.extracted} guessed` : ""}` : "", e.site ?? ""].filter(Boolean).join("\n")
      : e.kind === "edits" ? `This PR edits ${name(e.to)} (from the list of changed lines)` : "This PR is the fix for this issue";
    return {
      id: e.id, from: e.from, to: e.to, title,
      // Graphify's rule: solid = read from the code, dashed = guessed.
      dashes: guessed ? [7, 5] : call ? false : [2, 4],
      width: guessed ? 1.3 : call ? 2 : 1.2,
      color: { color: C.muted, opacity: faint ? 0.3 : guessed ? 0.8 : call ? 0.85 : 0.75, highlight: C.ink, hover: C.ink },
      arrows: { to: { enabled: true, scaleFactor: 0.5 } },
    };
  });
  // A big graph is zoomed out to fit. Grow the names so they can still be read.
  const grow = (font) => ({ ...font, size: font.size ? Math.min(30, Math.round(font.size * gfy.fontScale)) : 0 });

  if (gfy.network && gfy.key === key && el.querySelector(".gfy-canvas")) {
    if (gfy.look !== look) {
      // Same dots, new colours (a step on the Full map): repaint in place.
      gfy.look = look;
      gfy.nodeSet.update(visNodes.map(({ x, y, ...n }) => ({ ...n, font: grow(n.font) })));
      gfy.edgeSet.update(visEdges);
    }
    return markSelection();
  }
  dropDots();
  gfy.key = key;
  gfy.look = look;
  gfy.fontScale = 1;
  gfy.nodeIds = ids;
  gfy.edgeIds = new Set(edges.map((e) => e.id));

  el.innerHTML = `<div class="gfy-canvas" role="img" aria-label="Impact map graph"></div>
    <div class="gfy-zoom"><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="fit">Fit</button></div>`;
  const canvas = el.querySelector(".gfy-canvas");
  // Every dot starts hidden. Once the layout has settled, the dots come in a few at a time, busiest first.
  const nodeSet = new vis.DataSet(visNodes.map((n) => ({ ...n, hidden: true })));
  const edgeSet = new vis.DataSet(visEdges);
  const network = new vis.Network(canvas, { nodes: nodeSet, edges: edgeSet }, {
    physics: {
      enabled: true,
      solver: "forceAtlas2Based",
      forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.005, springLength: 95, springConstant: 0.08, damping: 0.4, avoidOverlap: 0.8 },
      stabilization: { iterations: 300, fit: true },
    },
    // The mouse wheel scrolls the page, so zoom is on the buttons.
    interaction: { hover: true, tooltipDelay: 100, zoomView: false, dragView: true, navigationButtons: false, keyboard: false, selectConnectedEdges: false },
    nodes: { shape: "dot", borderWidth: 1.5 },
    edges: { smooth: { type: "continuous", roundness: 0.2 }, selectionWidth: 2, hoverWidth: 1 },
  });
  gfy.network = network;
  gfy.nodeSet = nodeSet;
  gfy.edgeSet = edgeSet;
  // Like Graphify: once the layout has settled, stop the physics so dots stay where you drag them.
  network.once("stabilizationIterationsDone", () => {
    network.setOptions({ physics: { enabled: false } });
    network.fit({ nodes: [...ids] });
    const scale = network.getScale();
    gfy.fontScale = scale < 0.85 ? 1 / scale : 1;
    const order = [...ids].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0));
    const per = Math.max(1, Math.ceil(order.length / 28));
    let i = 0;
    gfy.timer = setInterval(() => {
      const batch = order.slice(i, i + per);
      i += per;
      // Read the dots again: a step may have recoloured them while they were coming in.
      nodeSet.update(nodeSet.get(batch).map((n) => ({ id: n.id, hidden: false, font: grow(n.font) })));
      if (i >= order.length) clearInterval(gfy.timer);
    }, 50);
  });
  network.on("click", (p) => {
    if (p.nodes.length) gfy.onNode(p.nodes[0]);
    else if (p.edges.length && gfy.onEdge) gfy.onEdge(p.edges[0]);
  });
  network.on("hoverNode", () => (canvas.style.cursor = "pointer"));
  network.on("blurNode", () => (canvas.style.cursor = ""));
  for (const b of el.querySelectorAll("[data-zoom]")) b.onclick = () => (b.dataset.zoom === "fit" ? network.fit({ animation: true }) : network.moveTo({ scale: network.getScale() * (b.dataset.zoom === "in" ? 1.3 : 1 / 1.3), animation: true }));
  markSelection();
}
/** Under the graph: where the links come from, and what Graphify missed. */
function renderGraphNote(edges) {
  const m = state.model, el = $("gfyNote"), full = state.mapScope === "full";
  const g = full ? state.full.graphify : m.graphify;
  if (!g) {
    el.innerHTML = `<span class="tag warn">Recorded graph</span> No saved Graphify run for this view. The links come from the recorded data.`;
    return;
  }
  const calls = edges.filter((e) => e.kind === "calls");
  const guessed = calls.filter((e) => e.resolution === "inferred").length;
  const count = `On this view: ${calls.length - guessed} link${calls.length - guessed === 1 ? "" : "s"} read from the code, ${guessed} guessed.`;
  if (full) {
    el.innerHTML = `<span class="tag info">Saved Graphify graph</span> The links come from ${esc(g.tool)}, a tool that reads the code and maps it. It was run on the repo earlier and saved. This is not a live run.
      ${state.level === "concept" ? `Concepts use every call link in the whole repo (${g.full.calls.toLocaleString("en")} links at base commit <span class="mono">${short(g.revision)}</span>), plus the references in the project files.` : `This level joins the saved graphs of the 4 PRs.`} ${count}`;
    return;
  }
  const li = (x, why) => `<li><code>${esc(x.label)}</code> <span class="mono muted">${esc(x.file.split("/").pop())}:${x.line}</span>${why ? ` · ${esc(why)}` : ""}</li>`;
  el.innerHTML = `<span class="tag info">Saved Graphify graph</span> The links come from ${esc(g.tool)}, a tool that reads the code and maps it. It was run on the code of this PR (commit <span class="mono">${short(g.revision)}</span>) and saved. This is not a live run.
    ${count} <a href="/api/graphify?pr=${encodeURIComponent(state.prId)}" target="_blank" rel="noopener">Open the saved graph.json</a>
    ${g.missed.length ? `<details><summary>Graphify did not find ${g.missed.length} thing${g.missed.length === 1 ? "" : "s"} that the compiler data has</summary><div class="muted">The compiler data (Roslyn, recorded earlier) knows every use of every name. Graphify reads the text of the code, so it can miss some.</div><ul>${g.missed.map((x) => li(x, x.reason)).join("")}</ul></details>` : ""}
    ${g.added.length ? `<details><summary>Graphify found ${g.added.length} caller${g.added.length === 1 ? "" : "s"} that the compiler data does not list</summary><ul>${g.added.map((x) => li(x)).join("")}</ul></details>` : ""}`;
}
function renderGraph() {
  const m = state.model;
  for (const b of $("levelTabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.level === state.level);
    b.onclick = () => {
      state.level = b.dataset.level;
      if (state.sel?.type === "node" && !m.graph.nodes.some((n) => n.id === state.sel.id && n.level === state.level)) state.sel = null;
      if (["edge", "fullnode", "blast"].includes(state.sel?.type)) state.sel = null;
      writeHash();
      render();
    };
  }
  const full = state.mapScope === "full";
  for (const b of $("scopeTabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.scope === state.mapScope);
    b.onclick = () => setScope(b.dataset.scope);
  }
  // The "Blast radius" tab has its own picture (renderBlast). The map and its legends are hidden by CSS.
  const blast = state.mapScope === "blast";
  $("mapCard").dataset.scope = state.mapScope;
  $("blastView").hidden = !blast;
  $("swarmView").hidden = !blast;
  if (!blast) stopSwarm();
  else if (swarmUI.pr !== state.prId) renderSwarm();
  $("fullBar").hidden = !full;
  if (blast) return renderBlast();
  $("legendPr").hidden = full;
  $("legendFull").hidden = !full;
  if (full) return renderFull();
  const edges = m.graph.edges.filter((e) => e.level === state.level);
  drawGraph(m.graph.nodes.filter((n) => n.level === state.level), edges, selectNode, (id) => select({ type: "edge", id }));
  renderGraphNote(edges);
}
/** Hands the boxes and links to the React Flow graph (src/graph/main.jsx, built into graph.bundle.js). */
function drawBoxes(el, nodes, edges, onNode, onEdge) {
  const affected = (n) => n.state !== "none" || n.type === "pr" || n.type === "requirement";
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // A test is "in focus" when it reaches something affected.
  const focusTests = new Set(edges.filter((e) => e.kind === "tests" && affected(nodeById.get(e.to) ?? {})).map((e) => e.from));
  const lit = (n) => Boolean(n) && (affected(n) || focusTests.has(n.id));
  const full = state.mapScope === "full";
  window.ImpactGraph.render(el, {
    // The graph forms and fits itself again only when this key changes. A step on the Full map keeps it.
    viewKey: full ? `full|${state.level}|${state.fullRun}` : `pr|${state.prId}|${state.sha}|${state.level}`,
    nodes: nodes.map((n) => ({
      id: n.id, type: n.type, state: n.state ?? "none", label: n.label, sub: n.sub ?? "",
      badge: badgeFor(n), isNew: n.change === "added", failing: n.evidence === "contradicted", dim: !full && !lit(n), now: Boolean(n.now),
      selected: ["node", "fullnode"].includes(state.sel?.type) && state.sel.id === n.id,
    })),
    edges: edges.map((e) => ({
      id: e.id, from: e.from, to: e.to, kind: e.kind,
      inferred: e.resolution === "inferred" && e.kind === "calls", added: e.change === "added",
      dim: !full && !(lit(nodeById.get(e.from)) && lit(nodeById.get(e.to))),
      selected: state.sel?.type === "edge" && state.sel.id === e.id,
      title: `${e.kind}${e.change === "added" ? " · new in this PR" : ""}${e.anchor ? ` · ${e.anchor.file}:${e.anchor.line}` : ""}`,
    })),
    onNode,
    onEdge,
  });
}

// ---------- full map: the whole repo, with commits from every PR laid over it ----------
async function setScope(scope, { play = true } = {}) {
  state.mapScope = scope;
  state.sel = null;
  stopFull();
  if (scope === "full") {
    state.level = "concept";
    if (!state.full) state.full = await api("/api/fullmap");
    if (play) playFull(0);
  }
  if (scope === "blast") state.level = "file";
  writeHash();
  render();
}
// The Full map is a film: step 0 is the repo before any PR, then one commit is added per step.
const FULL_STEP_MS = 2600;
function stopFull() {
  clearInterval(state.fullTimer);
  state.fullTimer = null;
}
function playFull(from) {
  stopFull();
  if (from !== undefined) {
    state.fullStep = from;
    state.fullRun++; // a new run: the graph forms again
  }
  state.fullTimer = setInterval(() => {
    if (state.mapScope !== "full") return stopFull();
    if (state.fullStep < state.full.commits.length) state.fullStep++;
    if (state.fullStep >= state.full.commits.length) stopFull();
    renderGraph();
  }, FULL_STEP_MS);
}
const FULL_HINT = {
  concept: "Whole repo, by area. A link means one area uses the other.",
  file: "Every file a demo PR edits or reaches. The rest of the repo is not indexed at this level.",
  function: "Every function a demo PR edits or reaches. The rest of the repo is not indexed at this level.",
};
function renderFull() {
  const f = state.full, level = state.level, last = f.commits.length;
  const step = (state.fullStep = Math.max(0, Math.min(last, state.fullStep)));
  const cur = step ? f.commits[step - 1] : null;
  $("fullHint").textContent = `${FULL_HINT[level]} Snapshot of ${f.repo}: ${f.totals.files} files, taken ${f.takenAt.slice(0, 10)}.`;
  $("fullStep").innerHTML = cur
    ? `<strong>Step ${step} of ${last}</strong> · PR #${cur.prNumber} · commit ${cur.index} <span class="mono">${cur.short}</span>${cur.madeUp ? ` <span class="tag warn">made up</span>` : ""}<div class="muted">${esc(cur.message)}</div>`
    : `<strong>Start</strong> · the repo before any PR<div class="muted">Each step adds one commit. Press → or Play.</div>`;
  $("fullDots").innerHTML = Array.from({ length: last + 1 }, (_, i) => `<i class="${i <= step ? "on" : ""} ${i === step ? "cur" : ""}"></i>`).join("");
  const go = (to) => {
    stopFull();
    state.fullStep = to;
    renderGraph();
  };
  $("fullPrev").disabled = step === 0;
  $("fullNext").disabled = step === last;
  $("fullPrev").onclick = () => go(step - 1);
  $("fullNext").onclick = () => go(step + 1);
  const playing = Boolean(state.fullTimer);
  $("fullPlay").textContent = playing ? "❚❚ Pause" : step === last ? "↻ Replay" : "▶ Play";
  $("fullPlay").onclick = () => {
    if (playing) stopFull();
    else playFull(step === last ? 0 : undefined);
    renderGraph();
  };
  const picked = f.commits.slice(0, step);
  const now = new Set(cur?.edited[level] ?? []);
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
    return { ...n, now: now.has(n.id), state: editedBy ? "edited" : affected ? "downstream" : "none", badge: editedBy ? [now.has(n.id) ? "EDITED NOW" : `EDITED${editedBy > 1 ? ` · ${editedBy} COMMITS` : ""}`, "edited"] : affected ? ["AFFECTED", "info"] : null };
  });
  drawGraph(nodes, f.levels[level].edges, (id) => select({ type: "fullnode", id }), null);
  renderGraphNote(f.levels[level].edges);
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

// ---------- blast radius: 3 agents did the same task; the real change is laid over what they touched ----------
// Data: GET /api/blast?pr=<id> (recorded runs + the numbers, worked out in src/lib/blast.mjs).
const BLAST_ZONES = [
  ["wide", "Wide zone", "Only the agent that changes too much touched this."],
  ["normal", "Normal zone", "The normal agent touched this. The careful agent did not."],
  ["tight", "Tight zone", "The careful agent touched this."],
];
const BLAST_SHORT = { real: "Real change", minimal: "Careful", normal: "Normal", wide: "Changes too much" };
const BLAST_LEVEL = { concept: "code area", file: "file", function: "function" };
async function loadBlast() {
  const id = state.prId;
  if (!state.blast[id]) state.blast[id] = await api("/api/blast?pr=" + encodeURIComponent(id));
  return state.blast[id];
}
function selectBlast(id) {
  const b = state.blast[state.prId];
  const item = b?.items?.find((x) => x.id === id);
  if (!item) return;
  state.level = item.level;
  select({ type: "blast", id });
}
const blastPips = (by) => ["minimal", "normal", "wide"].map((a) => `<i class="pip pip-${a}${by[a] ? " on" : ""}" title="${esc(BLAST_SHORT[a])}${by[a] ? ": touched it" : ": did not touch it"}"></i>`).join("");
function blastBox(x) {
  const tags = [
    x.by.real ? `<span class="btag real">REAL CHANGE</span>` : "",
    x.agents === 3 ? `<span class="btag all">ALL 3 AGENTS</span>` : "",
    x.kind === "test" ? `<span class="btag">UNIT TEST</span>` : x.kind === "doc" ? `<span class="btag">DOC</span>` : "",
  ].join("");
  const sel = state.sel?.type === "blast" && state.sel.id === x.id;
  return `<button type="button" class="bbox${x.by.real ? " real" : ""}${sel ? " selected" : ""}" data-blast="${esc(x.id)}" title="${esc(x.sub)}">
    <span class="bbox-label">${esc(x.label)}</span>
    <span class="bbox-foot"><span class="pips">${blastPips(x.by)}</span>${tags}</span></button>`;
}
// The tab works at file level only: one box and one table row per file. Function numbers sit in a fold.
function renderBlast() {
  const el = $("blastView"), b = state.blast[state.prId];
  if (!b) {
    el.innerHTML = `<div class="muted">Loading…</div>`;
    const id = state.prId;
    loadBlast().then(() => {
      if (state.prId === id && state.mapScope === "blast") renderGraph();
    });
    return;
  }
  if (!b.recorded) {
    el.innerHTML = `<p class="blast-what">We give the same task to 3 agents: one careful, one normal, one that changes too much. What they touch is the "blast radius" of the task. Then we lay the real change over it.</p><div class="callout info">${esc(b.message)}</div>`;
    return;
  }
  const files = b.items.filter((x) => x.level === "file");
  const zoneRank = { tight: 0, normal: 1, wide: 2, outside: 3 };
  const sorted = (list) => [...list].sort((p, q) => zoneRank[p.zone] - zoneRank[q.zone] || (p.by.real ? 0 : 1) - (q.by.real ? 0 : 1) || p.label.localeCompare(q.label));
  const inZone = (z) => sorted(files.filter((x) => x.zone === z));
  const boxesOr = (boxes) => (boxes.length ? `<div class="bz-boxes">${boxes.map(blastBox).join("")}</div>` : `<div class="bz-empty">Nothing here.</div>`);
  const zoneHtml = (i) => {
    if (i >= BLAST_ZONES.length) return "";
    const [z, name, text] = BLAST_ZONES[i];
    return `<div class="bz bz-${z}"><div class="bz-title">${name} <span>${text}</span></div>${boxesOr(inZone(z))}${zoneHtml(i + 1)}</div>`;
  };
  const cols = b.columns;
  const num = (n) => Number(n).toLocaleString("en");
  const note = (html) => `<div class="cell-note">${html}</div>`;
  const delta = (f) => (f ? `<span class="plus">+${num(f.added)}</span> <span class="minus">−${num(f.removed)}</span>` : `<span class="none">·</span>`);
  const fileOf = (runId, file) => b.runs.find((r) => r.id === runId).files.find((f) => f.file === file);
  const zoneName = { tight: "Tight", normal: "Normal", wide: "Wide", outside: "Outside" };
  // ---- the main table: one row per file ----
  const fileRows = sorted(files).map((x) => `<tr class="pick" data-blast="${esc(x.id)}">
      <th><span class="zdot z-${x.zone}" title="${zoneName[x.zone]} zone"></span>${esc(x.label)}${x.kind === "test" ? ` <span class="btag">UNIT TEST</span>` : x.kind === "doc" ? ` <span class="btag">DOC</span>` : ""}</th>
      ${cols.map((c) => `<td class="${c.id === "real" ? "real" : ""}">${delta(fileOf(c.id, x.key))}</td>`).join("")}</tr>`).join("");
  const totalRow = `<tr class="total"><th>All files</th>${cols.map((c) => `<td class="${c.id === "real" ? "real" : ""}">${num(c.files)} file${c.files === 1 ? "" : "s"}${note(`<span class="plus">+${num(c.added)}</span> <span class="minus">−${num(c.removed)}</span>`)}</td>`).join("")}</tr>`;
  // ---- the fold: numbers below file level ----
  const list = (arr) => (arr.length ? arr.map(esc).join(", ") : "none");
  const fnName = (id) => `<code>${esc(id.split("#")[1].split("~")[0])}()</code>`;
  const reachCell = (c) => {
    const r = c.reach;
    if (r.of && !r.known) return `<span class="muted">not known</span>`;
    return num(r.callers.length) + (r.callers.length ? note(r.callers.map((x) => `<code>${esc(x.name)}()</code>`).join(", ")) : "") + (r.unknown.length ? note(`not known for ${r.unknown.length} of ${r.of} edited functions`) : "");
  };
  const row = (label, fn, sub) => `<tr><th>${label}${sub ? note(sub) : ""}</th>${cols.map((c) => `<td class="${c.id === "real" ? "real" : ""}">${fn(c)}</td>`).join("")}</tr>`;
  const wideRow = (label, html) => `<tr><th>${label}</th><td colspan="4" class="text">${html}</td></tr>`;
  const o = b.overlap;
  const things = (arr) => (arr.length ? arr.map((t) => `<code>${esc(t.label)}</code>${t.kind === "doc" ? " (doc)" : t.kind === "test" ? " (unit test)" : ""}`).join(", ") : "nothing");
  const head = `<thead><tr><th></th>${cols.map((c) => `<th class="${c.id === "real" ? "real" : ""}">${esc(c.label)}${c.id !== "real" && !c.ok ? note(`<span class="bad-text">the run failed</span>`) : c.noChange ? note("made no change") : ""}</th>`).join("")}</tr></thead>`;
  const secs = (r) => (r.startedAt && r.endedAt ? `${Math.max(1, Math.round((new Date(r.endedAt) - new Date(r.startedAt)) / 1000))} s` : "");
  // The picture and the table are always shown. The extras are small "show more" links.
  const fold = (id, title, hint, body) => (id === "zones" || id === "files" ? body : `<details class="blast-runs"><summary>${title}: ${hint}</summary>${body}</details>`);
  const realCol = cols.find((c) => c.id === "real");
  el.innerHTML = `<p class="blast-what">We gave the same task to 3 agents: one careful, one normal, one that changes too much. The coloured zones show the files they touched. The thick outline is the real change.</p>
    <div class="blast-label ${esc(b.label.tone)}"><span class="stamp-label">Trust label</span><strong>${esc(b.label.text)}</strong><span>${esc(b.label.how)}</span></div>
    ${fold("zones", "Zone picture", "Which files each agent touched, and where the real change sits", `
    <div class="blast-zones">${zoneHtml(0)}
      <div class="bz bz-outside"><div class="bz-title">Outside every zone <span>No agent touched this. Only the real change did.</span></div>${boxesOr(inZone("outside"))}</div>
    </div>
    <div class="legend blast-legend">
      <span><i class="pip pip-minimal on"></i> careful agent</span>
      <span><i class="pip pip-normal on"></i> normal agent</span>
      <span><i class="pip pip-wide on"></i> agent that changes too much</span>
      <span><i class="sw sw-real"></i> thick outline: the real change</span>
      <span class="muted">Click a file to see what each one changed in it.</span>
    </div>`)}
    ${fold("files", "Lines changed per file", `Real change: ${num(realCol.files)} files, +${num(realCol.added)} −${num(realCol.removed)}`, `
    <table class="blast-table files">${head}<tbody>${fileRows}${totalRow}</tbody></table>
    <div class="blast-key muted"><span class="plus">+</span> lines added, <span class="minus">−</span> lines removed, · not touched. The real change is Tieto's AI-written branch, shown as a PR. ${esc(b.notBuilt)}</div>`)}
    ${fold("numbers", "More numbers", "Functions, reach and overlap", `
      <table class="blast-table">${head}<tbody>
      ${row("Functions edited", (c) => num(c.functions) + (c.newFunctions ? note(`${c.newFunctions} of them new`) : ""), "in product code, not unit tests")}
      ${row("Unit test functions added or edited", (c) => num(c.testFunctions))}
      ${row("Functions that call an edited function", reachCell, "not edited, but what they do can change")}
      ${row("Code areas edited", (c) => `<span class="text">${list(c.conceptsEdited)}</span>`)}
      ${row("Files shared with the real change", (c) => (c.id === "real" ? num(o.realFiles) + note("files it touches") : `${num(c.sharedFiles.length)} of ${num(o.realFiles)}`))}
      ${row("Functions shared with the real change", (c) => (c.id === "real" ? num(o.realFunctions) + note("it edits, new ones not counted") : `${num(c.sharedFunctions.length)} of ${num(o.realFunctions)}${c.sharedFunctions.length ? note(c.sharedFunctions.map(fnName).join(", ")) : ""}`), "functions that already existed")}
      ${wideRow("The real change touched, no agent did", things(o.realOnly))}
      ${wideRow("Every agent touched, the real change did not", things(o.agentsNotReal))}
      </tbody></table>`)}
    ${fold("how", "How it was done", "The 3 runs, their prompts, and the rule for the label", `
      <p>Run on ${esc(b.recordedAt.slice(0, 10))} with the model <code>${esc(b.model)}</code>, once per agent. Each agent worked alone in its own copy of the code from before the fix (commit <code>${esc(short(b.base))}</code>). The real fix was not in those copies. This tab replays the saved result. No agent runs now.</p>
      <p><b>Rule for the trust label.</b> We look at the product code files the real change touches (not docs, not unit tests). If no agent touched one of them: "Touches code no agent touched". Else, if only the agent that changes too much touched one of them: "Touches more than needed". Else: "Inside the expected zone".</p>
      <p><b>What every agent got.</b> ${b.given.kept.map(esc).join("; ")}.</p>
      <p><b>What we left out of the AI PR text</b>, so the agents could not copy the real fix: ${b.given.leftOut.map(esc).join("; ")}. ${esc(b.given.note)}</p>
      ${b.runs.filter((r) => r.id !== "real").map((r) => `<div class="blast-run"><b>${esc(r.label)}</b> <span class="muted">${secs(r) ? `· took ${secs(r)}` : ""}</span><div>Told: ${esc(r.instruction ?? "")}</div>
        <details><summary>What it said when it was done</summary><pre class="raw doc">${esc(r.reply ?? "No reply was saved.")}</pre></details>
        <details><summary>The full prompt, word for word</summary><pre class="raw doc">${esc(r.prompt ?? "")}</pre></details></div>`).join("")}
      <p class="muted">${esc(b.how.functions)} Callers come from ${esc(b.graphTool ?? "the recorded data")} (a saved run) and the recorded compiler data for this PR.</p>`)}`;
  for (const btn of el.querySelectorAll("[data-blast]")) btn.onclick = () => selectBlast(btn.dataset.blast);
}
/** Side panel for one box: what each of the 4 changes did there. */
function blastSideHtml(id) {
  const b = state.blast[state.prId];
  const x = b?.items?.find((i) => i.id === id);
  if (!x) return "";
  const who = (item) => b.order.filter((r) => item.by[r]).map((r) => BLAST_SHORT[r]).join(", ");
  const head = `<h2>${esc(x.label)}</h2><div class="where mono">${esc(x.level === "function" ? x.file : x.sub)}</div><div class="callout info">Touched by: ${esc(who(x))}.</div>`;
  if (x.level === "concept") {
    const files = b.items.filter((i) => i.level === "file" && x.files.includes(i.key));
    return `${head}<h3>Files touched in this code area</h3><ul class="list">${files.map((f) => `<li><button type="button" class="link" data-blast="${esc(f.id)}">${esc(f.label)}</button> <span class="muted">${esc(who(f))}</span></li>`).join("")}</ul>`;
  }
  const file = x.level === "function" ? x.file : x.key;
  let body = head;
  for (const r of b.runs) {
    const f = r.files.find((y) => y.file === file);
    let hunks = f ? parseHunks(f.patch) : [];
    if (x.level === "function") {
      const fn = x.by[r.id] ? f?.functions.find((y) => y.key === x.fnKey && Boolean(y.isNew) === x.isNew) : null;
      hunks = fn ? hunks.filter((h) => h.lines.some((l) => l.t && l.at >= fn.line && l.at <= fn.endLine)) : [];
    }
    body += `<h3>${esc(r.label)}</h3>${hunks.length
      ? changeBlock(file, hunks, x.level === "function" ? "before → after" : `${f.added} added, ${f.removed} removed`)
      : `<div class="muted">Did not touch this ${x.level === "function" ? "function" : "file"}.</div>`}`;
  }
  return body;
}

// ---------- Monte Carlo swarm: the same task, many agents, how often do they land near the real change? ----------
// Data: GET /api/swarm?pr=<id> (recorded runs, scored in src/lib/swarm.mjs). The button replays them. No agent runs now.
// You can pick any model and 1 to 10 agents. Only recorded runs are ever shown: when the pick is not recorded,
// Run goes back to the demo set and says so.
const swarmUI = { pr: null, data: null, model: null, count: null, timers: [], note: null };
function stopSwarm() {
  for (const t of swarmUI.timers) clearTimeout(t);
  swarmUI.timers = [];
}
const swarmSet = (id) => swarmUI.data.sets.find((x) => x.id === id);
const swarmRun = (key) => swarmUI.data.runs.find((r) => r.key === key);
function swarmDefault() {
  const s = swarmUI.data;
  swarmUI.model = s.defaultSet;
  swarmUI.count = swarmSet(s.defaultSet).runs.length;
}
async function renderSwarm({ autoplay = false, model = null, count = null } = {}) {
  const el = $("swarmView");
  if (swarmUI.pr !== state.prId) {
    stopSwarm();
    swarmUI.pr = state.prId;
    swarmUI.data = null;
    swarmUI.note = null;
    el.innerHTML = "";
    swarmUI.data = await api("/api/swarm?pr=" + encodeURIComponent(state.prId));
    if (swarmUI.pr !== state.prId) return;
    if (swarmUI.data.recorded) swarmDefault();
  }
  const s = swarmUI.data;
  const wrap = (body) => `<div class="swarm"><div class="swarm-head"><h3>Monte Carlo swarm</h3><span class="muted">Give the same task to many agents. How often does one end up close to the real change?</span></div>${body}</div>`;
  if (!s?.recorded) {
    el.innerHTML = wrap(`<div class="muted">${esc(s?.message ?? "")}</div>`);
    return;
  }
  const label = (id) => (s.choiceLabels[id] ?? swarmSet(id)?.label ?? id);
  const def = swarmSet(s.defaultSet);
  el.innerHTML = wrap(`
    <div class="swarm-controls">
      <label>Model <select id="swarmModel">${s.choices.map((id) => `<option value="${esc(id)}" ${id === swarmUI.model ? "selected" : ""}>${esc(label(id))}</option>`).join("")}</select></label>
      <label>Agents <select id="swarmCount">${Array.from({ length: s.maxAgents }, (_, i) => i + 1).map((n) => `<option value="${n}" ${n === swarmUI.count ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <button type="button" class="primary" id="swarmGo">▶ Run Monte Carlo swarm</button>
    </div>
    <div class="muted swarm-rec">Replays runs recorded ${esc(s.recordedAt.slice(0, 10))}. No agent runs now. Plays by default: ${esc(def.label)}.</div>
    <div id="swarmNote" class="swarm-note" ${swarmUI.note ? "" : "hidden"}>${esc(swarmUI.note ?? "")}</div>
    <div id="swarmStage" class="swarm-stage" hidden></div>`);
  $("swarmModel").onchange = (ev) => {
    stopSwarm();
    swarmUI.model = ev.target.value;
  };
  $("swarmCount").onchange = (ev) => {
    stopSwarm();
    swarmUI.count = Number(ev.target.value);
  };
  $("swarmGo").onclick = () => playSwarm();
  if (autoplay) {
    // A deep link can pick the model and the count first (&model=<id>&n=<count>).
    if (model) swarmUI.model = model;
    if (count) swarmUI.count = count;
    playSwarm();
  }
}
function playSwarm() {
  stopSwarm();
  const s = swarmUI.data;
  // Play the pick if it is recorded. Otherwise go back to the demo set, and say so.
  const picked = swarmSet(swarmUI.model);
  if (!picked || swarmUI.count > picked.runs.length) {
    const want = `${swarmUI.count} × ${swarmUI.model === "mix" ? "the mix" : s.choiceLabels[swarmUI.model] ?? swarmUI.model}`;
    swarmDefault();
    swarmUI.note = `${want} is not recorded for this demo, so this plays the recorded set: ${swarmSet(swarmUI.model).label}.`;
    renderSwarm();
  } else swarmUI.note = null;
  const note = $("swarmNote");
  note.hidden = !swarmUI.note;
  note.textContent = swarmUI.note ?? "";
  const runs = swarmSet(swarmUI.model).runs.slice(0, swarmUI.count).map(swarmRun);
  // Second score per agent: how like the other agents it is (average over the others, by files and functions).
  const peers = runs.map((r, i) => {
    const others = runs.filter((_, j) => j !== i);
    return others.length ? Math.round(others.reduce((a, o) => a + swarmJac(r.things, o.things), 0) / others.length) : null;
  });
  const stage = $("swarmStage");
  stage.hidden = false;
  const fast = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const later = (ms, fn) => swarmUI.timers.push(setTimeout(fn, fast ? 0 : ms));
  // Stacked dots: runs with the same score sit on top of each other.
  const seen = new Map();
  const stack = runs.map((r) => {
    const k = seen.get(r.score) ?? 0;
    seen.set(r.score, k + 1);
    return k;
  });
  const set = swarmSet(swarmUI.model);
  stage.innerHTML = `${set.madeUp ? `<div class="swarm-madeup"><span class="tag warn">Made up for the demo</span> ${esc(set.note)}</div>` : ""}<div class="swarm-flow">
      <div class="swarm-req" id="swarmReq"><b>Requirements</b><span>Same text for every agent</span></div>
      <div class="swarm-agents">${runs.map((r, i) => `<button type="button" class="swarm-agent" data-run="${esc(r.key)}">
        <span class="swarm-name">Agent ${i + 1}<span class="swarm-model">${esc(r.modelLabel)}${r.madeUp ? " · made up" : ""}</span></span>
        <span class="swarm-bar"><i></i></span>
        <span class="swarm-status">waiting</span></button>`).join("")}</div>
    </div>
    <div class="swarm-scale">
      <div class="swarm-scale-label muted">How similar each agent's change is to the real change</div>
      <div class="swarm-track">
        <div class="swarm-near" style="left:${s.similarAt}%"><span>similar</span></div>
        <div class="swarm-real" style="left:100%" title="The real change"><span>Real change</span></div>
        ${runs.map((r, i) => `<button type="button" class="swarm-dot" data-run="${esc(r.key)}" style="left:${r.score}%;bottom:${8 + stack[i] * 16}px" title="Agent ${i + 1} (${esc(r.modelLabel)}): ${r.score}% similar"></button>`).join("")}
      </div>
      <div class="swarm-axis"><span style="left:0">0%</span><span style="left:50%">50%</span><span style="left:100%">100%</span></div>
    </div>
    <div class="swarm-result" id="swarmResult" hidden></div>`;
  for (const b of stage.querySelectorAll("[data-run]")) b.onclick = () => select({ type: "swarm", key: b.dataset.run, agent: runs.findIndex((r) => r.key === b.dataset.run) + 1 });
  const rows = [...stage.querySelectorAll(".swarm-agent")];
  const dots = [...stage.querySelectorAll(".swarm-dot")];
  // 1. The requirements go out to every agent, one after the other.
  later(100, () => $("swarmReq").classList.add("sending"));
  let end = 0;
  runs.forEach((r, i) => {
    const start = 400 + i * 220;
    // 2. Each agent works for its recorded time, sped up (1 second of the run = 0.1 s here, kept between 1.2 and 4 s).
    const work = Math.min(4000, Math.max(1200, (r.seconds ?? 20) * 100));
    later(start, () => {
      rows[i].classList.add("working");
      rows[i].style.setProperty("--work", `${work}ms`);
      rows[i].querySelector(".swarm-status").textContent = "reading the task, then writing a fix…";
    });
    // 3. It lands on the scale.
    later(start + work, () => {
      rows[i].classList.remove("working");
      rows[i].classList.add("done", r.similar ? "near" : "far");
      rows[i].querySelector(".swarm-status").innerHTML = !r.ok ? `<span class="bad-text">the run failed</span>` : r.noChange
        ? "made no change"
        : `${r.files} file${r.files === 1 ? "" : "s"} · <span class="plus">+${r.added}</span> <span class="minus">−${r.removed}</span> · <b>${r.score}%</b> like the real change${peers[i] === null ? "" : ` · <b>${peers[i]}%</b> like the other agents`}`;
      dots[i].classList.add("in", r.similar ? "near" : "far");
    });
    end = Math.max(end, start + work);
  });
  // 4. The answer.
  later(end + 500, () => {
    const near = runs.filter((r) => r.similar).length;
    let pairs = 0, sum = 0;
    for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
      pairs++;
      sum += swarmJac(runs[i].things, runs[j].things) / 100;
    }
    const count = (list) => {
      const m = new Map();
      for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1])[0];
    };
    const topMiss = count(runs.flatMap((r) => r.missed));
    const topExtra = count(runs.flatMap((r) => r.extra));
    const avg = Math.round(runs.reduce((a, r) => a + r.score, 0) / runs.length);
    const tone = near / runs.length >= 0.7 ? "ok" : near / runs.length >= 0.4 ? "warn" : "bad";
    const byModel = [...new Set(runs.map((r) => r.modelLabel))].map((l) => {
      const mine = runs.filter((r) => r.modelLabel === l);
      return `${l}: ${mine.filter((r) => r.similar).length} of ${mine.length}`;
    });
    const res = $("swarmResult");
    res.hidden = false;
    res.innerHTML = `<div class="blast-label ${tone}"><span class="stamp-label">Swarm result${runs.some((r) => r.madeUp) ? " · made up for the demo" : ""}</span>
        <strong>${near} of ${runs.length} agent${runs.length === 1 ? "" : "s"} ended up similar to the real change</strong>
        <span>"Similar" means ${s.similarAt}% or more. Average similarity: ${avg}%.${pairs ? ` The agents agree with each other ${Math.round((sum / pairs) * 100)}% of the time.` : ""}${byModel.length > 1 ? ` By model: ${byModel.join(" · ")}.` : ""}</span></div>
      <ul class="swarm-facts">
        ${topMiss ? `<li><b>The real change does this, the agents did not:</b> <code>${esc(topMiss[0])}</code> (missed by ${topMiss[1]} of ${runs.length})</li>` : `<li>Every agent touched everything the real change touched.</li>`}
        ${topExtra ? `<li><b>Agents did this, the real change did not:</b> <code>${esc(topExtra[0])}</code> (${topExtra[1]} of ${runs.length})</li>` : `<li>No agent touched code the real change left alone.</li>`}
        <li class="muted">${esc(s.notBuilt)}</li>
      </ul>
      <div id="swarmMatrix" class="swarm-matrix"></div>
      <details class="blast-runs"><summary>How similarity is worked out</summary>
        <p><b>By files and functions</b> (the main score). We list what each change touches in product code (not docs, not unit tests): the files, and the functions in them that already existed. The real change touches: ${s.real.map((x) => `<code>${esc(x)}</code>`).join(", ")}. Similarity = things both changes touch, divided by things either one touches. 100% means the very same files and functions.</p>
        <p><b>By changed lines.</b> We list every code line each change adds or removes in product code (blank lines left out, spaces squeezed). Similarity = lines both changes add or remove, divided by lines either one does. This one sees inside a function: two different fixes in the same function score low. The real change adds or removes ${s.realLines.length} lines.</p>
        <p>${esc(s.how)}</p>
        <details><summary>The prompt every agent got, word for word</summary><pre class="raw doc">${esc(s.prompt.text)}</pre></details>
      </details>`;
    renderSwarmMatrix(runs);
  });
}
/** Jaccard of two lists, in whole percent: shared / all. */
function swarmJac(a, b) {
  const A = new Set(a), all = new Set([...a, ...b]);
  return all.size ? Math.round((100 * b.filter((x) => A.has(x)).length) / all.size) : 100;
}
/** Every pair compared: the real change and each agent, rows and columns. Two ways to measure. */
function renderSwarmMatrix(runs) {
  const el = $("swarmMatrix"), s = swarmUI.data;
  if (!el) return;
  const measure = swarmUI.measure ?? "things";
  const rows = [{ key: "real", name: "Real change", sub: "Tieto's AI-written branch", set: measure === "things" ? s.realThings : s.realLines }, ...runs.map((r, i) => ({ key: r.key, name: `Agent ${i + 1}`, sub: r.modelLabel + (r.madeUp ? " · made up" : ""), set: measure === "things" ? r.things : r.lines }))];
  const cell = (a, b) => {
    if (a.key === b.key) return `<td class="self">—</td>`;
    const v = swarmJac(a.set, b.set);
    return `<td style="--v:${v}%" title="${esc(a.name)} and ${esc(b.name)}: ${v}% alike">${v}%</td>`;
  };
  const avgOthers = (a) => {
    const others = rows.filter((b) => b.key !== a.key && b.key !== "real");
    return others.length ? `${Math.round(others.reduce((x, b) => x + swarmJac(a.set, b.set), 0) / others.length)}%` : "—";
  };
  el.innerHTML = `<div class="swarm-matrix-head"><h3>Who is like whom</h3>
      <div class="tabs" role="tablist"><button type="button" data-measure="things" class="${measure === "things" ? "active" : ""}">Files and functions</button><button type="button" data-measure="lines" class="${measure === "lines" ? "active" : ""}">Changed lines</button></div></div>
    <div class="muted swarm-matrix-sub">${measure === "things" ? "How alike two changes are by the files and functions they touch." : "How alike two changes are by the exact code lines they add or remove."} Darker = more alike. Row 1 is each agent against the real change.</div>
    <table class="swarm-table"><thead><tr><th></th>${rows.map((b) => `<th class="${b.key === "real" ? "real" : ""}">${esc(b.name)}<div class="cell-note">${esc(b.sub)}</div></th>`).join("")}<th class="avg">Average with the other agents</th></tr></thead>
    <tbody>${rows.map((a) => `<tr class="${a.key === "real" ? "real" : ""}"><th>${esc(a.name)}<div class="cell-note">${esc(a.sub)}</div></th>${rows.map((b) => cell(a, b)).join("")}<td class="avg">${avgOthers(a)}</td></tr>`).join("")}</tbody></table>`;
  for (const b of el.querySelectorAll("[data-measure]")) b.onclick = () => {
    swarmUI.measure = b.dataset.measure;
    renderSwarmMatrix(runs);
  };
}
/** Side panel for one swarm agent: its score and its change. */
function swarmSideHtml(sel) {
  const r = swarmUI.data?.runs.find((x) => x.key === sel.key);
  if (!r) return "";
  const list = (arr) => (arr.length ? arr.map((x) => `<code>${esc(x)}</code>`).join(", ") : "nothing");
  return `<h2>Agent ${sel.agent ?? r.n} · ${esc(r.modelLabel)}</h2><div class="where">Monte Carlo swarm · ${r.madeUp ? "made up for the demo" : `took ${r.seconds ?? "?"} s · recorded ${esc(swarmUI.data.recordedAt.slice(0, 10))}`}</div>${r.madeUp ? `<div class="callout bad">${esc(r.reply)}</div>` : ""}
    <div class="callout ${r.similar ? "ok" : "bad"}"><strong>${r.score}% like the real change</strong> by files and functions · <strong>${r.lineScore}%</strong> by changed lines.</div>
    <dl class="kv"><dt>Both touched</dt><dd>${list(r.shared)}</dd><dt>Only the real change</dt><dd>${list(r.missed)}</dd><dt>Only this agent</dt><dd>${list(r.extra)}</dd></dl>
    <h3>What it changed</h3>${r.changes.length ? r.changes.map((f) => changeBlock(f.file, parseHunks(f.patch), `${f.added} added, ${f.removed} removed`)).join("<div style='height:8px'></div>") : `<div class="muted">No change.</div>`}
    <details><summary>What it said when it was done</summary><pre class="raw doc">${esc(r.reply ?? "No reply was saved.")}</pre></details>`;
}

// ---------- AI review (advice only) ----------
function renderReview() {
  const m = state.model, el = $("reviewCard"), r = m.review;
  const cite = (c) => (c.valid ? `<button type="button" class="link mono" data-src="${esc(c.file)}" data-line="${c.line}">${esc(c.file)}:${c.line}</button>` : `<span class="mono bad-text" title="${esc(c.problem)}">${esc(c.file)}:${esc(c.line)} (invalid)</span>`);
  const c1 = m.classifier1, c2 = m.classifier2;
  const sev = (s) => `<span class="tag ${SEVERITY_TONE[s] ?? ""}">${esc(s)}</span>`;
  el.innerHTML = `<div class="card-head"><div class="head-left"><h2>Review steps</h2><span class="muted">The rules come from <button type="button" class="link" data-doc="REVIEW.md">REVIEW.md</button> and <button type="button" class="link" data-doc="review-policy.yml">review-policy.yml</button></span></div>${cardToggle("reviewCard")}</div>
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
  if (sel.type === "blast") return blastSideHtml(sel.id);
  if (sel.type === "swarm") return swarmSideHtml(sel);
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
  for (const b of el.querySelectorAll("[data-blast]")) b.onclick = () => selectBlast(b.dataset.blast);
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
  applyCardToggles();
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
    if (state.model) renderGraph(); // the graph's colours are set in code, so draw it again
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
  // ?hide=intentCard,mapCard,reviewCard starts with those cards hidden.
  for (const id of (q.get("hide") ?? "").split(",").filter(Boolean)) state.hidden[id] = true;
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
  if (q.get("map") === "blast") {
    // ?map=blast opens the "Blast radius" tab. &box=<box id> also opens that box in the side panel.
    await setScope("blast");
    await loadBlast();
    render();
    if (q.get("box")) selectBlast(q.get("box"));
    // &swarm=1 plays the Monte Carlo swarm (&model=<id>&n=<count> to pick first). &agent=<n> also opens that agent in the side panel.
    if (q.get("measure") === "lines") swarmUI.measure = "lines";
    if (q.get("swarm") === "1") {
      await renderSwarm({ autoplay: true, model: q.get("model"), count: Number(q.get("n")) || null });
      if (q.get("agent")) {
        // &agent=<n>: the n-th agent of the set that just played.
        const n = Number(q.get("agent"));
        const key = swarmSet(swarmUI.model)?.runs[n - 1];
        if (key) select({ type: "swarm", key, agent: n });
      }
    }
  }
  if (q.get("map") === "full") {
    // ?step=3 or ?commit=<sha> opens the Full map on that step, paused. No value: it plays from the start.
    const level = state.level;
    const fixed = q.get("step") !== null || q.get("commit") !== null;
    await setScope("full", { play: !fixed });
    if (q.get("step") !== null) state.fullStep = Number(q.get("step")) || 0;
    else if (q.get("commit")) state.fullStep = state.full.commits.findIndex((c) => c.sha === q.get("commit")) + 1;
    if (fixed && !h.level) render();
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
