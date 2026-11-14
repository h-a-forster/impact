// Code Review Impact Map - frontend. No framework. One model per (PR, revision).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (sha) => (sha ?? "").slice(0, 7);
const chip = (text, cls) => `<span class="chip ${esc(cls ?? text)}">${esc(text)}</span>`;

// The screen is a chat (see "chat" below). The AI PR, Impact map and Review steps cards live in the
// right panel and open only when asked for, so they are never collapsed (`hidden` stays false).
const state = { hidden: { intentCard: false, mapCard: false, reviewCard: false }, revisions: null, prId: null, sha: null, level: "file", sel: null, model: null, notice: null, mapScope: "pr", full: null, fullStep: 0, fullRun: 0, fullTimer: null, blast: {} };
const sourceCache = new Map();

// ---------- data ----------
// Session mode (?session=1): every API call carries the switch, so the server serves the shop sample.
const SESSION = new URLSearchParams(location.search).get("session") === "1";
async function api(path, opts) {
  if (SESSION) path += (path.includes("?") ? "&" : "?") + "session=1";
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
// In a session a person reviews one commit: later commits do not exist yet, and no other pull request is open.
const revList = () => currentPr().commits.filter((c) => !SESSION || c.sha === state.sha || c.index < currentPr().commits.find((x) => x.sha === state.sha)?.index).map((c) => ({ sha: c.sha, label: `Commit ${c.index}${c.madeUp ? " · made up" : ""}`, message: c.message, short: short(c.sha) }));
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
  // Left rail: one row per PR, like a list of chats.
  $("prList").innerHTML = state.revisions.prs.filter((p) => !SESSION || p.id === state.prId).map((p) => `<button type="button" class="rail-pr ${p.id === state.prId ? "active" : ""}" data-pr="${esc(p.id)}" title="${esc(p.title)}"><span class="rail-num">#${p.number}</span><span class="rail-title">${esc(p.title)}</span></button>`).join("");
  for (const b of $("prList").querySelectorAll("button")) b.onclick = () => {
    const next = state.revisions.prs.find((p) => p.id === b.dataset.pr);
    state.notice = null;
    ui.canvas = null; // a new PR starts as a plain chat
    $("app").classList.remove("rail-open");
    load(next.id, next.commits[0].sha, { keepSelection: false });
  };
  $("chatTitle").innerHTML = `<strong>PR #${currentPr().number}</strong><span>${esc(currentPr().title)}</span>`;
  $("revPills").innerHTML = revList().map((r) => `<button type="button" class="pill ${r.sha === state.sha ? "active" : ""}" data-sha="${r.sha}" title="${esc(r.message)}">${esc(r.label)} <span class="mono">${r.short}</span></button>`).join("");
  for (const b of $("revPills").querySelectorAll("button")) b.onclick = () => load(state.prId, b.dataset.sha);
  $("backLink").href = `${GITHUB_URL}/${currentPr().repo}/pull/${currentPr().number}`;
  const n = $("notice");
  n.hidden = !state.notice;
  n.textContent = state.notice ?? "";
}

