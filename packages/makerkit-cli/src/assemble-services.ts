/**
 * Pipeline step 5 (deploy-cli.md § The pipeline, ADR-0004/0005): for every
 * service node in the loaded graph, route its build adapter's `kind` to the
 * matching `/assemble` entry and run it. A service root produces one bundle;
 * a hex root produces one bundle per provision id (graph.nodes' own ids for
 * provisioned services — the same correlation the interim
 * `alchemy.run.ts`/`hex.ts` hand-wrote). Each build adapter carries its own
 * authoring module (`build.module`) and resolves its paths (`build.entry`,
 * etc.) relative to it — the CLI does no path resolution of its own here.
 */
import type { BuildAdapter, Graph, GraphNode, ServiceNode } from '@makerkit/core';
import { CliError } from './cli-error.ts';
import { importFromEntry } from './resolve-from-entry.ts';
import { INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS } from './wrapper-inline.ts';

/** kind → the pack whose `/assemble` entry builds it (mirrors the pack's light/`/target` split). */
const ASSEMBLER_PACK_BY_KIND: Record<string, string> = {
  node: '@makerkit/node',
  nextjs: '@makerkit/nextjs',
};

export interface Bundle {
  readonly dir: string;
  readonly entry: string;
}

export interface AssembledServices {
  /** Set when the root is a lone service. */
  readonly bundle?: Bundle;
  /** Set when the root is a hex — keyed by each service's provision id. */
  readonly bundles?: Record<string, Bundle>;
}

export interface AssemblerInput {
  readonly build: BuildAdapter;
  readonly wrapperNoExternal: readonly RegExp[];
}

/** Extracts and validates a pack's `/assemble` module's `assemble` export — mirrors infer-target.ts's extractFromEnv. */
// biome-ignore lint/complexity/noBannedTypes: `mod` is an unknown dynamic-import result; the runtime `typeof assemble === 'function'` check right below is the actual guard, and the caller invokes it with its own typed AssemblerInput/Bundle.
function extractAssemble(pack: string, specifier: string, mod: unknown): Function {
  const assemble =
    typeof mod === 'object' && mod !== null && 'assemble' in mod ? mod.assemble : undefined;
  if (typeof assemble !== 'function') {
    throw new CliError(
      `Pack "${pack}" has no assemble() export at "${specifier}" — a build adapter pack must ` +
        'export an assemble(input): Promise<Bundle> function from its /assemble entry.',
    );
  }
  return assemble;
}

/** Runs the pack's `/assemble` export against `input` — the seam tests substitute to avoid a real build. */
export type RunAssembler = (pack: string, input: AssemblerInput) => Promise<Bundle>;

/** `entryPath` anchors resolution of each pack's `/assemble` entry (see resolve-from-entry.ts). */
async function runAssemblerFromEntry(
  entryPath: string,
  pack: string,
  input: AssemblerInput,
): Promise<Bundle> {
  const specifier = `${pack}/assemble`;
  const mod = await importFromEntry(entryPath, pack, 'assemble');
  const assemble = extractAssemble(pack, specifier, mod);
  return assemble(input);
}

function assemblerPackFor(node: ServiceNode): string {
  const pack = ASSEMBLER_PACK_BY_KIND[node.build.kind];
  if (pack === undefined) {
    throw new CliError(
      `Service "${node.name}" declares build kind "${node.build.kind}", which has no assembler ` +
        `(known kinds: ${Object.keys(ASSEMBLER_PACK_BY_KIND).sort().join(', ')}).`,
    );
  }
  return pack;
}

async function assembleOne(node: ServiceNode, run: RunAssembler): Promise<Bundle> {
  const pack = assemblerPackFor(node);

  return run(pack, {
    build: node.build,
    wrapperNoExternal: INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS,
  });
}

export async function assembleServices(
  graph: Graph,
  isHexRoot: boolean,
  entryPath: string,
  run: RunAssembler = (pack, input) => runAssemblerFromEntry(entryPath, pack, input),
): Promise<AssembledServices> {
  const serviceNodes = graph.nodes.filter(
    (n): n is GraphNode & { node: ServiceNode } => n.node.kind === 'service',
  );

  if (!isHexRoot) {
    const [only] = serviceNodes;
    if (only === undefined) {
      throw new CliError('The loaded graph has no service to assemble.');
    }
    return { bundle: await assembleOne(only.node, run) };
  }

  const bundles: Record<string, Bundle> = {};
  for (const { id, node } of serviceNodes) {
    bundles[id] = await assembleOne(node, run);
  }
  return { bundles };
}
