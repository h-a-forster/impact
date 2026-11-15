// The Reach lens of the Impact Map: what an edit reaches, by call distance.
// Pure and browser-safe (no Node imports): the map and the evals both use it.

/**
 * Ring 0 holds what the commit edits (functions, and files with no functions such as a doc).
 * Ring k holds the functions that call something on ring k - 1 and are not on a nearer ring.
 * `links` are the call links that carry the reach outward, from a node to its caller one ring out.
 */
export function reachRings(graph) {
  const nodes = graph.nodes.filter((n) => n.level === "function" && (n.type === "function" || n.type === "file"));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const callersOf = new Map();
  for (const e of graph.edges) {
    if (e.level !== "function" || e.kind !== "calls" || !byId.has(e.from) || !byId.has(e.to)) continue;
    if (!callersOf.has(e.to)) callersOf.set(e.to, []);
    callersOf.get(e.to).push(e.from);
  }
  const ring = new Map(nodes.filter((n) => n.state === "edited").map((n) => [n.id, 0]));
  const rings = [[...ring.keys()]];
  const links = [];
  for (let frontier = rings[0]; frontier.length; ) {
    const next = [];
    for (const id of frontier) {
      for (const caller of callersOf.get(id) ?? []) {
        if (!ring.has(caller)) {
          ring.set(caller, rings.length);
          next.push(caller);
        }
        if (ring.get(caller) === rings.length) links.push({ from: id, to: caller });
      }
    }
    if (next.length) rings.push(next);
    frontier = next;
  }
  return { ring, rings, links, byId };
}