// ---------- verdict: one stamp per decision, each says who made it ----------
const SEVERITY_TONE = { High: "bad", Medium: "warn", Low: "info" };
/** `tip` (who decided, and how) shows on hover. `note` is only for what must stay on screen, like "made up". */
const stamp = (label, value, tone, tip, attrs = "", note = "") => `<${attrs ? "button type=\"button\"" : "div"} class="stamp ${tone}" title="${esc(tip)}" ${attrs}><span class="stamp-label">${esc(label)}</span><span class="stamp-value">${esc(value)}</span>${note ? `<span class="stamp-by">${esc(note)}</span>` : ""}</${attrs ? "button" : "div"}>`;
function renderVerdict() {
  const m = state.model, el = $("routeCard"), c1 = m.classifier1, c2 = m.classifier2, r = m.review;
  const signed = m.decisions.signedOff, madeUp = Boolean(m.selected.madeUp);
  const routeTone = c2.route.startsWith("Waiting") ? "warn" : c2.route.startsWith("Auto") ? "ok" : "info";
  const checkTone = (s) => (s === "passed" ? "ok" : s === "failed" ? "bad" : "warn");
  el.innerHTML = `<div class="stamps">
      ${stamp("Severity", c2.severity, SEVERITY_TONE[c2.severity] ?? "plain", `Set by fixed rules (Classifier 1, rule ${c1.rule})`)}
      ${stamp("Route", c2.route, routeTone, `Set by fixed rules after the AI review (Classifier 2, rule ${c2.rule})`)}
      ${m.checks.map((c) => stamp(c.label ?? "Check", c.counts ? `${c.counts.passed} of ${c.counts.total} pass` : c.status, checkTone(c.status), madeUp ? `${c.label ?? "Check"} (${c.name}). ${c.by ?? "Made up for the demo"}.` : `${c.label ?? "Check"} (${c.name}, recorded run, not CI)${m.run ? ". Click for the run." : ""}`, m.run ? 'data-run="1"' : "", madeUp ? "made up" : "")).join("")}
      ${stamp("AI review", !r.available ? "Not available" : r.findings.length ? `${r.findings.length} finding${r.findings.length > 1 ? "s" : ""}` : "No findings", !r.available ? "plain" : r.findings.length ? "warn" : "ok", "Advice only. Click to read it.", 'data-jump="reviewCard"')}
      ${stamp("Sign-off", signed ? m.decisions.signOff.name : "None yet", signed ? "ok" : "plain", "A named person. Counts for this commit only.", 'data-jump="decisionCard"')}
    </div>
    ${c2.blockers.length ? `<ul class="blockers">${c2.blockers.map((b) => `<li>${b.type === "evidence" ? `<button type="button" class="link" data-node="${esc(b.ref)}">${esc(b.text)}</button>` : esc(b.text)}</li>`).join("")}</ul>` : `<div class="verdict-reason">${esc(c2.reason)}</div>`}
    ${c2.notes.map((n) => `<div class="verdict-reason"><strong>${esc(n.text)}</strong></div>`).join("")}
    ${m.since ? `<div class="since"><span class="tag warn">made up</span> <strong>Since commit ${m.since.from}:</strong> ${m.since.items.map(rich).join(" · ")} · <button type="button" class="link" data-since="1">Show the change</button></div>` : ""}`;
  // After a merge: a person can mark this PR as one that broke the system.
  el.insertAdjacentHTML("beforeend", m.evalCase
    ? `<div class="evalcase on"><span class="tag bad">Eval test case</span> <span title="Marked ${esc(m.evalCase.markedAt.slice(0, 16).replace("T", " "))} UTC">Merged, then broke things. Now a test for the AI reviewer.</span> <button type="button" class="link" data-evalcase="off">Remove</button></div>`
    : `<div class="evalcase"><button type="button" class="danger" data-evalcase="on" title="Saves this PR as a test for the AI reviewer: a good reviewer must flag it.">Eval test case</button> <span class="muted">Mark this if the PR broke things after merge.</span></div>`);
  for (const b of el.querySelectorAll("[data-evalcase]")) b.onclick = async () => {
    await api("/api/evalcase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pr: state.prId, on: b.dataset.evalcase === "on" }) });
    await load(state.prId, state.sha);
  };
  for (const b of el.querySelectorAll("[data-since]")) b.onclick = () => select({ type: "since" });
  for (const b of el.querySelectorAll("[data-run]")) b.onclick = () => select({ type: "run" });
  for (const b of el.querySelectorAll("[data-node]")) b.onclick = () => selectNode(b.dataset.node);
  for (const b of el.querySelectorAll("[data-jump]")) b.onclick = () => {
    // The sign-off happens in the chat. The AI review sits below, on the same page.
    if (b.dataset.jump === "decisionCard") return startMerge();
    $(b.dataset.jump).scrollIntoView({ behavior: "smooth", block: "start" });
  };
}

// ---------- PR description: the author's, or the AI-written PR in the team's shape ----------
/** The agent's saved context for this PR. The Q&A agent answers from it. */
const openContext = () => select({ type: "doc", file: `context/${state.prId}.md`, title: "context.md" });
// Only the AI PR is shown. The author's commit message is no longer on screen (user's choice, 2026-11-14).
// A PR with no AI PR saved still falls back to the author's text, so the card is never empty.
/** TL;DR: the whole analysis and its conclusion in 1-2 lines, for people who will not read the rest. */
const tldrBox = (tone, html) => `<div class="tldr ${esc(tone ?? "plain")}"><span class="tldr-tag">TL;DR</span><p>${html}</p></div>`;
function renderDescription() {
  const m = state.model, el = $("intentCard"), d = m.description;
  const body = d.ai
    ? `${d.ai.tldr ? tldrBox(d.ai.tldr.tone, rich(d.ai.tldr.text)) : ""}<div class="tags">${d.ai.tags.map((t) => `<span class="tag ${esc(t.tone)}">${esc(t.label)}</span>`).join("")}</div>
       <p class="lead">${rich(d.ai.summary)}</p>
       <dl class="desc-grid">${d.ai.sections.map((s) => `<dt>${esc(s.title)}</dt><dd>${rich(s.text)}</dd>`).join("")}</dl>
`
    : `${d.author.text.split("\n\n").map((p) => `<p>${rich(p)}</p>`).join("")}`;
  el.innerHTML = `<div class="card-head"><div class="head-left"><h2>${d.ai ? "AI PR" : "Description"}</h2><span class="muted">${esc(m.pr.title)}</span></div>${cardToggle("intentCard")}</div>${body}<div class="byline">${esc(d.ai ? d.ai.generatedBy : d.author.by)}${m.agent ? ` · <button type="button" class="link" data-ctx="1" title="What the coding agent knew and decided (${esc(m.agent.model)}, ${esc(m.agent.snapshot)}, demo data)">context.md</button>` : ""}</div>`;
  for (const b of el.querySelectorAll("[data-ctx]")) b.onclick = openContext;
}

// The big cards (AI PR, Impact map, Review steps) used to have Hide / Show buttons. They now open
// from the chat, in the right panel, so there is nothing to toggle.
const cardToggle = () => "";

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
/** Under the graph: a short colour key. Everything else sits behind "About this map". */
function renderMapFoot(nodes, edges) {
  const m = state.model, el = $("mapFoot"), full = state.mapScope === "full", dots = state.level === "function";
  const g = full ? state.full.graphify : m.graphify;
  const sw = (cls, text) => `<span><i class="sw ${dots ? "dot " : ""}${cls}"></i> ${text}</span>`;
  const ln = (cls, text) => `<span><i class="ln ${cls}"></i> ${text}</span>`;
  // The key only names colours that are on the map right now.
  const key = [
    sw("sw-edited", full ? "edited so far" : "edited"),
    full ? sw("sw-edited sw-now", "edited in this step") : "",
    sw("sw-downstream", "affected, not edited"),
    nodes.some((n) => n.evidence === "contradicted") ? sw("sw-failing", "a unit test fails") : "",
  ].join("");
  const calls = edges.filter((e) => e.kind === "calls");
  const guessed = calls.filter((e) => e.resolution === "inferred").length;
  const li = (x, why) => `<li><code>${esc(x.label)}</code> <span class="mono muted">${esc(x.file.split("/").pop())}:${x.line}</span>${why ? ` · ${esc(why)}` : ""}</li>`;
  const lines = `${ln("ln-solid", "link read from the code")}${ln("ln-dashed", "link guessed from a name")}`;
  const more = dots
    ? `${sw("sw-none", "not changed")}${sw("sw-test", "unit test file")}${full ? "" : `<span><i class="sw sw-pr"></i> the PR and its issue</span>`}${lines}${full ? "" : ln("ln-dotted", "the PR edits this")}`
    : lines;
  const how = dots
    ? "An arrow points from the user to the thing it uses. A bigger dot has more links. Click a dot to see its code. Drag a dot to move it."
    : "An arrow points from the user to the thing it uses. Click a box to see its code. Drag to move the map. Zoom with + and −, or Ctrl and scroll.";
  const source = !g
    ? "No saved Graphify run for this view. The links come from the recorded data."
    : `The links come from ${esc(g.tool)}, a tool that reads code and maps it. It ran earlier on ${full ? "the repo" : `commit <span class="mono">${short(g.revision)}</span>`} and was saved. Not a live run. Here: ${calls.length - guessed} link${calls.length - guessed === 1 ? "" : "s"} read from the code, ${guessed} guessed.${
        full
          ? ` Snapshot of ${esc(state.full.repo)}: ${state.full.totals.files} files, taken ${state.full.takenAt.slice(0, 10)}.${state.level === "concept" ? ` Areas use all ${g.full.calls.toLocaleString("en")} call links in the repo.` : ""}`
          : ` <a href="/api/graphify?pr=${encodeURIComponent(state.prId)}" target="_blank" rel="noopener">Open graph.json</a>`
      }`;
  const gaps = full || !g ? "" : `
      ${g.missed.length ? `<details><summary>${g.missed.length} thing${g.missed.length === 1 ? "" : "s"} Graphify missed</summary><div class="muted">The compiler data (Roslyn, recorded earlier) knows every use of every name. Graphify reads the text of the code, so it can miss some.</div><ul>${g.missed.map((x) => li(x, x.reason)).join("")}</ul></details>` : ""}
      ${g.added.length ? `<details><summary>${g.added.length} caller${g.added.length === 1 ? "" : "s"} only Graphify found</summary><ul>${g.added.map((x) => li(x)).join("")}</ul></details>` : ""}`;
  el.innerHTML = `<details class="map-about" ${state.aboutOpen ? "open" : ""}><summary><span class="legend">${key}</span><span class="about-link">About this map</span></summary>
      <div class="about-body"><div class="legend">${more}</div><p>${how}</p><p>${source}</p>${gaps}</div></details>`;
  el.querySelector(".map-about").ontoggle = (ev) => (state.aboutOpen = ev.target.open);
}
function renderGraph() {
  const m = state.model;
  for (const b of $("levelTabs").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.level === state.level);
    b.setAttribute("aria-pressed", b.dataset.level === state.level);
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
    b.setAttribute("aria-pressed", b.dataset.scope === state.mapScope);
    b.onclick = () => setScope(b.dataset.scope);
  }
  // "Blast radius" and "Monte Carlo swarm" are tabs with their own content. The map and its legends are hidden by CSS.
  const blast = state.mapScope === "blast", swarm = state.mapScope === "swarm";
  $("mapCard").dataset.scope = state.mapScope;
  $("blastView").hidden = !blast;
  $("swarmView").hidden = !swarm;
  if (!swarm) stopSwarm();
  if (!blast) stopBlast();
  $("fullBar").hidden = !full;
  if (blast) return renderBlast();
  if (swarm) {
    // The swarm view draws itself once per PR. After that it keeps its own state (menus, a run in play).
    if (swarmUI.pr !== state.prId) renderSwarm();
    return;
  }
  if (full) return renderFull();
  const edges = m.graph.edges.filter((e) => e.level === state.level), nodes = m.graph.nodes.filter((n) => n.level === state.level);
  drawGraph(nodes, edges, selectNode, (id) => select({ type: "edge", id }));
  renderMapFoot(nodes, edges);
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
    if (play && !matchMedia("(prefers-reduced-motion: reduce)").matches) playFull(0);
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
  concept: "The whole repo, by area.",
  file: "Only the files the 4 demo PRs edit or reach.",
  function: "Only the functions the 4 demo PRs edit or reach.",
};
function renderFull() {
  const f = state.full, level = state.level, last = f.commits.length;
  const step = (state.fullStep = Math.max(0, Math.min(last, state.fullStep)));
  const cur = step ? f.commits[step - 1] : null;
  $("fullHint").textContent = FULL_HINT[level];
  $("fullStep").innerHTML = cur
    ? `<strong>Step ${step} of ${last}</strong> · PR #${cur.prNumber} · commit ${cur.index} <span class="mono">${cur.short}</span>${cur.madeUp ? ` <span class="tag warn">made up</span>` : ""}<div class="muted">${esc(cur.message)}</div>`
    : `<strong>Start</strong> · the repo before any PR<div class="muted">Each step adds one commit.</div>`;
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
  renderMapFoot(nodes, f.levels[level].edges);
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
// The Run button: replays the 3 recorded runs (sped up), then shows the result. Nothing is computed live.
const blastRun = { pr: null, phase: "idle", timers: [], reveal: false };
const BLAST_TOLD = { minimal: "told: touch as little as you can", normal: "told: solve it the way you normally would", wide: "told: refactor and tidy freely" };
function stopBlast() {
  for (const t of blastRun.timers) clearTimeout(t);
  blastRun.timers = [];
  if (blastRun.phase === "running") blastRun.phase = "idle";
}
function playBlast() {
  for (const t of blastRun.timers) clearTimeout(t);
  blastRun.timers = [];
  const b = state.blast[state.prId], el = $("blastView");
  blastRun.pr = state.prId;
  blastRun.phase = "running";
  el.dataset.stage = "running";
  const agents = b.runs.filter((r) => r.id !== "real");
  const fast = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const later = (ms, fn) => blastRun.timers.push(setTimeout(fn, fast ? 0 : ms));
  el.innerHTML = `<p class="blast-what">We give the same task to 3 agents: one careful, one normal, one that changes too much. What they touch is the "blast radius" of the task. Then we lay the real change over it.</p>
    <div class="swarm-stage">
      <div class="swarm-flow">
        <div class="swarm-req" id="blastReq"><b>Requirements</b><span>Same text for every agent</span></div>
        <div class="swarm-agents">${agents.map((r) => `<div class="swarm-agent"><span class="swarm-name">${esc(BLAST_SHORT[r.id])}<span class="swarm-model">${esc(BLAST_TOLD[r.id])}</span></span><span class="swarm-bar"><i></i></span><span class="swarm-status">waiting</span></div>`).join("")}</div>
      </div>
      <div class="blast-step muted" id="blastStep">Sending the task to 3 agents…</div>
    </div>`;
  const rows = [...el.querySelectorAll(".swarm-agent")];
  later(100, () => $("blastReq")?.classList.add("sending"));
  let end = 0;
  agents.forEach((r, i) => {
    const start = 400 + i * 250;
    const secs = r.startedAt && r.endedAt ? (new Date(r.endedAt) - new Date(r.startedAt)) / 1000 : 60;
    // 1 second of the real run = 20 ms here, kept between 1.2 and 4 s.
    const work = Math.min(4000, Math.max(1200, secs * 20));
    later(start, () => {
      rows[i].classList.add("working");
      rows[i].style.setProperty("--work", `${work}ms`);
      rows[i].querySelector(".swarm-status").textContent = "reading the task, then writing a fix…";
      $("blastStep").textContent = "The agents are working…";
    });
    later(start + work, () => {
      const c = b.columns.find((x) => x.id === r.id);
      rows[i].classList.remove("working");
      rows[i].classList.add("done", "near");
      rows[i].querySelector(".swarm-status").innerHTML = c.noChange ? "made no change" : `${c.files} file${c.files === 1 ? "" : "s"} · <span class="plus">+${c.added}</span> <span class="minus">−${c.removed}</span> · took ${Math.round(secs)} s`;
    });
    end = Math.max(end, start + work);
  });
  later(end + 300, () => ($("blastStep").textContent = "Laying the real change over what they touched…"));
  later(end + 1300, () => {
    blastRun.phase = "done";
    blastRun.reveal = true;
    renderBlast();
  });
}
/** Blast radius, second half: the agents' unit tests and the real change's unit tests, run on each other's code. */
function blastTestsHtml(b) {
  const t = b.tests;
  if (!t) return "";
  const who = (id) => (b.columns.find((c) => c.id === id)?.label ?? id).toLowerCase();
  const score = (r) => (r.ran ? `${r.passed} of ${r.total} pass` : `not run: ${esc(r.why)}`);
  const agentTests = t.runs.filter((r) => r.tests === "agent");
  const blind = [...new Set(agentTests.map((r) => r.by))].map((by) => {
    const on = (where) => agentTests.find((r) => r.by === by && r.on === where);
    return `<li>The ${esc(who(by))} wrote unit tests without seeing the real change. On the old code: <strong>${score(on("base"))}</strong>. On the real change: <strong>${score(on("real"))}</strong>.</li>`;
  });
  const real = t.runs.filter((r) => r.tests === "real");
  const fixes = real.map((r) => `${r.on === "base" ? "the old code" : `the ${esc(who(r.on))}'s fix`}: <strong>${score(r)}</strong>`).join("; ");
  const only = t.onlyReal.map((f) => `<li class="only-real"><strong>${esc(f.name.split(".").pop())}</strong> fails on every agent's fix (${esc(f.message)}). It checks something only the real change does. A named person decides whether that was asked for.</li>`);
  return `<div class="blast-tests ${t.onlyReal.length ? "warn" : "ok"}"><span class="stamp-label">Unit tests, run both ways</span>
    <ul>${blind.join("")}<li>The real change's own unit tests, on ${fixes}.</li>${only.join("")}</ul>
    <span class="muted">Recorded ${esc(t.recordedAt.slice(0, 10))} with .NET SDK ${esc(t.sdk)}, by <code>scripts/blast-tests.mjs</code>. No model was called.</span></div>`;
}

// ---------- trust scores: each trust skill (Blast radius, Monte Carlo swarm) ends in one number out of 100 ----------
// A fixed rule works each one out. No AI. 75 or more is green, 45 to 74 amber, under 45 red.
const trustTone = (score) => (score >= 75 ? "ok" : score >= 45 ? "warn" : "bad");
/** The top of a skill's result: the score, a few words for it, and one line on what the skill does. */
const trustHtml = (t, what) => `<div class="trust ${t.tone}"><div class="trust-num"><b>${t.score}</b><small>/ 100</small><span>Trust score</span></div>
  <div class="trust-text"><strong>${esc(t.verdict)}</strong><p>${what}</p></div></div>`;
/** Why the score is what it is: one short line per reason. */
const whyHtml = (t) => `<ul class="why">${t.why.map((w) => `<li class="${w.tone}"><i aria-hidden="true">${w.tone === "ok" ? "✓" : "!"}</i><span>${rich(w.text)}</span></li>`).join("")}</ul>`;
const BLAST_WHAT = "3 agents did the same task. We check that the real change stays where they worked.";
const SWARM_WHAT = "Many agents did the same task. If most make the same change, the real change is likely right.";
/**
 * Blast radius trust score. Each code file the real change edits (not docs, not unit tests) gets points
 * for where it sits: 100 if the careful agent edited it too, 85 the normal agent, 60 only the agent that
 * changes too much, 20 no agent. The score is the average, minus 20 for each of the real change's
 * unit tests that fails on every agent's fix.
 */
function blastScore(b) {
  const POINTS = { tight: 100, normal: 85, wide: 60, outside: 20 };
  const files = b.items.filter((x) => x.level === "file" && x.by.real && x.kind !== "test" && x.kind !== "doc");
  const base = files.length ? Math.round(files.reduce((a, x) => a + POINTS[x.zone], 0) / files.length) : 100;
  const extra = b.tests?.onlyReal?.length ?? 0, n = files.length;
  const score = Math.max(0, base - 20 * extra);
  const outside = files.filter((x) => x.zone === "outside").length, wide = files.filter((x) => x.zone === "wide").length;
  const where = outside ? { tone: "bad", text: `The real change edits ${things(outside, "code file", "code files")} that no agent touched.` }
    : wide ? { tone: "warn", text: `The real change edits ${things(wide, "code file", "code files")} that only the agent that changes too much touched.` }
    : { tone: "ok", text: `The real change edits ${things(n, "code file", "code files")}. The agents edited ${n === 1 ? "it" : "them"} too.` };
  const tests = extra ? { tone: "warn", text: `${things(extra, "of its unit tests fails", "of its unit tests fail")} on every agent's fix. So it does something no agent thought was needed.` }
    : b.tests ? { tone: "ok", text: "Its unit tests also pass on the agents' fixes." } : null;
  return { score, tone: trustTone(score), verdict: b.label.text, why: [where, tests].filter(Boolean) };
}
/** Monte Carlo swarm trust score: the share of agents whose change is like the real one, as a number out of 100. */
function swarmScore(runs) {
  const v = swarmVerdict(runs), n = runs.length;
  const score = Math.round((100 * v.near) / n);
  const why = [];
  if (v.near) why.push({ tone: "ok", text: `${things(v.near, "agent", "agents")} made a change like the real one.` });
  if (v.near < n) why.push({ tone: "warn", text: `${things(n - v.near, "agent", "agents")} did it differently.${v.topMiss ? ` Most skipped \`${v.topMiss[0]}\`. Check the real change needs it.` : ""}` });
  return { score, tone: trustTone(score), verdict: `${v.near} of ${n} agents agree`, why };
}
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
  // First a button. Pressing it replays the 3 recorded runs, then shows the result.
  const run = blastRun.pr === state.prId ? blastRun.phase : "idle";
  if (run === "idle") {
    el.dataset.stage = "idle";
    el.innerHTML = `<p class="blast-what">We give the same task to 3 agents: one careful, one normal, one that changes too much. What they touch is the "blast radius" of the task. Then we lay the real change over it.</p>
      <div class="swarm-controls"><button type="button" class="primary" id="blastGo">▶ Run blast radius</button>
      <span class="muted swarm-rec">Replays 3 real runs of <code>${esc(b.model)}</code>, recorded ${esc(b.recordedAt.slice(0, 10))}. No agent runs now.</span></div>`;
    $("blastGo").onclick = () => playBlast();
    return;
  }
  if (run === "running") {
    // The animation owns the box while it runs. A redraw of the page must not restart it.
    if (el.dataset.stage !== "running") playBlast();
    return;
  }
  el.dataset.stage = "done";
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
  // The simple view: the trust score, why, and how many files each one changed. The rest sits in one fold.
  const trust = blastScore(b), most = Math.max(1, ...cols.map((c) => c.files));
  if (state.sel?.type === "blast") blastRun.details = true; // a picked file lives in the fold: keep it open
  el.innerHTML = `<div class="blast-top">${trustHtml(trust, BLAST_WHAT)}<button type="button" id="blastAgain">↻ Run again</button></div>
    ${whyHtml(trust)}
    <div class="bars"><div class="bars-title">Files each one changed</div>${cols.map((c) => `<div class="bar-row${c.id === "real" ? " real" : ""}"><span>${esc(BLAST_SHORT[c.id] ?? c.label)}${c.id === "real" ? "" : " agent"}</span><span class="bar"><i style="width:${Math.round((100 * c.files) / most)}%"></i></span><b>${c.files} file${c.files === 1 ? "" : "s"}</b></div>`).join("")}</div>
    <details class="tool-details" id="blastDetails" ${blastRun.details ? "open" : ""}><summary>Show the details</summary>
    <p class="blast-what">The coloured zones show the files the 3 agents touched. The thick outline is the real change.</p>
    <div class="blast-label ${esc(b.label.tone)}"><span class="stamp-label">Trust label</span><strong>${esc(b.label.text)}</strong><span>${esc(b.label.how)}</span></div>
    ${blastTestsHtml(b)}
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
    <div class="blast-key muted"><span class="plus">+</span> lines added, <span class="minus">−</span> lines removed, · not touched. The real change is Tieto's AI-written branch, shown as a PR. ${esc(b.tests ? "The agents could not build the code; the unit tests were run afterwards on another machine (see above)." : b.notBuilt)}</div>`)}
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
      <p class="muted">${esc(b.how.functions)} Callers come from ${esc(b.graphTool ?? "the recorded data")} (a saved run) and the recorded compiler data for this PR.</p>
      <p class="muted">Trust score: each code file the real change edits gets 100 if the careful agent edited it too, 85 for the normal agent, 60 for only the agent that changes too much, 20 for no agent. We take the average, then 20 off for each of its unit tests that fails on every agent's fix. A fixed rule, no AI.</p>`)}
    </details>`;
  $("blastDetails").ontoggle = (ev) => (blastRun.details = ev.target.open);
  for (const btn of el.querySelectorAll("[data-blast]")) btn.onclick = () => selectBlast(btn.dataset.blast);
  $("blastAgain").onclick = () => playBlast();
  // Just after a run: the result fades in, part by part.
  el.classList.toggle("reveal", blastRun.reveal);
  if (blastRun.reveal) {
    blastRun.reveal = false;
    setTimeout(() => el.classList.remove("reveal"), 2500);
  }
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
    // One load per PR. A second call while it loads waits for the same load.
    stopSwarm();
    swarmUI.pr = state.prId;
    swarmUI.data = null;
    swarmUI.note = null;
    el.innerHTML = `<div class="muted">Loading…</div>`;
    const pr = state.prId;
    swarmUI.loading = api("/api/swarm?pr=" + encodeURIComponent(pr)).then((data) => {
      if (swarmUI.pr !== pr) return;
      swarmUI.data = data;
      if (data.recorded) swarmDefault();
    });
  }
  await swarmUI.loading;
  if (swarmUI.pr !== state.prId) return;
  const s = swarmUI.data;
  // The panel's title already names the tool, and the trust score says what it does.
  const wrap = (body) => `<div class="swarm">${body}</div>`;
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
    <div class="swarm-result" id="swarmResult" hidden></div>
    <details class="tool-details" id="swarmDetails" hidden><summary>Show the details</summary>
    <div class="swarm-scale">
      <div class="swarm-scale-label muted">How similar each agent's change is to the real change</div>
      <div class="swarm-track">
        <div class="swarm-near" style="left:${s.similarAt}%"><span>similar</span></div>
        <div class="swarm-real" style="left:100%" title="The real change"><span>Real change</span></div>
        ${runs.map((r, i) => `<button type="button" class="swarm-dot" data-run="${esc(r.key)}" style="left:${r.score}%;bottom:${8 + stack[i] * 16}px" title="Agent ${i + 1} (${esc(r.modelLabel)}): ${r.score}% similar"></button>`).join("")}
      </div>
      <div class="swarm-axis"><span style="left:0">0%</span><span style="left:50%">50%</span><span style="left:100%">100%</span></div>
    </div>
    <div id="swarmMore"></div>
    </details>`;
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
        : `<b>${r.similar ? "✓ Same as the real change" : "✕ Different"}</b> · ${r.score}% alike`;
      dots[i].classList.add("in", r.similar ? "near" : "far");
    });
    end = Math.max(end, start + work);
  });
  // 4. The answer.
  later(end + 500, () => {
    const { near, pairs, sum, topMiss, topExtra, avg, tone, byModel } = swarmVerdict(runs);
    // The simple view: the trust score and why. The scale, the numbers and the matrix sit in the fold.
    const trust = swarmScore(runs), res = $("swarmResult");
    res.hidden = false;
    res.innerHTML = `${trustHtml(trust, SWARM_WHAT)}${whyHtml(trust)}<p class="muted">Click an agent above to see its change.</p>`;
    $("swarmDetails").hidden = false;
    $("swarmMore").innerHTML = `<div class="blast-label ${tone}"><span class="stamp-label">Swarm result${runs.some((r) => r.madeUp) ? " · made up for the demo" : ""}</span>
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
        <p>Trust score = the share of agents whose change is similar to the real one, out of 100. A fixed rule, no AI.</p>
        <details><summary>The prompt every agent got, word for word</summary><pre class="raw doc">${esc(s.prompt.text)}</pre></details>
      </details>`;
    renderSwarmMatrix(runs);
  });
}
/** The swarm's answer for a set of runs: the counts, and the TL;DR box. Used by the tab and by the chat. */
function swarmVerdict(runs) {
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
  const share = near / runs.length;
  const tone = share >= 0.7 ? "ok" : share >= 0.4 ? "warn" : "bad";
  const byModel = [...new Set(runs.map((r) => r.modelLabel))].map((l) => {
    const mine = runs.filter((r) => r.modelLabel === l);
    return `${l}: ${mine.filter((r) => r.similar).length} of ${mine.length}`;
  });
  return { near, pairs, sum, topMiss, topExtra, avg, tone, byModel };
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
  const cite = (c) => (c.valid ? `<button type="button" class="link mono" data-src="${esc(c.file)}" data-line="${c.line}" title="${esc(c.file)}">${esc(c.file.split("/").pop())}:${c.line}</button>` : `<span class="mono bad-text" title="${esc(c.problem)}">${esc(c.file)}:${esc(c.line)} (invalid)</span>`);
  const c1 = m.classifier1, c2 = m.classifier2;
  const sev = (s) => `<span class="tag ${SEVERITY_TONE[s] ?? ""}">${esc(s)}</span>`;
  el.innerHTML = `<div class="card-head"><div class="head-left"><h2>Review steps</h2><span class="muted">Rules: <button type="button" class="link" data-doc="REVIEW.md">REVIEW.md</button> · <button type="button" class="link" data-doc="review-policy.yml">review-policy.yml</button></span></div>${cardToggle("reviewCard")}</div>
    <div class="step"><div class="step-head"><span class="step-n">1</span><strong>Classifier 1</strong> ${sev(c1.severity)} <span class="muted">fixed rules · ${esc(c1.rule)}</span></div>
      <div>${esc(c1.reason)}</div></div>
    <div class="step"><div class="step-head"><span class="step-n">2</span><strong>AI review</strong> <span class="tag ${r.findings.length ? "warn" : "ok"}">${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}</span> <span class="muted">advice only</span></div>
    <div>${esc(r.summary)}</div>
    ${r.findings.map((f) => `<details class="finding ${f.category === "Minor" ? "plain" : "warn"}">
        <summary><span class="tag ${f.category === "Minor" ? "" : "warn"}">${esc(f.category)}</span> <strong>${esc(f.title)}</strong></summary>
        <div>${esc(f.detail)}</div>
        ${f.suggestedCheck ? `<div><strong>Check to add:</strong> ${esc(f.suggestedCheck)}</div>` : ""}
        ${f.citations.length ? `<div class="muted">Code: ${f.citations.map(cite).join(", ")}</div>` : ""}</details>`).join("")}
    ${r.couldNotDecide.length ? `<details class="finding plain"><summary><strong>${r.couldNotDecide.length} question${r.couldNotDecide.length === 1 ? "" : "s"} the AI could not answer</strong></summary>${r.couldNotDecide.map((q) => `<div>${esc(q.question)}<div class="muted">Would help: ${esc(q.checkThatWouldHelp)}</div></div>`).join("")}</details>` : ""}
    <div class="byline">${esc(r.modeLabel)}</div></div>
    <div class="step"><div class="step-head"><span class="step-n">3</span><strong>Classifier 2</strong> ${sev(c2.severity)} <span class="tag">${esc(c2.route)}</span> <span class="muted">fixed rules · ${esc(c2.rule)}</span></div>
      ${c2.blockers.length ? `<div>${esc(c2.reason)}</div>` : ""}</div>`;
  for (const b of el.querySelectorAll("[data-doc]")) b.onclick = () => select({ type: "doc", file: b.dataset.doc });
  for (const b of el.querySelectorAll("[data-src]")) b.onclick = () => select({ type: "source", file: b.dataset.src, line: Number(b.dataset.line) });
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
    const note = sel.file.startsWith("context/") ? "Made up for the demo. The coding agent saves this file with the PR. The chat answers from it." : "Demo version. In a real repo, the copy on the base branch is the one that counts.";
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
  el.hidden = !state.sel;
  applyCanvas();
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
  if (ui.canvas === "map") renderGraph();
  renderReview();
  renderSide();
  applyCanvas();
  // One chat per (PR, commit). A new one starts with the summary. The same one only refreshes its issue list.
  if (ui.key !== reviewKey()) {
    ui.key = reviewKey();
    startThread();
  } else refreshIssues();
}

