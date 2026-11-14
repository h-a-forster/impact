// Impact map graph: React Flow draws it, Dagre lays it out left to right.
// This is a small React island. `app.js` owns all state and calls
// `window.ImpactGraph.render(el, props)` on every render.
// Build: `npm run build:graph` -> src/public/graph.bundle.js + graph.bundle.css
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Background, BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";

const NODE_W = 200, NODE_H = 50, GRID_GAP_X = 24, GRID_GAP_Y = 14;
const FIT_MAX_ZOOM = 1.15, MAX_ROWS = 9, MAX_SPLIT = 4;
// Room at the top for the zoom buttons, so they never sit on a box.
const FIT_PADDING = { top: "50px", right: "14px", bottom: "14px", left: "14px" };
const STATE_RANK = { edited: 0, downstream: 1, none: 2 };

/**
 * Left to right: requirement -> PR -> edited code -> code that uses it.
 * A "calls" link points from the user to the thing it uses, so it is turned
 * round for the layout: the used thing sits on the left, its users on the right.
 * Boxes with no link at all go in a grid under the graph.
 */
function layout(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const live = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const linked = new Set(live.flatMap((e) => [e.from, e.to]));
  const pos = new Map(), paths = new Map();
  let width = 0, height = 0;

  if (linked.size) {
    const dir = (e) => (e.kind === "calls" || e.kind === "tests" ? [e.to, e.from] : [e.from, e.to]);
    const run = (minlen) => {
      const g = new dagre.graphlib.Graph({ multigraph: true });
      g.setGraph({ rankdir: "LR", nodesep: 14, edgesep: 8, ranksep: 60, marginx: 0, marginy: 0 });
      g.setDefaultEdgeLabel(() => ({}));
      for (const n of nodes) if (linked.has(n.id)) g.setNode(n.id, { width: NODE_W, height: NODE_H });
      for (const e of live) {
        const [v, w] = dir(e);
        g.setEdge(v, w, { weight: e.kind === "may-affect" ? 1 : 3, minlen: minlen(v, w) }, e.id);
      }
      dagre.layout(g);
      return g;
    };
    let g = run(() => 1);
    // A column with too many boxes is split into a few columns side by side,
    // so a big map is wide and short, not one tall stack. Dagre then lays it out again.
    const columns = new Map();
    for (const id of linked) {
      const x = Math.round(g.node(id).x);
      (columns.get(x) ?? columns.set(x, []).get(x)).push(id);
    }
    const sub = new Map(), span = new Map();
    for (const list of columns.values()) {
      if (list.length <= MAX_ROWS) continue;
      const parts = Math.min(MAX_SPLIT, Math.ceil(list.length / MAX_ROWS));
      list.sort((p, q) => g.node(p).y - g.node(q).y).forEach((id, i) => {
        sub.set(id, i % parts);
        span.set(id, parts);
      });
    }
    if (sub.size) g = run((v, w) => 1 + (sub.get(w) ?? 0) + (span.get(v) ?? 1) - 1 - (sub.get(v) ?? 0));
    for (const id of linked) {
      const p = g.node(id);
      pos.set(id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
    }
    // Dagre routes each link round the boxes in its way. Keep that route.
    for (const e of live) {
      const [v, w] = dir(e);
      const pts = g.edge({ v, w, name: e.id }).points;
      paths.set(e.id, spline(v === e.from ? pts : [...pts].reverse()));
    }
    width = g.graph().width;
    height = g.graph().height;
  }

  const loose = nodes.filter((n) => !linked.has(n.id)).sort((a, b) => STATE_RANK[a.state ?? "none"] - STATE_RANK[b.state ?? "none"] || a.label.localeCompare(b.label));
  if (loose.length) {
    const cols = Math.max(4, Math.min(7, Math.round((width + GRID_GAP_X) / (NODE_W + GRID_GAP_X))));
    const top = linked.size ? height + 34 : 0;
    loose.forEach((n, i) => pos.set(n.id, { x: (i % cols) * (NODE_W + GRID_GAP_X), y: top + Math.floor(i / cols) * (NODE_H + GRID_GAP_Y) }));
    const rows = Math.ceil(loose.length / cols);
    width = Math.max(width, Math.min(cols, loose.length) * (NODE_W + GRID_GAP_X) - GRID_GAP_X);
    height = top + rows * (NODE_H + GRID_GAP_Y) - GRID_GAP_Y;
  }
  return { pos, paths, width, height, live };
}

/** A smooth line through Dagre's route points (a B-spline, as d3's curveBasis draws it). */
function spline(p) {
  const last = p[p.length - 1];
  if (p.length < 3) return `M${p[0].x},${p[0].y}L${last.x},${last.y}`;
  let x0 = p[0].x, y0 = p[0].y, x1 = p[1].x, y1 = p[1].y;
  let d = `M${x0},${y0}L${(5 * x0 + x1) / 6},${(5 * y0 + y1) / 6}`;
  const seg = (x, y) => {
    d += `C${(2 * x0 + x1) / 3},${(2 * y0 + y1) / 3},${(x0 + 2 * x1) / 3},${(y0 + 2 * y1) / 3},${(x0 + 4 * x1 + x) / 6},${(y0 + 4 * y1 + y) / 6}`;
    x0 = x1; y0 = y1; x1 = x; y1 = y;
  };
  for (let i = 2; i < p.length; i++) seg(p[i].x, p[i].y);
  seg(x1, y1);
  return d + `L${x1},${y1}`;
}

/** Light or dark, from `data-theme` on <html>. Colours come from the CSS variables in style.css. */
function useTheme() {
  const read = () => document.documentElement.dataset.theme ?? "light";
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function Box({ data }) {
  const { n, onPick, delay } = data;
  const cls = ["gnode", n.type, n.state !== "none" ? n.state : "", n.failing ? "failing" : "", n.id === "concept:tests" ? "tests" : "", n.dim ? "dim" : "", n.selected ? "selected" : "", delay !== null ? "forming" : n.now ? "now" : ""].filter(Boolean).join(" ");
  const onKeyDown = (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    onPick(n.id);
  };
  return (
    <div className={cls} style={delay !== null ? { animationDelay: `${delay}s` } : undefined} title={`${n.label}\n${n.sub ?? ""}`} role="button" tabIndex={0} aria-label={n.label} onKeyDown={onKeyDown}>
      <Handle type="target" position={Position.Left} id="lt" isConnectable={false} />
      <Handle type="source" position={Position.Left} id="ls" isConnectable={false} />
      <Handle type="target" position={Position.Right} id="rt" isConnectable={false} />
      <Handle type="source" position={Position.Right} id="rs" isConnectable={false} />
      {(n.badge || n.isNew) && (
        <div className="gnode-badges">
          <span className={`gnode-badge ${n.badge?.[1] ?? ""}`}>{n.badge?.[0] ?? ""}</span>
          {n.isNew && <span className="gnode-badge ok">NEW</span>}
        </div>
      )}
      <div className="gnode-label">{n.label}</div>
      {n.sub ? <div className="gnode-sub">{n.sub}</div> : null}
    </div>
  );
}
const nodeTypes = { box: Box };

/** A link drawn along the route Dagre found. */
function Routed({ data, style, markerEnd, interactionWidth }) {
  return <BaseEdge path={data.d} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />;
}
const edgeTypes = { routed: Routed };

const EDGE_VAR = { calls: "--muted", tests: "--test", edits: "--edited", "may-affect": "--down", implements: "--req" };

function Graph({ laid, nodes, onNode, onEdge, viewKey }) {
  const theme = useTheme();
  // The graph forms once per view: boxes pop in left to right, then the links fade in.
  const [formed, setFormed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFormed(true), 2400);
    return () => clearTimeout(t);
  }, []);
  const delayOf = (id) => {
    const p = laid.pos.get(id);
    return Math.round((1.1 * p.x / Math.max(1, laid.width) + 0.25 * p.y / Math.max(1, laid.height)) * 100) / 100;
  };
  const rfNodes = nodes.map((n) => ({
    id: n.id,
    type: "box",
    position: laid.pos.get(n.id),
    width: NODE_W,
    height: NODE_H,
    data: { n, onPick: onNode, delay: formed ? null : delayOf(n.id) },
    draggable: false,
    selectable: false,
    focusable: false,
  }));
  const rfEdges = laid.live.map((e) => {
    const a = laid.pos.get(e.from), b = laid.pos.get(e.to);
    const color = cssVar(e.selected ? "--ink" : EDGE_VAR[e.kind] ?? "--muted");
    const dashed = e.kind === "may-affect" || e.inferred;
    return {
      id: e.id,
      type: "routed",
      data: { d: laid.paths.get(e.id) },
      source: e.from,
      target: e.to,
      // Leave from the side that faces the other box.
      sourceHandle: a.x <= b.x ? "rs" : "ls",
      targetHandle: a.x < b.x ? "lt" : "rt",
      className: `gedge ${e.dim ? "dim" : ""} ${onEdge ? "pick" : ""}`,
      style: { stroke: color, strokeWidth: e.selected ? 3 : e.added ? 2.6 : e.kind === "edits" ? 2 : 1.4, strokeDasharray: e.selected ? undefined : e.kind === "tests" ? "2 4" : dashed ? "7 4" : undefined, transition: "stroke .6s", animation: formed ? undefined : `gfade .5s ${Math.max(delayOf(e.from), delayOf(e.to)) + 0.35}s both` },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      interactionWidth: onEdge ? 16 : 0,
      selectable: false,
      focusable: false,
      ariaLabel: e.title,
    };
  });
  return (
    <ReactFlow
      key={viewKey}
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={theme}
      fitView
      fitViewOptions={{ padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM }}
      minZoom={0.2}
      maxZoom={2.5}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      elementsSelectable={false}
      zoomOnScroll={false}
      preventScrolling={false}
      onNodeClick={(_, node) => onNode(node.id)}
      onEdgeClick={onEdge ? (_, edge) => onEdge(edge.id) : undefined}
    >
      <Background color={cssVar("--line")} gap={18} size={1.4} />
      <Controls showInteractive={false} position="top-right" orientation="horizontal" fitViewOptions={{ padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM }} />
    </ReactFlow>
  );
}

const roots = new WeakMap();
window.ImpactGraph = {
  /**
   * props: { viewKey, nodes, edges, onNode(id), onEdge(id) | null }
   * node: { id, type, state, label, sub, badge: [text, tone] | null, isNew, failing, dim, selected }
   * edge: { id, from, to, kind, inferred, added, dim, selected, title }
   * The view is fitted again only when `viewKey` changes, so a click keeps the zoom.
   */
  render(el, props) {
    let root = roots.get(el);
    if (!root) {
      el.innerHTML = "";
      root = createRoot(el);
      roots.set(el, root);
    }
    const laid = layout(props.nodes, props.edges);
    // Tall enough for the graph at the zoom it will get when fitted to the width.
    const zoom = Math.min(FIT_MAX_ZOOM, ((el.clientWidth || 1000) - 30) / Math.max(1, laid.width));
    el.style.height = `${Math.round(Math.max(240, Math.min(640, laid.height * zoom + 68)))}px`;
    root.render(<Graph key={props.viewKey} laid={laid} nodes={props.nodes} onNode={props.onNode} onEdge={props.onEdge} viewKey={props.viewKey} />);
  },
};
