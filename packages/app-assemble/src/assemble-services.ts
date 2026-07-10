/**
 * Pipeline step 5 (deploy-cli.md § The pipeline, ADR-0004/0005): for every
 * service node in the loaded graph, assembles its deploy artifact by calling
 * the node's OWN `assemble()` — node-owned loading (@prisma/app's
 * node.ts): the node carries its build adapter's `assembler` module
 * specifier as data and imports it itself; this package does no path
 * resolution, no pack-to-specifier construction, and no entry-anchoring of
 * its own. The root is always a hex, so this produces one bundle per
 * provisioned service, keyed by the service's full hierarchical address
 * (its graph id — the same id the generated stack file and `lower()`'s
 * bundle lookup both use).
 */
import type { Graph, GraphNode, ServiceNode } from '@prisma/app';
import type { Bundle } from '@prisma/app/deploy';
import { AssembleError } from './assemble-error.ts';
import { INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS } from './wrapper-inline.ts';

export interface AssembledServices {
  /** One bundle per provisioned service, keyed by the service's full hierarchical address (its graph id). */
  readonly bundles: Record<string, Bundle>;
}

/** Assembles one service node — the seam tests substitute to avoid a real build. */
export type RunAssembler = (node: ServiceNode) => Promise<Bundle>;

/** Default: the node's own assemble(), inlining everything except runtime builtins into the wrapper. */
const defaultRunAssembler: RunAssembler = (node) =>
  node.assemble({ wrapperNoExternal: INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS });

export async function assembleServices(
  graph: Graph,
  run: RunAssembler = defaultRunAssembler,
): Promise<AssembledServices> {
  const serviceNodes = graph.nodes.filter(
    (n): n is GraphNode & { node: ServiceNode } => n.node.kind === 'service',
  );
  if (serviceNodes.length === 0) {
    throw new AssembleError('The loaded graph has no service to assemble.');
  }

  const bundles: Record<string, Bundle> = {};
  for (const { id, node } of serviceNodes) {
    bundles[id] = await run(node);
  }
  return { bundles };
}