// ---------- right panel: opens only when a tool, a page or a file is asked for ----------
// `canvas` is what the panel shows: null (closed), "pr" (full AI PR), "review" (stamps + review steps) or "map"
// (Impact map card: This PR / Full map / Blast radius / Monte Carlo swarm). A picked file, doc or run
// (`state.sel`) slides over it. With no page behind it, the panel shows only that.
const ui = { canvas: null, key: null, threads: {}, queue: Promise.resolve(), first: {}, scores: {}, openMore: new Set() };
const CANVAS_TITLE = { pr: "The full PR description", review: "Review steps", detail: "" };
const SCOPE_TITLE = { pr: "Impact Map", full: "Impact Map · the whole repo", blast: "Blast radius", swarm: "Monte Carlo swarm" };
function applyCanvas() {
  const open = Boolean(ui.canvas || state.sel);
  $("app").classList.toggle("canvas-open", open);
  $("canvas").hidden = !open;
  $("canvas").dataset.kind = ui.canvas ?? "detail";
  $("canvasTitle").textContent = ui.canvas === "map" ? SCOPE_TITLE[state.mapScope] : CANVAS_TITLE[ui.canvas ?? "detail"];
  $("pagePr").hidden = ui.canvas !== "pr";
  $("pageReview").hidden = ui.canvas !== "review";
  $("mapCard").hidden = ui.canvas !== "map";
}
async function openCanvas(kind, scope) {
  ui.canvas = kind;
  state.sel = null;
  applyCanvas();
  // The map is drawn to fit its box, so it is drawn after the panel is on screen.
  if (kind === "map") await setScope(scope ?? state.mapScope);
  else render();
}
function closeCanvas() {
  ui.canvas = null;
  state.sel = null;
  stopFull();
  stopSwarm();
  stopBlast();
  writeHash();
  render();
}

