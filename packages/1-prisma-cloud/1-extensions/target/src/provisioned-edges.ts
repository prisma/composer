/**
 * The ONE scan for ADR-0031 provisioned edges: every dependency edge whose
 * consumer-side input declares a param with a `provision` need, carrying that
 * need's brand as DATA. No brand is named here — a brand is a value the
 * declaring package owns and the target registers under, so recognising one
 * is a map lookup, never a branch (the anti-pattern ADR-0031 exists to
 * prevent).
 *
 * Consumed by `descriptors/compute.ts` (which groups a provider's inbound
 * edges by brand and hands each group to that brand's registered provider
 * param) and by tests. Nothing here knows what any brand means.
 *
 * This module is reachable from the RUNTIME/authoring side (re-exported
 * through index.ts) — it must never import `@internal/lowering` or `effect`.
 */
import type { Graph } from '@internal/core';

/** One faceted dependency edge: a consumer input whose param carries a provisioning need. */
export interface ProvisionedEdge {
  /** `${consumerAddress}.${input}` — `ctx.provisioned`'s key. */
  readonly edgeId: string;
  readonly consumerAddress: string;
  readonly input: string;
  readonly providerAddress: string;
  /** The need's brand — opaque here; the target's registry gives it meaning. */
  readonly brand: symbol;
}

/**
 * Every provisioned edge in the graph. Core resolves and mints these (one
 * value per edge, keyed by `edgeId`); this scan is how the target finds them
 * again when it gathers a provider's inbound values.
 */
export function provisionedEdges(graph: Graph): readonly ProvisionedEdge[] {
  const edges: ProvisionedEdge[] = [];

  for (const edge of graph.edges) {
    if (edge.kind !== 'dependency') continue;
    const consumer = graph.nodes.find((n) => n.id === edge.to)?.node;
    if (consumer === undefined || consumer.kind !== 'service') continue;
    const slot = consumer.inputs[edge.input];
    if (slot === undefined) continue;

    for (const param of Object.values(slot.connection.params)) {
      const brand = param.provision?.brand;
      if (brand === undefined) continue;
      edges.push({
        edgeId: `${edge.to}.${edge.input}`,
        consumerAddress: edge.to,
        input: edge.input,
        providerAddress: edge.from,
        brand,
      });
      // Core rejects a connection with more than one provisioned param, so the
      // first is the edge's only one.
      break;
    }
  }

  return edges;
}
