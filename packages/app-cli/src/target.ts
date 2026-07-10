/**
 * The one deploy target of an application (ADR-0003: one target per
 * application). Pack-authored service and resource nodes carry `targetModule`
 * — the specifier of their pack's `/target` entry. `targetNodeOf` reads it
 * straight off the graph and hands back a node that carries it; the deploy
 * tooling then asks THAT node to load its own target (`node.loadTarget()`,
 * ADR-0017). The load must go through the node, not a specifier alone: the node
 * was built by the app's packs, so its resolver sits next to them — a load
 * anchored anywhere else (e.g. the CLI's own copy of core) would not find the
 * pack. `extractFromEnv` validates the loaded module's `fromEnv(): Target`.
 */
import type { Graph, ResourceNode, ServiceNode } from '@prisma/app';
import type { Target } from '@prisma/app/deploy';
import { CliError } from './cli-error.ts';

/**
 * A node carrying the application's single `targetModule`, plus that specifier.
 * Two nodes carrying different targets is a mixed-target application: rejected
 * here rather than downstream, because two packs can share a node `type` and a
 * silently-picked wrong target would then lower against the wrong tables.
 */
export function targetNodeOf(graph: Graph): {
  node: ServiceNode | ResourceNode;
  targetModule: string;
} {
  let found: { node: ServiceNode | ResourceNode; targetModule: string } | undefined;
  for (const { node } of graph.nodes) {
    if (node.kind !== 'service' && node.kind !== 'resource') continue;
    const targetModule = node.targetModule;
    if (targetModule === undefined || targetModule.length === 0) continue;
    if (found === undefined) {
      found = { node, targetModule };
    } else if (found.targetModule !== targetModule) {
      throw new CliError(
        `This application mixes more than one deploy target (${found.targetModule}, ${targetModule}) ` +
          '— one target per application (ADR-0003). Split the mixed services into separate deploys.',
      );
    }
  }
  if (found === undefined) {
    throw new CliError('The application carries no targetModule — nothing to deploy against.');
  }
  return found;
}

/**
 * Extracts and validates a target module's `fromEnv` export — split out so the
 * "missing export" error is testable without a real dynamic import. The
 * contract: a deployable target module must export a `fromEnv(): Target`
 * function.
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

export type { Target };