// ---------- chat: the main screen ----------
// The chat says the PR and the review in one or two lines each, lists the issues, and asks what to do.
// Every issue must be acknowledged (or fixed by a later commit) before the PR can merge.
const reviewKey = () => `${state.prId}:${state.sha}`;
const things = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calm = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

// What the person acknowledged, per (PR, commit). Kept in this browser. An acknowledgement, like a
// sign-off, counts for one commit only.
const ACKS_KEY = "impact-map-acks";
let acks = {};
try { if (!SESSION) acks = JSON.parse(localStorage.getItem(ACKS_KEY)) ?? {}; } catch {} // a session starts clean for every person
const saveAcks = () => { try { localStorage.setItem(ACKS_KEY, JSON.stringify(acks)); } catch {} };
const acked = (id) => Boolean(acks[reviewKey()]?.[id]);
function setAck(ids, on) {
  const mine = (acks[reviewKey()] ??= {});
  for (const id of ids) {
    if (on) mine[id] = true;
    else delete mine[id];
  }
  saveAcks();
  refreshIssues();
}

/**
 * The issues of one commit, each as one line of problem and one line of fix.
 * - "block": proof is missing. The rules refuse a sign-off, so it cannot be acknowledged.
 * - "major": the rule that raised the risk, and the AI review's important findings.
 * - "minor": the AI review's small findings. Shown folded.
 */
