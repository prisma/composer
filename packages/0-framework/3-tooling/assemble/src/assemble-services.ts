/** Pipeline step 5: assembles each service's deploy artifact via its build control at config.extensions[build.extension].nodes[build.type]. */
import type { Graph, GraphNode, ServiceNode } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import type { Bundle } from '@internal/core/deploy';
import { AssembleError } from './assemble-error.ts';

export interface AssembledServices {
  /** One bundle per provisioned service, keyed by the service's full hierarchical address (its graph id). */
  readonly bundles: Record<string, Bundle>;
}

/** Assembles one service node — the seam tests substitute to avoid a real build. */
export type RunAssembler = (node: ServiceNode, address: string, cwd: string) => Promise<Bundle>;

/**
 * The registry route for one service's build: descriptor by
 * `build.extension`, control by `build.type`, kind must be "build". The CLI's
 * coverage validation reports the same misses earlier with the config fix;
 * these errors are the backstop for programmatic callers.
 */
function buildControlAssemble(
  config: PrismaAppConfig,
  node: ServiceNode,
  address: string,
  cwd: string,
): Promise<Bundle> {
  const { extension, type } = node.build;
  const descriptor = config.extensions.find((candidate) => candidate.id === extension);
  if (descriptor === undefined) {
    throw new AssembleError(
      `No extension "${extension}" is configured (needed by service "${node.name}"'s build) — ` +
        "add it to prisma-composer.config.ts's `extensions`.",
    );
  }
  const control = descriptor.nodes[type];
  if (control === undefined) {
    throw new AssembleError(
      `Extension "${extension}" has no control for build type "${type}" ` +
        `(known: ${Object.keys(descriptor.nodes).join(', ')}).`,
    );
  }
  if (control.kind !== 'build') {
    throw new AssembleError(
      `Extension "${extension}"'s control for type "${type}" is a "${control.kind}" control — ` +
        'a service build descriptor needs a "build" control.',
    );
  }
  return control.assemble({
    build: node.build,
    address,
    cwd,
  });
}

export async function assembleServices(
  graph: Graph,
  config: PrismaAppConfig,
  cwd: string,
  run?: RunAssembler,
): Promise<AssembledServices> {
  const runAssembler: RunAssembler =
    run ?? ((node, address, nodeCwd) => buildControlAssemble(config, node, address, nodeCwd));
  const serviceNodes = graph.nodes.filter(
    (n): n is GraphNode & { node: ServiceNode } => n.node.kind === 'service',
  );
  if (serviceNodes.length === 0) {
    throw new AssembleError('The loaded graph has no service to assemble.');
  }

  const bundles: Record<string, Bundle> = {};
  for (const { id, node } of serviceNodes) {
    bundles[id] = await runAssembler(node, id, cwd);
  }
  return { bundles };
}
