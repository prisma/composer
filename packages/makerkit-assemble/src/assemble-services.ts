/**
 * Pipeline step 5 (deploy-cli.md § The pipeline, ADR-0004/0005): for every
 * service node in the loaded graph, route its build adapter's `pack` to the
 * matching `/assemble` entry and run it. The root is always a hex, so this
 * produces one bundle per provision id (graph.nodes' own ids for provisioned
 * services — the same correlation the interim `hex.ts` hand-wrote). Each
 * build adapter carries its own
 * authoring module (`build.module`) and resolves its paths (`build.entry`,
 * etc.) relative to it — this package does no path resolution of its own
 * here.
 *
 * Resolution is entry-anchored, exactly like the CLI's own pack-seam
 * (`${pack}/target`, ADR-0003): the adapter's factory bakes its own package
 * name onto the descriptor (`BuildAdapter.pack`, e.g. "@makerkit/node"), so
 * `${build.pack}/assemble` is resolved the same uniform way — no hardcoded
 * kind-to-package map. A community build adapter works with zero changes
 * here. `kind` stays the descriptor's own discriminant; the resolved
 * `/assemble` module validates it matches (each adapter's own `assemble()`
 * checks `input.build.kind` and throws if it doesn't recognize it).
 */
import type { BuildAdapter, Graph, GraphNode, ServiceNode } from '@makerkit/core';
import type { AssembleInput, Bundle } from '@makerkit/core/deploy';
import { AssembleError } from './assemble-error.ts';
import { importFromEntry } from './resolve-from-entry.ts';
import { INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS } from './wrapper-inline.ts';

export interface AssembledServices {
  /** One bundle per provisioned service, keyed by provision id. */
  readonly bundles: Record<string, Bundle>;
}

/** Extracts and validates a pack's `/assemble` module's `assemble` export. */
// biome-ignore lint/complexity/noBannedTypes: `mod` is an unknown dynamic-import result; the runtime `typeof assemble === 'function'` check right below is the actual guard, and the caller invokes it with its own typed AssembleInput/Bundle.
function extractAssemble(pack: string, specifier: string, mod: unknown): Function {
  const assemble =
    typeof mod === 'object' && mod !== null && 'assemble' in mod ? mod.assemble : undefined;
  if (typeof assemble !== 'function') {
    throw new AssembleError(
      `Pack "${pack}" has no assemble() export at "${specifier}" — a build adapter pack must ` +
        'export an assemble(input): Promise<Bundle> function from its /assemble entry.',
    );
  }
  return assemble;
}

/** Runs the pack's `/assemble` export against `input` — the seam tests substitute to avoid a real build. */
export type RunAssembler = (pack: string, input: AssembleInput) => Promise<Bundle>;

/** `entryPath` anchors resolution of each pack's `/assemble` entry (see resolve-from-entry.ts). */
async function runAssemblerFromEntry(
  entryPath: string,
  pack: string,
  input: AssembleInput,
): Promise<Bundle> {
  const specifier = `${pack}/assemble`;
  const mod = await importFromEntry(entryPath, pack, 'assemble');
  const assemble = extractAssemble(pack, specifier, mod);
  return assemble(input);
}

function assemblerPackFor(build: BuildAdapter): string {
  return build.pack;
}

async function assembleOne(node: ServiceNode, run: RunAssembler): Promise<Bundle> {
  const pack = assemblerPackFor(node.build);

  return run(pack, {
    build: node.build,
    wrapperNoExternal: INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS,
  });
}

export async function assembleServices(
  graph: Graph,
  entryPath: string,
  run: RunAssembler = (pack, input) => runAssemblerFromEntry(entryPath, pack, input),
): Promise<AssembledServices> {
  const serviceNodes = graph.nodes.filter(
    (n): n is GraphNode & { node: ServiceNode } => n.node.kind === 'service',
  );
  if (serviceNodes.length === 0) {
    throw new AssembleError('The loaded graph has no service to assemble.');
  }

  const bundles: Record<string, Bundle> = {};
  for (const { id, node } of serviceNodes) {
    bundles[id] = await assembleOne(node, run);
  }
  return { bundles };
}