function issueList(m) {
  const c2 = m.classifier2, out = [];
  c2.blockers.forEach((b, i) => out.push({ id: `proof-${i}`, level: "block", title: b.text, fix: "Ask the author for a unit test that proves it." }));
  if (!c2.blockers.length && c2.rule === "T-contradicted") {
    out.push({ id: "rule", level: "major", title: c2.reason.split(". ")[0].replace(/\.$/, ""), fix: "Accept the change on purpose, or ask for a smaller fix.", detail: [c2.reason, ...c2.notes.map((n) => n.text)].join(" "), run: Boolean(m.run) });
  }
  for (const f of m.review.findings) out.push({ id: f.id, level: f.category === "Minor" ? "minor" : "major", title: f.title, fix: f.fix ?? f.suggestedCheck, detail: f.detail, citations: f.citations });
  return out;
}
/** Issues of the PR's first commit that are gone at the selected commit. */
function fixedList() {
  const m = state.model, first = ui.first[state.prId];
  if (m.selected.index < 2 || !first) return [];
  const now = new Set(issueList(m).map((x) => x.id));
  return issueList(first).filter((x) => !now.has(x.id));
}
const openIssues = () => issueList(state.model).filter((x) => !acked(x.id));

function issueHtml(x) {
  const done = acked(x.id), merged = state.model.decisions.signedOff;
  const cites = (x.citations ?? []).filter((c) => c.valid).slice(0, 3).map((c) => `<button type="button" class="link mono" data-act="src" data-src="${esc(c.file)}" data-line="${c.line}" title="${esc(c.file)}">${esc(c.file.split("/").pop())}:${c.line}</button>`).join(", ");
  const btn = x.level === "block" ? `<span class="tag bad">Must be fixed</span>`
    : merged ? ""
    : done ? `<button type="button" data-act="unack" data-id="${esc(x.id)}">Undo</button>`
    : `<button type="button" class="primary" data-act="ack" data-id="${esc(x.id)}">Acknowledge</button>`;
  const more = x.detail || cites || x.run
    ? `<details class="issue-more" data-more="${esc(x.id)}" ${ui.openMore.has(x.id) ? "open" : ""}><summary>More</summary>${x.detail ? `<p>${esc(x.detail)}</p>` : ""}${cites ? `<p class="muted">Code: ${cites}</p>` : ""}${x.run ? `<p><button type="button" class="link" data-act="run">Open the unit test run</button></p>` : ""}</details>`
    : "";
  return `<div class="issue ${x.level}${done ? " done" : ""}">
    <div class="issue-main"><span class="issue-mark" aria-hidden="true">${done ? "✓" : x.level === "block" ? "✕" : "!"}</span>
      <div class="issue-text"><strong>${esc(x.title)}</strong>${x.fix ? `<div class="issue-fix"><b>Fix:</b> ${rich(x.fix)}</div>` : ""}${done ? `<div class="issue-state">Acknowledged</div>` : ""}</div>
      <div class="issue-btn">${btn}</div></div>${more}</div>`;
}
function issuesHtml() {
  const m = state.model, all = issueList(m), fixed = fixedList(), open = all.filter((x) => !acked(x.id));
  const merged = m.decisions.signedOff;
  if (!all.length && !fixed.length) return `<p><b>Nothing needs your OK.</b> The review found no issues on this commit.</p>`;
  const main = all.filter((x) => x.level !== "minor"), minor = all.filter((x) => x.level === "minor"), minorOpen = minor.filter((x) => !acked(x.id));
  const head = !all.length ? `<p><b>Nothing is left open.</b></p>`
    : open.length ? `<p><b>${things(all.length, "thing needs", "things need")} your OK before this can merge.</b></p>`
    : `<p><b>All ${things(all.length, "issue is", "issues are")} acknowledged.</b> Nothing is left open.</p>`;
  const meter = all.length ? `<div class="meter" title="${all.length - open.length} of ${all.length} done"><i style="width:${Math.round((100 * (all.length - open.length)) / all.length)}%"></i><span>${all.length - open.length} of ${all.length} done</span></div>` : "";
  const minorHtml = minor.length
    ? `<details class="minor" data-more="minor" ${ui.openMore.has("minor") ? "open" : ""}><summary><span>${things(minor.length, "smaller point", "smaller points")}${minorOpen.length ? "" : " · all acknowledged"}</span>${minorOpen.length && !merged ? `<button type="button" data-act="ackminor">Acknowledge all ${minorOpen.length}</button>` : ""}</summary>${minor.map(issueHtml).join("")}</details>`
    : "";
  const fixedHtml = fixed.map((x) => `<div class="issue fixed"><div class="issue-main"><span class="issue-mark" aria-hidden="true">✓</span>
      <div class="issue-text"><strong>${esc(x.title)}</strong><div class="issue-state">Fixed in commit ${m.selected.index}${m.selected.madeUp ? ` <span class="tag warn">made up</span>` : ""}</div></div></div></div>`).join("");
  const foot = merged ? `<div class="okbox"><b>Merged.</b> ${esc(m.decisions.signOff.name)} signed off ${esc(stepText(m))}.</div>`
    : !open.length ? `<div class="issue-foot"><button type="button" class="primary" data-act="merge">Merge this PR</button></div>` : "";
  return `${head}${meter}${main.map(issueHtml).join("")}${minorHtml}${fixedHtml}${foot}`;
}
/**
 * The short form, for the first screen: a count, and one line per important issue. No fixes, no buttons.
 * The full list (fix, "More", Acknowledge) only comes when the person asks for it.
 */
function briefHtml() {
  const m = state.model, all = issueList(m), fixed = fixedList(), open = all.filter((x) => !acked(x.id));
  if (!all.length) return `<p><b>Nothing needs your OK.</b> ${fixed.length ? `${things(fixed.length, "issue was", "issues were")} fixed since commit 1.` : "The review found no issues on this commit."}</p>`;
  const main = all.filter((x) => x.level !== "minor"), minor = all.length - main.length, done = all.length - open.length;
  const head = open.length ? `${things(all.length, "thing needs", "things need")} your OK before this can merge.` : `All ${things(all.length, "issue is", "issues are")} acknowledged.`;
  const foot = m.decisions.signedOff ? `<div class="okbox"><b>Merged.</b> ${esc(m.decisions.signOff.name)} signed off ${esc(stepText(m))}.</div>`
    : open.length ? `<div class="choices"><button type="button" class="choice" data-act="issues"><b>Go through them</b><span>One line each, with the fix.</span></button></div>`
    : `<div class="choices"><button type="button" class="choice main" data-act="merge"><b>Merge this PR</b><span>Sign off with your name.</span></button></div>`;
  return `<p><b>${head}</b>${done ? ` <span class="muted">${done} of ${all.length} done.</span>` : ""}</p>
    <ul class="brief">${main.map((x) => `<li class="${x.level}${acked(x.id) ? " done" : ""}">${esc(x.title)}</li>`).join("")}${minor ? `<li class="minor">${main.length ? "and " : ""}${things(minor, "smaller point", "smaller points")}</li>` : ""}</ul>
    ${fixed.length ? `<p class="muted">${things(fixed.length, "issue was", "issues were")} fixed since commit 1${m.selected.madeUp ? " (made up)" : ""}.</p>` : ""}${foot}`;
}
/** Every issue list in the chat shows the same live state. */
function refreshIssues() {
  for (const el of $("thread").querySelectorAll(".advice-live")) el.innerHTML = adviceHtml();
  for (const el of $("thread").querySelectorAll(".scores-live")) el.innerHTML = scoresHtml();
  for (const el of $("thread").querySelectorAll(".issues-brief")) el.innerHTML = briefHtml();
  for (const el of $("thread").querySelectorAll(".issues-live")) el.innerHTML = issuesHtml();
}

