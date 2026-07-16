/**
 * ADR-0030's per-binding service keys: the ONE enumeration of faceted RPC
 * edges and the ONE accepted-keys env-var name — shared by control.ts (which
 * registers the provisioner that mints them; see its `serviceKeyProvisioner`)
 * and descriptors/compute.ts (serializes the provider's accepted set, in
 * `serialize`) so minting and wiring can never drift apart. Reacts only to
 * the `serviceKey` connection param's `provision.brand` — never to "rpc" by
 * name, keeping the target's not-RPC-special-cased promise.
 *
 * This module is also reachable from the RUNTIME/authoring side (compute.ts,
 * re-exported through index.ts) — it must never import `@internal/lowering`
 * or `effect`, or those tokens leak into a user service's bundle (the
 * provisioner itself lives in control.ts, the control-plane-only entry).
 */
import type { Graph } from '@internal/core';
import { RPC_PEER_KEY } from '@internal/rpc';
import { configKey } from './serializer.ts';

/** One faceted dependency edge: a consumer's input whose `serviceKey` param carries RPC's provisioning need. */
export interface ServiceKeyEdge {
  /** `${consumerAddress}.${input}` — the mint id and `ctx.provisioned`'s key. */
  readonly edgeId: string;
  readonly consumerAddress: string;
  readonly input: string;
  readonly providerAddress: string;
}

/** Every faceted RPC edge in the graph — scans each dependency edge's consumer-side input for the need. */
export function serviceKeyEdges(graph: Graph): readonly ServiceKeyEdge[] {
  const edges: ServiceKeyEdge[] = [];

  for (const edge of graph.edges) {
    if (edge.kind !== 'dependency') continue;
    const consumer = graph.nodes.find((n) => n.id === edge.to)?.node;
    if (consumer === undefined || consumer.kind !== 'service') continue;
    const slot = consumer.inputs[edge.input];
    if (slot === undefined) continue;
    if (slot.connection.params['serviceKey']?.provision?.brand !== RPC_PEER_KEY) continue;

    edges.push({
      edgeId: `${edge.to}.${edge.input}`,
      consumerAddress: edge.to,
      input: edge.input,
      providerAddress: edge.from,
    });
  }

  return edges;
}

/** The reserved accepted-keys env var: COMPOSER_<addr>_RPC_ACCEPTED_KEYS ("" ↦ @internal/rpc's RPC_ACCEPTED_KEYS_ENV). */
export const serviceKeyEnvName = (address: string): string =>
  configKey(address, { owner: 'service', name: 'RPC_ACCEPTED_KEYS' });
