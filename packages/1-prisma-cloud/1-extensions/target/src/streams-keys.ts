/**
 * The streams module's bearer key as an ADR-0031 provisioning need: the ONE
 * brand, the ONE enumeration of faceted streams edges, and the ONE key
 * env-var name — shared by control.ts (which registers the provisioner that
 * mints them; see its `streamsApiKeyProvisioner`), descriptors/compute.ts
 * (which lands the provider's key in `serialize`) and compute.ts (which
 * re-stashes it address-free for the entrypoint), so minting and wiring can
 * never drift apart. Mirrors `service-keys.ts` exactly.
 *
 * **Why the brand lives here, not in the declaring package.** ADR-0031's
 * discipline is that the declarer owns the brand and the target imports it —
 * which is what `@internal/rpc` does, sitting BELOW the target. `@internal/streams`
 * sits ABOVE it (prisma-cloud's layer order is lowering → extensions →
 * modules), so a target import of the module would invert the layering. The
 * brand therefore lives in the target and the module imports it downward; the
 * writer/reader-share-one-key discipline is unchanged.
 *
 * This module is also reachable from the RUNTIME/authoring side (compute.ts,
 * re-exported through index.ts) — it must never import `@internal/lowering`
 * or `effect`, or those tokens leak into a user service's bundle (the
 * provisioner itself lives in control.ts, the control-plane-only entry).
 */
import type { Graph, ProvisionNeed } from '@internal/core';
import { provisionNeed } from '@internal/core';
import { configKey } from './serializer.ts';

/** ADR-0031's need brand for the streams module's bearer key — control.ts registers the provisioner under this. */
export const STREAMS_API_KEY: unique symbol = Symbol.for('prisma:streams/api-key');

/**
 * The provisioning need `durableStreams()`'s `apiKey` param declares: an
 * unguessable value the target mints ONCE PER PROVIDER (not per edge) —
 * `@prisma/streams-server` authenticates a single `API_KEY`, so every
 * consumer of one streams module must present the same value. Per-provider
 * cardinality is provisioner policy (ADR-0031), invisible to core.
 */
export const streamsApiKeyNeed = (): ProvisionNeed => provisionNeed(STREAMS_API_KEY);

/** One faceted dependency edge: a consumer's input whose `apiKey` param carries the streams need. */
export interface StreamsApiKeyEdge {
  /** `${consumerAddress}.${input}` — `ctx.provisioned`'s key. */
  readonly edgeId: string;
  readonly consumerAddress: string;
  readonly input: string;
  readonly providerAddress: string;
}

/** Every faceted streams edge in the graph — scans each dependency edge's consumer-side input for the need. */
export function streamsApiKeyEdges(graph: Graph): readonly StreamsApiKeyEdge[] {
  const edges: StreamsApiKeyEdge[] = [];

  for (const edge of graph.edges) {
    if (edge.kind !== 'dependency') continue;
    const consumer = graph.nodes.find((n) => n.id === edge.to)?.node;
    if (consumer === undefined || consumer.kind !== 'service') continue;
    const slot = consumer.inputs[edge.input];
    if (slot === undefined) continue;
    if (slot.connection.params['apiKey']?.provision?.brand !== STREAMS_API_KEY) continue;

    edges.push({
      edgeId: `${edge.to}.${edge.input}`,
      consumerAddress: edge.to,
      input: edge.input,
      providerAddress: edge.from,
    });
  }

  return edges;
}

/** The reserved key env var: COMPOSER_<addr>_STREAMS_API_KEY ("" ↦ the address-free name the entrypoint reads). */
export const streamsApiKeyEnvName = (address: string): string =>
  configKey(address, { owner: 'service', name: 'STREAMS_API_KEY' });

/** The address-free name compute.ts re-stashes to and the streams entrypoint reads. */
export const STREAMS_API_KEY_ENV = streamsApiKeyEnvName('');