// ----- the first message: the PR in short, the review in short -----
function introHtml() {
  const m = state.model, d = m.description, c2 = m.classifier2, r = m.review;
  // Two chips only: how risky, and who decides. Unit test counts and the AI review sit behind "See the review steps".
  const need = c2.route.startsWith("Waiting") ? ["Waiting for proof", "bad"] : c2.route.startsWith("Auto") ? ["Could merge by itself", "ok"] : ["A person must sign off", "info"];
  const chips = [
    `<span class="tag ${SEVERITY_TONE[c2.severity] ?? ""}" title="Set by fixed rules (rule ${esc(c2.rule)})">Risk: ${esc(c2.severity)}</span>`,
    `<span class="tag ${need[1]}" title="Set by fixed rules after the AI review">${need[0]}</span>`,
  ].join("");
  const prShort = d.ai?.tldr?.text ?? d.ai?.summary ?? d.author.text;
  return `<h1 class="pr-title">${esc(m.pr.title)}</h1>
    <div class="pr-sub muted">PR #${m.pr.number} · ${SESSION ? "AI-written change, shown as a PR" : "Tieto's AI-written branch, shown as a PR"} · ${esc(stepText(m))}${m.selected.madeUp ? ` <span class="tag warn">made up</span>` : ""}</div>
    <div class="advice-live"></div>
    <div class="short ${esc(d.ai?.tldr?.tone ?? "plain")}"><span class="short-label">The PR in short</span><p>${rich(prShort)}</p>
      <button type="button" class="link" data-act="page" data-page="pr">Read the full PR description</button></div>
    <div class="short ${SEVERITY_TONE[c2.severity] ?? "plain"}"><span class="short-label">The review in short</span><p>${esc(r.summary)}</p>
      <div class="tags">${chips}</div>
      ${m.since ? `<details class="since-line"><summary><span class="tag warn">made up</span> What changed since commit ${m.since.from}</summary><p>${m.since.items.map(rich).join(" · ")} · <button type="button" class="link" data-act="since">Show the code change</button></p></details>` : ""}
      <button type="button" class="link" data-act="page" data-page="review">See the review steps</button></div>`;
}
// ----- tool scores: worked out up front, so the person can merge straight away or drill down -----
// One row per tool: its name, its score, one line of why. A click opens the tool in the right panel.
// The Blast radius and swarm numbers are per PR (recorded runs against the PR's first commit).
function loadScores() {
  const id = state.prId;
  if (ui.scores[id]) return;
  ui.scores[id] = {};
  loadBlast().then((b) => {
    ui.scores[id].blast = b;
    if (state.prId === id) refreshIssues();
  });
  api("/api/swarm?pr=" + encodeURIComponent(id)).then((s) => {
    ui.scores[id].swarm = s;
    if (state.prId === id) refreshIssues();
  });
}
function scoreRows() {
  const m = state.model, sc = ui.scores[state.prId] ?? {}, rows = [];
  const files = m.diff.files.length, red = m.graph.nodes.some((x) => x.evidence === "contradicted");
  rows.push({ scope: "pr", name: "Impact Map", tone: red ? "bad" : "info", score: `${things(files, "file", "files")} edited`, why: red ? "A unit test fails in code this PR edits." : m.classifier1.reason });
  const b = sc.blast;
  if (!b) rows.push({ scope: "blast", name: "Blast radius", wait: true });
  else if (!b.recorded) rows.push({ scope: "blast", name: "Blast radius", tone: "plain", score: "No runs yet", why: "No agent runs are saved for this PR." });
  else {
    const t = blastScore(b), extra = b.tests?.onlyReal?.length;
    rows.push({ scope: "blast", name: "Blast radius", tone: t.tone, score: `Trust ${t.score} / 100`, why: `${b.label.text}.${extra ? ` But ${things(extra, "unit test fails", "unit tests fail")} on every other agent's fix.` : ""}` });
  }
  const s = sc.swarm;
  if (!s) rows.push({ scope: "swarm", name: "Monte Carlo swarm", wait: true });
  else if (!s.recorded) rows.push({ scope: "swarm", name: "Monte Carlo swarm", tone: "plain", score: "No runs yet", why: "No agent runs are saved for this PR." });
  else {
    const set = s.sets.find((x) => x.id === s.defaultSet), runs = set.runs.map((k) => s.runs.find((r) => r.key === k));
    const t = swarmScore(runs);
    rows.push({ scope: "swarm", name: "Monte Carlo swarm", tone: t.tone, score: `Trust ${t.score} / 100`, why: `${t.verdict}: they made a change like the real one.`, madeUp: set.madeUp });
  }
  return rows;
}
/**
 * The advice on the first screen: a merge score out of 100, what to do, and what to look at first.
 * A fixed rule, no AI: start at 100 and take points off for what the review and the tools found.
 * Missing proof means 0: the rules refuse a sign-off there.
 */
function advice() {
  const m = state.model, c2 = m.classifier2, sc = ui.scores[state.prId] ?? {}, parts = [];
  const take = (n, why) => parts.push([n, why]);
  const important = m.review.findings.filter((f) => f.category !== "Minor").length, minor = m.review.findings.length - important;
  const blocked = c2.blockers.length > 0, red = c2.rule === "T-contradicted";
  if (red) take(25, "A unit test passes on the old code and fails on the new code.");
  if (important) take(10 * important, `${things(important, "important finding", "important findings")} in the AI review.`);
  if (minor) take(3 * minor, `${things(minor, "smaller point", "smaller points")} in the AI review.`);
  if (c2.severity === "High") take(10, "The rules set the risk to High.");
  else if (c2.severity === "Medium") take(5, "The rules set the risk to Medium.");
  // The two trust skills: 5 off for every 10 points a trust score is under 100, at most 20 each.
  const off = (score) => Math.min(20, Math.round((100 - score) / 10) * 5);
  const b = sc.blast?.recorded ? blastScore(sc.blast) : null;
  const blastFlag = Boolean(b && b.score < 100);
  if (blastFlag && off(b.score)) take(off(b.score), `Blast radius trust score is ${b.score} of 100.`);
  const s = sc.swarm?.recorded ? sc.swarm : null;
  let swarmLow = false;
  if (s) {
    const t = swarmScore(s.sets.find((x) => x.id === s.defaultSet).runs.map((k) => s.runs.find((r) => r.key === k)));
    swarmLow = t.score < 70;
    if (off(t.score)) take(off(t.score), `Monte Carlo swarm trust score is ${t.score} of 100.`);
  }
  const score = blocked ? 0 : Math.max(0, 100 - parts.reduce((a, p) => a + p[0], 0));
  const verdict = blocked ? ["Cannot merge yet", "bad"] : score >= 75 ? ["Fine to merge", "ok"] : score >= 45 ? ["Look closer first", "warn"] : ["Do not merge yet", "bad"];
  const next = SESSION ? null : currentPr().commits.find((c) => c.index > m.selected.index); // a session shows one commit only
  const look = blocked ? (next ? { act: "commit", sha: next.sha, name: `Commit ${next.index}${next.madeUp ? " (made up)" : ""}`, why: "It adds the missing proof." } : { act: "issues", name: "The open issues", why: "Proof is missing. The author must add it." })
    : red ? { act: "tool", scope: "pr", name: "Impact Map", why: "It shows where the unit test fails, and what else uses that code." }
    : blastFlag ? { act: "tool", scope: "blast", name: "Blast radius", why: "It shows what only this change does." }
    : swarmLow ? { act: "tool", scope: "swarm", name: "Monte Carlo swarm", why: "It shows where the other agents did it differently." }
    : m.review.findings.length ? { act: "issues", name: "The issues", why: important ? "Read the important ones, with their fix." : "Only small points are left." }
    : null;
  return { score, verdict, parts, blocked, look, waiting: !sc.blast || !sc.swarm };
}
function adviceHtml() {
  const a = advice();
  const look = a.look
    ? `<p><b>Look at this first:</b> <button type="button" class="link" data-act="${a.look.act}" data-scope="${a.look.scope ?? ""}" data-sha="${a.look.sha ?? ""}">${esc(a.look.name)}</button>. ${esc(a.look.why)}</p>`
    : `<p>Nothing needs a closer look.</p>`;
  return `<div class="short advice ${a.verdict[1]}"><span class="short-label">My advice</span>
    <div class="advice-main"><strong>${a.verdict[0]}</strong><span class="advice-score" title="Merge score. 100 = nothing found.">${a.waiting ? "…" : a.score}<small> / 100</small></span></div>
    ${look}
    <details class="since-line" data-more="advice" ${ui.openMore.has("advice") ? "open" : ""}><summary>How the score is worked out</summary>
      <p>It starts at 100. A fixed rule takes points off. No AI is used.${a.blocked ? " Proof is missing, so the score is 0." : ""}</p>
      <ul class="advice-parts">${a.parts.map(([n, why]) => `<li><b>−${n}</b> ${esc(why)}</li>`).join("") || "<li>Nothing was taken off.</li>"}</ul>
      <p>75 or more: fine to merge. 45 to 74: look closer first. Under 45: do not merge yet.</p></details></div>`;
}
const scoresHtml = () => `<div class="scores">${scoreRows().map((r) => `<button type="button" class="score" data-act="tool" data-scope="${r.scope}" title="Open ${esc(r.name)}">
    <b>${esc(r.name)}</b>${r.wait ? `<span class="muted">working it out…</span><span></span>` : `<span class="tag ${esc(r.tone)}">${esc(r.score)}</span><span class="score-why">${esc(r.why)}${r.madeUp ? ` <span class="tag warn">made up</span>` : ""}</span>`}<i aria-hidden="true">›</i></button>`).join("")}</div>`;
const nextHtml = () => `<p><b>What the tools say.</b> <span class="muted">Click one to drill down.</span></p>
  <div class="scores-live"></div>
  <p class="next-ask">Merge now, or look closer first?</p>
  <div class="choices"><button type="button" class="choice main" data-act="merge"><b>Merge this PR</b><span>Sign off with your name.</span></button>
    <button type="button" class="choice" data-act="ask"><b>Ask the agent</b><span>Why it was written this way.</span></button></div>`;

// ----- messages -----
const threadOf = (key = reviewKey()) => (ui.threads[key] ??= []);
const msgHtml = (x) => (x.who === "me"
  ? `<div class="msg me"><div class="bubble">${esc(x.text)}</div></div>`
  : `<div class="msg bot"><div class="bot-mark" aria-hidden="true"></div><div class="bot-body">${x.html}</div></div>`);
function paintThread() {
  $("thread").innerHTML = `<div class="thread-inner" id="threadInner">${threadOf().map(msgHtml).join("")}</div>`;
  refreshIssues();
}
function addMsg(x, key) {
  threadOf(key).push(x);
  if (key !== reviewKey() || !$("threadInner")) return;
  $("threadInner").insertAdjacentHTML("beforeend", msgHtml(x));
  const el = $("threadInner").lastElementChild;
  el.classList.add("new");
  refreshIssues();
  el.scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: x.who === "me" ? "end" : "start" });
}
/** The person's own line. Messages keep their order, also while the reviewer is "typing". */
function me(text) {
  const key = reviewKey();
  ui.queue = ui.queue.then(() => addMsg({ who: "me", text }, key));
}
/** The reviewer's line. A short "typing" pause first, so it reads like a chat. */
function bot(html, wait = 450) {
  const key = reviewKey();
  ui.queue = ui.queue.then(async () => {
    if (key === reviewKey() && $("threadInner") && wait && !calm()) {
      $("threadInner").insertAdjacentHTML("beforeend", `<div class="msg bot typing"><div class="bot-mark" aria-hidden="true"></div><div class="bot-body"><span class="dots"><i></i><i></i><i></i></span></div></div>`);
      const typing = $("threadInner").lastElementChild;
      typing.scrollIntoView({ behavior: "smooth", block: "end" });
      await sleep(wait);
      typing.remove();
    }
    addMsg({ who: "bot", html }, key);
  });
  return ui.queue;
}
function startThread() {
  const m = state.model, t = threadOf();
  if (!t.length) t.push({ who: "bot", html: introHtml() }, { who: "bot", html: `<div class="issues-brief"></div>` }, { who: "bot", html: nextHtml() });
  loadScores();
  paintThread();
  $("thread").scrollTop = 0;
  // On a later commit: load the first commit once, to show what was fixed since.
  if (m.selected.index > 1 && !ui.first[state.prId]) {
    const id = state.prId;
    api(`/api/model?pr=${encodeURIComponent(id)}&sha=${currentPr().commits[0].sha}`).then((first) => {
      if (first.error) return;
      ui.first[id] = first;
      if (state.prId === id) refreshIssues();
    });
  }
}

