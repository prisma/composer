/** Pipeline step 5: assembles each service's deploy artifact via its build descriptor at config.extensions[build.extension].nodes[build.type]. */
import type { Graph, GraphNode, ServiceNode } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import type { Bundle } from '@internal/core/deploy';
import { CliStructuredError } from '@internal/foundation/errors';
import { AssembleError } from './assemble-error.ts';

export interface AssembledServices {
  /** One bundle per provisioned service, keyed by the service's full hierarchical address (its graph id). */
  readonly bundles: Record<string, Bundle>;
}

/** Assembles one service node — the seam tests substitute to avoid a real build. */
export type RunAssembler = (node: ServiceNode, address: string, cwd: string) => Promise<Bundle>;

/**
 * The registry route for one service's build: extension by
 * `build.extension`, node descriptor by `build.type`, kind must be "build".
 * The CLI's coverage validation reports the same misses earlier with the
 * config fix; these errors are the backstop for programmatic callers.
 */
function buildDescriptorAssemble(
  config: PrismaAppConfig,
  node: ServiceNode,
  address: string,
  cwd: string,
): Promise<Bundle> {
  const { extension, type } = node.build;
  const extensionDescriptor = config.extensions.find((candidate) => candidate.id === extension);
  if (extensionDescriptor === undefined) {
    throw new AssembleError(
      'ASSEMBLE.EXTENSION_MISSING',
      `No extension "${extension}" is configured (needed by service "${node.name}"'s build).`,
      { fix: "Add it to prisma-composer.config.ts's `extensions`." },
    );
  }
  const nodeDescriptor = extensionDescriptor.nodes[type];
  if (nodeDescriptor === undefined) {
    throw new AssembleError(
      'ASSEMBLE.DESCRIPTOR_MISSING',
      `Extension "${extension}" has no descriptor for build type "${type}".`,
      { why: `Known types: ${Object.keys(extensionDescriptor.nodes).join(', ')}.` },
    );
  }
  if (nodeDescriptor.kind !== 'build') {
    throw new AssembleError(
      'ASSEMBLE.DESCRIPTOR_KIND_MISMATCH',
      `Extension "${extension}"'s descriptor for type "${type}" is a "${nodeDescriptor.kind}" descriptor.`,
      { why: 'Assembling a service build needs a "build" descriptor.' },
    );
  }
  return nodeDescriptor.assemble({
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
    run ?? ((node, address, nodeCwd) => buildDescriptorAssemble(config, node, address, nodeCwd));
  const serviceNodes = graph.nodes.filter(
    (n): n is GraphNode & { node: ServiceNode } => n.node.kind === 'service',
  );
  if (serviceNodes.length === 0) {
    throw new AssembleError(
      'ASSEMBLE.SERVICE_MISSING',
      'The loaded graph has no service to assemble.',
    );
  }

  const bundles: Record<string, Bundle> = {};
  for (const { id, node } of serviceNodes) {
    try {
      bundles[id] = await runAssembler(node, id, cwd);
    } catch (error) {
      // A foreign build failure (the RunAssembler or a descriptor's own
      // assemble) is structured here, at the loop that knows the address
      // (base-type rule 6); an already-structured error passes through.
      if (CliStructuredError.is(error)) throw error;
      throw new AssembleError(
        'ASSEMBLE.BUILD_FAILED',
        error instanceof Error ? error.message : String(error),
        { meta: { address: id }, cause: error },
      );
    }
  }
  return { bundles };
}
