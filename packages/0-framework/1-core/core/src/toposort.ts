import { type Edge, type GraphNode, LoadError, type NodeId } from './graph-types.ts';

/**
 * Stable topological sort: every edge's `from` precedes its `to` in the
 * result. Ties (nodes with no ordering constraint between them) keep their
 * relative order from `nodes` — so a graph already authored producer-first
 * comes out byte-identical to its pre-sort layout; only a graph that
 * genuinely needs reordering (e.g. a module wired via a forged ref pointing at a
 * not-yet-provisioned producer) actually moves. A Kahn's-algorithm variant
 * that always picks the ready node with the smallest original index. Edges
 * whose endpoint falls outside `nodes` (e.g. a service-root's input edges
 * targeting the root, which is appended separately) are ignored. Cycles
 * cannot reach here: `assertDependencyDag` already rejects them for
 * dependency edges, and input edges never cycle.
 */
export function topoSort(nodes: readonly GraphNode[], edges: readonly Edge[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
  const indegree = new Map<NodeId, number>(nodes.map((n) => [n.id, 0]));
  const successors = new Map<NodeId, NodeId[]>();

  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const targets = successors.get(edge.from) ?? [];
    targets.push(edge.to);
    successors.set(edge.from, targets);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const ready = new Set(nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id));
  const order: NodeId[] = [];

  while (ready.size > 0) {
    let next: NodeId | undefined;
    let bestIndex = Number.POSITIVE_INFINITY;
    for (const id of ready) {
      const index = indexOf.get(id) ?? Number.POSITIVE_INFINITY;
      if (index < bestIndex) {
        bestIndex = index;
        next = id;
      }
    }
    if (next === undefined) break;
    ready.delete(next);
    order.push(next);
    for (const target of successors.get(next) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) ready.add(target);
    }
  }

  // Kahn's leaves cyclic nodes unprocessed rather than looping. A cycle can't
  // reach here (assertDependencyDag runs first; input edges never cycle), but
  // if that guard were ever bypassed, dropping nodes silently would be far
  // worse than failing — so assert completeness.
  if (order.length !== nodes.length) {
    throw new LoadError(
      `topological sort processed ${order.length} of ${nodes.length} nodes — ` +
        'the graph contains a cycle that slipped past the DAG validation.',
    );
  }

  return order.map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
}