// ----- tools: each one opens in the right panel, and says its result in one or two lines here -----
const TOOL_ASK = { pr: "Show me the Impact Map", full: "Show me the whole repo", blast: "Run the blast radius", swarm: "Run the Monte Carlo swarm" };
function mapSummary() {
  const m = state.model, n = m.diff.files.length;
  const red = m.graph.nodes.some((x) => x.evidence === "contradicted");
  return `<p>This PR edits <b>${things(n, "file", "files")}</b>. ${esc(m.classifier1.reason)}</p>
    <p class="muted">The map is open on the right. Orange = edited. Blue = affected, not edited.${red ? " Red = a unit test fails there." : ""} Click a box to see its code.</p>
    <div class="choices"><button type="button" class="choice" data-act="tool" data-scope="full"><b>See the whole repo</b><span>Every PR, one commit at a time.</span></button></div>`;
}
async function useTool(scope, said) {
  me(said ?? TOOL_ASK[scope]);
  await openCanvas("map", scope);
  if (scope === "pr") return bot(mapSummary());
  if (scope === "full") return bot(`<p>This is the <b>whole repo</b>, by area. It plays one commit at a time, across all ${state.revisions.prs.length} PRs.</p><p class="muted">Orange = edited. Blue = affected, not edited. Use ← Play → on the right.</p>`);
  if (scope === "blast") {
    const b = await loadBlast();
    if (!b.recorded) return bot(`<p>${esc(b.message)}</p>`);
    playBlast();
    const t = blastScore(b);
    return bot(`${trustHtml(t, BLAST_WHAT)}${whyHtml(t)}<p class="muted">It is playing on the right. Replays saved runs. No agent runs now.</p>`, 900);
  }
  await renderSwarm({ autoplay: true });
  const s = swarmUI.data;
  if (!s?.recorded) return bot(`<p>${esc(s?.message ?? "No runs are recorded for this PR yet.")}</p>`);
  const set = swarmSet(swarmUI.model), runs = set.runs.slice(0, swarmUI.count).map(swarmRun);
  const t = swarmScore(runs);
  return bot(`${trustHtml(t, SWARM_WHAT)}${whyHtml(t)}${set.madeUp ? `<p><span class="tag warn">Made up for the demo</span> ${esc(set.note.replace(/^Made up for the demo\.\s*/, ""))}</p>` : ""}<p class="muted">It is playing on the right. Click an agent there to see its change. Replays saved runs. No agent runs now.</p>`, 900);
}
function showPage(page, said) {
  me(said ?? (page === "pr" ? "Show me the full PR description" : "Show me the review steps"));
  openCanvas(page);
  return bot(page === "pr"
    ? `<p>The full PR description is open on the right. AI wrote it, in the team's PR shape.</p>`
    : `<p>The review steps are open on the right: fixed rules, then the AI review, then fixed rules again.</p><p class="muted">The AI review is advice only. The rules set the risk.</p>`);
}

// ----- merge: flag open issues, ask "are you sure", then a named sign-off -----
const nameForm = (lead) => `${lead}<p>Type your name to sign off. It is saved with ${esc(stepText(state.model))} only.</p>
  <form class="name-form" data-form="merge"><input name="name" type="text" placeholder="Your name" aria-label="Your name" autocomplete="name" /><button class="primary" type="submit">Sign off and merge</button><div class="error" role="alert"></div></form>`;
function startMerge(said) {
  me(said ?? "Merge this PR");
  if (SESSION) return bot(`<p>In this test you give your decision with the buttons below this screen.</p>`);
  const m = state.model, all = issueList(m), open = all.filter((x) => !acked(x.id)), hard = open.filter((x) => x.level === "block");
  if (m.decisions.signedOff) return bot(`<p><b>Already merged.</b> ${esc(m.decisions.signOff.name)} signed off ${esc(stepText(m))}.</p>`);
  if (hard.length) {
    const next = currentPr().commits.find((c) => c.index > m.selected.index);
    return bot(`<div class="warnbox bad"><b>I can't merge this yet.</b> ${things(hard.length, "thing has", "things have")} no proof:<ul>${hard.map((x) => `<li>${esc(x.title)}</li>`).join("")}</ul></div>
      <p>A sign-off cannot cover missing proof. The author must add it first.</p>
      ${next ? `<div class="choices"><button type="button" class="choice" data-act="commit" data-sha="${next.sha}"><b>Look at commit ${next.index}${next.madeUp ? " · made up" : ""}</b><span>${esc(next.message)}</span></button></div>` : ""}`);
  }
  if (open.length) {
    return bot(`<div class="warnbox"><b>Are you sure?</b> ${things(open.length, "issue is", "issues are")} still open:<ul>${open.map((x) => `<li>${esc(x.title)}</li>`).join("")}</ul></div>
      <p>Each one needs your OK before the PR can merge.</p>
      <div class="choices"><button type="button" class="choice main" data-act="issues"><b>Go through them</b><span>Read each one, then acknowledge it.</span></button>
      <button type="button" class="choice" data-act="ackall"><b>Acknowledge all ${open.length} and merge</b><span>You accept them as they are.</span></button></div>`);
  }
  return bot(nameForm(all.length ? `<p><b>All clear.</b> Every issue is acknowledged.</p>` : `<p><b>All clear.</b> There are no open issues.</p>`));
}
async function signOff(form) {
  const name = form.elements.name.value.trim(), err = form.querySelector(".error");
  err.textContent = "";
  if (!name) return void (err.textContent = "Type your name first.");
  if (openIssues().length) return void (err.textContent = "Some issues are open again. Acknowledge them first.");
  const titles = issueList(state.model).map((x) => x.title);
  const res = await api("/api/decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pr: state.prId, sha: state.sha, name, action: "sign-off", residualRisk: titles.length ? `Acknowledged: ${titles.join("; ")}` : "none" }),
  });
  if (!res.ok) return void (err.textContent = res.error);
  for (const x of form.querySelectorAll("input, button")) x.disabled = true;
  me(`Sign off as ${name}`);
  await load(state.prId, state.sha);
  bot(`<div class="okbox"><b>Merged.</b> ${esc(name)} signed off ${esc(stepText(state.model))}.</div>
    <p class="muted">Demo: the sign-off is saved with this commit. Nothing is pushed to GitHub.</p>
    <p>If this PR breaks something later, mark it. It then becomes a test for the AI reviewer.</p>
    <button type="button" class="danger" data-act="evalcase">Eval test case</button>`);
}

