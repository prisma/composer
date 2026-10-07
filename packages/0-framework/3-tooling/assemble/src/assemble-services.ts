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

/** What a build adapter measured during one assemble, for progress output. Never read here. */
export type AssembleReport = (data: Readonly<Record<string, string | number>>) => void;

/** Assembles one service node — the seam tests substitute to avoid a real build. */
export type RunAssembler = (
  node: ServiceNode,
  address: string,
  cwd: string,
  report?: AssembleReport,
) => Promise<Bundle>;

/** One service's assemble starting or finishing, for a caller that reports progress. `data` is what the build adapter reported. */
export type AssembleEvent =
  | { readonly kind: 'service-started'; readonly address: string }
  | {
      readonly kind: 'service-assembled';
      readonly address: string;
      readonly data: Readonly<Record<string, string | number>>;
    };

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
  report: AssembleReport | undefined,
): Promise<Bundle> {
  const { extension, type } = node.build;
  const extensionDescriptor = config.extensions.find((candidate) => candidate.id === extension);
  if (extensionDescriptor === undefined) {
    throw new AssembleError(
      'ASSEMBLE.EXTENSION_MISSING',
      `No extension "${extension}" is configured (needed by service "${node.name}"'s build).`,
      { fix: 'Add it to `extensions` in the `composer` section of prisma.config.ts.' },
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
    report,
  });
}

export async function assembleServices(
  graph: Graph,
  config: PrismaAppConfig,
  cwd: string,
  run?: RunAssembler,
  onEvent?: (event: AssembleEvent) => void,
): Promise<AssembledServices> {
  const runAssembler: RunAssembler =
    run ??
    ((node, address, nodeCwd, report) =>
      buildDescriptorAssemble(config, node, address, nodeCwd, report));
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
    onEvent?.({ kind: 'service-started', address: id });
    const data: Record<string, string | number> = {};
    let artifact: Bundle;
    try {
      artifact = await runAssembler(node, id, cwd, (reported) => Object.assign(data, reported));
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
    bundles[id] = artifact;
    onEvent?.({ kind: 'service-assembled', address: id, data });
  }
  return { bundles };
}
