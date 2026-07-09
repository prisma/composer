/**
 * Pipeline step 3 (deploy-cli.md § The pipeline, ADR-0003): every node
 * carries the package name of the pack that authored it. Collect that set
 * over the loaded graph — exactly one must appear — then dynamically import
 * that pack's `/target` entry and call its `fromEnv()` export.
 */
import type { Graph } from '@makerkit/core';
import { assertDefined } from '@makerkit/core/assertions';
import type { Target } from '@makerkit/core/deploy';
import { CliError } from './cli-error.ts';
import { importFromEntry } from './resolve-from-entry.ts';

export function collectPacks(graph: Graph): string[] {
  const packs = new Set<string>();
  for (const { node } of graph.nodes) {
    if (node.kind === 'service' || node.kind === 'resource') packs.add(node.pack);
  }
  return [...packs].sort();
}

/** The one pack name to infer the target from, or throws naming the conflict (ADR-0003). */
export function resolveSinglePack(packs: readonly string[]): string {
  if (packs.length === 0) {
    throw new CliError('The loaded graph carries no pack — nothing to infer a deploy target from.');
  }
  if (packs.length > 1) {
    throw new CliError(
      `The loaded graph mixes more than one pack (${packs.join(', ')}) — one target per ` +
        'application (ADR-0003). Split the mixed services into separate deploys.',
    );
  }
  const pack = packs[0];
  assertDefined(pack, 'unreachable: packs.length === 1');
  return pack;
}

/** Extracts and validates a pack's `/target` module's `fromEnv` export — split out from `inferTarget` so the "missing export" error is testable without a real dynamic import. */
// biome-ignore lint/complexity/noBannedTypes: `mod` is an unknown dynamic-import result; TS's own `typeof fromEnv === 'function'` narrowing (the actual runtime check, right below) produces exactly `Function` and no more specific type — the caller invokes it and lets the call's result flow as `unknown`/`any` into a typed `Target`.
export function extractFromEnv(pack: string, specifier: string, mod: unknown): Function {
  const fromEnv =
    typeof mod === 'object' && mod !== null && 'fromEnv' in mod ? mod.fromEnv : undefined;
  if (typeof fromEnv !== 'function') {
    throw new CliError(
      `Pack "${pack}" has no fromEnv() export at "${specifier}" — a deployable pack must export ` +
        'a fromEnv(): Target function from its /target entry.',
    );
  }
  return fromEnv;
}

export interface InferredTarget {
  /** The pack's package name, e.g. "@makerkit/prisma-cloud" — used to import its `/target` entry. */
  readonly pack: string;
  readonly target: Target;
}

/** `entryPath` anchors resolution of the pack's `/target` entry (see resolve-from-entry.ts). */
export async function inferTarget(graph: Graph, entryPath: string): Promise<InferredTarget> {
  const pack = resolveSinglePack(collectPacks(graph));
  const mod = await importFromEntry(entryPath, pack, 'target');
  const fromEnv = extractFromEnv(pack, `${pack}/target`, mod);
  return { pack, target: fromEnv() };
}