// ----- ask the agent that wrote the PR (demo: saved answers that come with the PR's context.md) -----
const suggestHtml = (list) => `<div class="choices">${list.map((c) => `<button type="button" class="choice" data-act="q" data-q="${esc(c.q)}"><b>${esc(c.q)}</b></button>`).join("")}</div>`;
function agentIntro(said) {
  me(said ?? "Ask the agent that wrote this PR");
  const a = state.model.agent;
  if (!a) return bot(`<p>This PR has no saved notes from its coding agent.</p>`);
  bot(`<p>Ask why the PR was written this way. The answers come from <button type="button" class="link" data-act="ctx">context.md</button>: the coding agent's own notes, saved with the PR.</p>
    ${suggestHtml(a.chat)}
    <div class="byline">${esc(a.model)} · snapshot ${esc(a.snapshot)} · made up for the demo: saved answers, no live model.</div>`);
  $("askInput").focus();
}
function askAgent(q) {
  me(q);
  const a = state.model.agent;
  if (!a) return bot(`<p>This PR has no saved notes from its coding agent.</p>`);
  const words = q.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const best = a.chat.map((c) => ({ c, n: words.filter((w) => `${c.q} ${c.keys ?? ""}`.toLowerCase().includes(w)).length })).sort((x, y) => y.n - x.n)[0];
  if (!best?.n) return bot(`<p>The demo only has saved answers. Try one of these:</p>${suggestHtml(a.chat)}`);
  const left = a.chat.filter((c) => c !== best.c && !threadOf().some((x) => x.who === "me" && x.text === c.q));
  return bot(`<p>${rich(best.c.a)}</p><div class="byline">Saved answer from <button type="button" class="link" data-act="ctx">context.md</button> · ${esc(a.model)} · no live model</div>${left.length ? suggestHtml(left) : ""}`, 700);
}
/** Free text: a tool name or "merge" does that. Anything else is a question for the agent. */
function handleText(q) {
  const s = q.toLowerCase();
  if (/\b(merge|sign.?off|approve|ship it)\b/.test(s)) return startMerge(q);
  if (/blast/.test(s)) return useTool("blast", q);
  if (/swarm|monte/.test(s)) return useTool("swarm", q);
  if (/whole repo|full map/.test(s)) return useTool("full", q);
  if (/impact|\bmap\b/.test(s)) return useTool("pr", q);
  if (/description/.test(s)) return showPage("pr", q);
  if (/review steps|classifier|rules/.test(s)) return showPage("review", q);
  if (/\b(issues?|problems?|findings?)\b/.test(s)) {
    me(q);
    return bot(`<div class="issues-live"></div>`);
  }
  return askAgent(q);
}

// ----- clicks: every button in the chat carries a data-act -----
async function act(b) {
  const a = b.dataset.act, m = state.model;
  if (!m) return;
  if (a === "merge") return startMerge();
  if (a === "tool") return useTool(b.dataset.scope);
  if (a === "page") return showPage(b.dataset.page);
  if (a === "ask") return agentIntro();
  if (a === "q") return askAgent(b.dataset.q);
  if (a === "ack") return setAck([b.dataset.id], true);
  if (a === "unack") return setAck([b.dataset.id], false);
  if (a === "ackminor") return setAck(openIssues().filter((x) => x.level === "minor").map((x) => x.id), true);
  if (a === "ackall") {
    me("Acknowledge all and merge");
    setAck(openIssues().filter((x) => x.level !== "block").map((x) => x.id), true);
    return bot(nameForm(`<p><b>Done.</b> Every issue is acknowledged.</p>`));
  }
  if (a === "issues") {
    me("Show me the open issues");
    return bot(`<div class="issues-live"></div>`);
  }
  if (a === "src") return select({ type: "source", file: b.dataset.src, line: Number(b.dataset.line) });
  if (a === "ctx") return openContext();
  if (a === "since") return select({ type: "since" });
  if (a === "run") return select({ type: "run" });
  if (a === "commit") return load(state.prId, b.dataset.sha);
  if (a === "evalcase") {
    await api("/api/evalcase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pr: state.prId, on: true }) });
    me("Mark it as an eval test case");
    await load(state.prId, state.sha);
    return bot(`<p><b>Saved.</b> This PR is now a test for the AI reviewer: a good reviewer must flag it.</p><p class="muted">You can remove the mark under “See the review steps”.</p>`);
  }
}
function initChat() {
  const onAct = (ev) => {
    const b = ev.target.closest?.("[data-act]");
    if (!b) return;
    ev.preventDefault(); // a button inside a fold's title must not open the fold
    act(b);
  };
  $("thread").addEventListener("click", onAct);
  $("quick").addEventListener("click", onAct);
  // Remember which "More" folds are open, so they stay open when the list is drawn again.
  $("thread").addEventListener("toggle", (ev) => {
    const id = ev.target.dataset?.more;
    if (!id) return;
    if (ev.target.open) ui.openMore.add(id);
    else ui.openMore.delete(id);
  }, true);
  $("thread").addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (ev.target.dataset.form === "merge") signOff(ev.target);
  });
  $("askForm").onsubmit = (ev) => {
    ev.preventDefault();
    const q = $("askInput").value.trim();
    if (!q || !state.model) return;
    $("askInput").value = "";
    handleText(q);
  };
  $("canvasClose").onclick = closeCanvas;
  $("railBtn").onclick = () => $("app").classList.toggle("rail-open");
  for (const b of $("rail").querySelectorAll("[data-doc]")) b.onclick = () => select({ type: "doc", file: b.dataset.doc });
  // "New review": this commit's chat starts again and what was acknowledged on it is forgotten.
  $("newReview").onclick = () => {
    if (!state.model) return;
    delete acks[reviewKey()];
    saveAcks();
    delete ui.threads[reviewKey()];
    ui.openMore.clear();
    closeCanvas();
    startThread();
  };
  // "Reset demo": also forgets every saved sign-off, on every PR.
  $("resetDemo").onclick = async () => {
    await api("/api/reset", { method: "POST" });
    acks = {};
    saveAcks();
    ui.threads = {};
    ui.key = null;
    ui.canvas = null;
    state.sel = null;
    await load(state.prId, state.sha);
  };
}

// ---------- light / dark ----------
// The app is always dark (user's choice, 2026-11-14). The light colours stay in style.css, unused.
function initTheme() {
  document.documentElement.dataset.theme = "dark";
}

async function init() {
  initTheme();
  state.revisions = await api("/api/revisions");
  const h = readHash();
  // Link form used by the GitHub replica: /?repo=<owner/name>&pr=<number>&sha=<sha>&embed=1
  const q = new URLSearchParams(location.search);
  if (q.get("embed") === "1" && !SESSION) document.body.classList.add("embed"); // a session shows the whole app
  if (SESSION) document.body.classList.add("session");
  initChat();
  // The right panel starts closed. ?map=<pr|full|blast|swarm> opens it on the Impact map card.
  // ?show=intentCard opens the full PR description, ?show=reviewCard the review steps.
  const show = (q.get("show") ?? "").split(",");
  if (q.get("map") || show.includes("mapCard")) ui.canvas = "map";
  else if (show.includes("reviewCard")) ui.canvas = "review";
  else if (show.includes("intentCard")) ui.canvas = "pr";
  const linkedRepo = q.get("repo");
  const linkedPr = q.get("pr") ? state.revisions.prs.find((p) => String(p.number) === q.get("pr") && (!linkedRepo || p.repo === linkedRepo)) : null;
  if (linkedRepo && !linkedPr) {
    // Never show another repo's analysis under this PR's name.
    $("thread").innerHTML = `<div class="thread-inner"><div class="card"><h2>No impact map for this pull request</h2>
      <p><span class="mono">${esc(linkedRepo)}</span> PR #${esc(q.get("pr"))} has not been analysed.</p></div></div>`;
    $("app").classList.add("bare");
    return;
  }
  if (!h.rev && linkedPr && q.get("sha")) h.rev = q.get("sha");
  const pr = state.revisions.prs.find((p) => p.id === h.pr) ?? linkedPr ?? state.revisions.prs[0];
  if (["concept", "file", "function"].includes(h.level)) state.level = h.level;
  const sha = pr.commits.some((c) => c.sha === h.rev) ? h.rev : pr.commits[0].sha;
  if (h.sel) state.sel = { type: "node", id: h.sel, label: h.sel.split("#").pop() };
  await load(pr.id, sha, { keepSelection: Boolean(h.sel) });
  if (q.get("chat") === "1") agentIntro(); // ?chat=1 starts on "Ask the agent"
  if (q.get("since") === "1" && state.model.since) select({ type: "since" });
  if (q.get("doc") === "context") openContext();
  else if (q.get("doc")) select({ type: "doc", file: q.get("doc") });
  if (q.get("map") === "blast") {
    // ?map=blast opens the "Blast radius" tab. &box=<box id> also opens that box in the side panel.
    await setScope("blast");
    await loadBlast();
    // &run=1 plays the runs. &done=1 or &box=<id> shows the result straight away.
    if (q.get("done") === "1" || q.get("box")) Object.assign(blastRun, { pr: state.prId, phase: "done" });
    render();
    if (q.get("run") === "1") playBlast();
    if (q.get("box")) selectBlast(q.get("box"));
  }
  // ?map=swarm opens the "Monte Carlo swarm" tab and plays it (&model=<id>&n=<count> to pick first,
  // &agent=<n> opens that agent, &measure=lines sets the matrix). The old ?map=blast&swarm=1 still works.
  if (q.get("map") === "swarm" || (q.get("map") === "blast" && q.get("swarm") === "1")) {
    if (q.get("measure") === "lines") swarmUI.measure = "lines";
    state.mapScope = "swarm";
    $("mapCard").dataset.scope = "swarm";
    $("blastView").hidden = true;
    $("swarmView").hidden = false;
    render();
    {
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
