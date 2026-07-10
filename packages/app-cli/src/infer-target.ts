/**
 * Pipeline step 3 (deploy-cli.md § The pipeline, ADR-0003): a pack-authored
 * service or resource node may carry `targetModule` — a full, author-written
 * specifier for its pack's `/target` entry (@prisma/app's node.ts).
 * Collect the distinct set over the loaded graph — exactly one must appear —
 * then let the carrying node load it itself (node-owned loading: the node's
 * own `loadTarget()` performs the dynamic import; this module never
 * constructs a specifier or resolves anything itself) and call its
 * `fromEnv()` export.
 */
import type { Graph, GraphNode, ResourceNode, ServiceNode } from '@prisma/app';
import { assertDefined } from '@prisma/app/assertions';
import type { Target } from '@prisma/app/deploy';
import { CliError } from './cli-error.ts';

/** Distinct, non-empty `targetModule` values carried by the graph's service and resource nodes. */
export function collectTargetModules(graph: Graph): string[] {
  const modules = new Set<string>();
  for (const { node } of graph.nodes) {
    if (
      (node.kind === 'service' || node.kind === 'resource') &&
      node.targetModule !== undefined &&
      node.targetModule.length > 0
    ) {
      modules.add(node.targetModule);
    }
  }
  return [...modules].sort();
}

/** The one targetModule to infer the target from, or throws naming the conflict (ADR-0003). */
export function resolveSingleTargetModule(targetModules: readonly string[]): string {
  if (targetModules.length === 0) {
    throw new CliError(
      'The loaded graph carries no targetModule — nothing to infer a deploy target from.',
    );
  }
  if (targetModules.length > 1) {
    throw new CliError(
      `The loaded graph mixes more than one deploy target (${targetModules.join(', ')}) — one ` +
        'target per application (ADR-0003). Split the mixed services into separate deploys.',
    );
  }
  const targetModule = targetModules[0];
  assertDefined(targetModule, 'unreachable: targetModules.length === 1');
  return targetModule;
}

/**
 * Extracts and validates a target module's `fromEnv` export — split out from
 * `inferTarget` so the "missing export" error is testable without a real
 * dynamic import. The contract: a deployable target module must export a
 * `fromEnv(): Target` function.
 */
// biome-ignore lint/complexity/noBannedTypes: `mod` is an unknown dynamic-import result; TS's own `typeof fromEnv === 'function'` narrowing (the actual runtime check, right below) produces exactly `Function` and no more specific type — the caller invokes it and lets the call's result flow as `unknown`/`any` into a typed `Target`.
export function extractFromEnv(specifier: string, mod: unknown): Function {
  const fromEnv =
    typeof mod === 'object' && mod !== null && 'fromEnv' in mod ? mod.fromEnv : undefined;
  if (typeof fromEnv !== 'function') {
    throw new CliError(
      `"${specifier}" has no fromEnv() export — the target module must export a ` +
        'fromEnv(): Target function.',
    );
  }
  return fromEnv;
}

export interface InferredTarget {
  /** The target module's specifier, e.g. "@prisma/app-cloud/target". */
  readonly targetModule: string;
  readonly target: Target;
}

export async function inferTarget(graph: Graph): Promise<InferredTarget> {
  const targetModule = resolveSingleTargetModule(collectTargetModules(graph));
  const carrier = graph.nodes.find(
    (n): n is GraphNode & { node: ServiceNode | ResourceNode } =>
      (n.node.kind === 'service' || n.node.kind === 'resource') &&
      n.node.targetModule === targetModule,
  );
  assertDefined(
    carrier,
    'unreachable: targetModule was just collected from a node in this same graph',
  );
  const mod = await carrier.node.loadTarget();
  const fromEnv = extractFromEnv(targetModule, mod);
  return { targetModule, target: fromEnv() };
}
