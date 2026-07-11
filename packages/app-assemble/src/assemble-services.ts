/**
 * Pipeline step 5 (deploy-cli.md § The pipeline, ADR-0004/0017): for every
 * service node in the loaded graph, assembles its deploy artifact through the
 * config's extension registries — the build control at
 * `config.extensions[build.extension].nodes[build.type]` (the same
 * (extension, node-ID) routing every node gets). This package does no module
 * loading and no path resolution of its own; the control functions arrived
 * through `prisma-app.config.ts`'s static imports. The root is always a
 * system, so this produces one bundle per provisioned service, keyed by the
 * service's full hierarchical address (its graph id — the same id the
 * generated stack file and `lower()`'s bundle lookup both use).
 */
import type { Graph, GraphNode, ServiceNode } from '@prisma/app';
import type { PrismaAppConfig } from '@prisma/app/config';
import type { Bundle } from '@prisma/app/deploy';
import { AssembleError } from './assemble-error.ts';
import { INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS } from './wrapper-inline.ts';

export interface AssembledServices {
  /** One bundle per provisioned service, keyed by the service's full hierarchical address (its graph id). */
  readonly bundles: Record<string, Bundle>;
}

/** Assembles one service node — the seam tests substitute to avoid a real build. */
export type RunAssembler = (node: ServiceNode) => Promise<Bundle>;

/**
 * The registry route for one service's build: descriptor by
 * `build.extension`, control by `build.type`, kind must be "build". The CLI's
 * coverage validation reports the same misses earlier with the config fix;
 * these errors are the backstop for programmatic callers.
 */
function buildControlAssemble(config: PrismaAppConfig, node: ServiceNode): Promise<Bundle> {
  const { extension, type } = node.build;
  const descriptor = config.extensions.find((candidate) => candidate.id === extension);
  if (descriptor === undefined) {
    throw new AssembleError(
      `No extension "${extension}" is configured (needed by service "${node.name}"'s build) — ` +
        "add it to prisma-app.config.ts's `extensions`.",
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
    wrapperNoExternal: INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS,
  });
}

export async function assembleServices(
  graph: Graph,
  config: PrismaAppConfig,
  run?: RunAssembler,
): Promise<AssembledServices> {
  const runAssembler: RunAssembler = run ?? ((node) => buildControlAssemble(config, node));
  const serviceNodes = graph.nodes.filter(
    (n): n is GraphNode & { node: ServiceNode } => n.node.kind === 'service',
  );
  if (serviceNodes.length === 0) {
    throw new AssembleError('The loaded graph has no service to assemble.');
  }

  const bundles: Record<string, Bundle> = {};
  for (const { id, node } of serviceNodes) {
    bundles[id] = await runAssembler(node);
  }
  return { bundles };
}
