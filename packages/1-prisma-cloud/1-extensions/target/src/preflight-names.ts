/**
 * The platform env-var NAMES deploy preflight and dev preflight must both
 * check — extracted so the two walks (`runPreflight`, `runDevPreflight`)
 * cannot drift (local-dev spec § 5). Deploy checks secrets and env-sourced
 * params identically (one platform-existence check per name); dev applies a
 * DIFFERENT policy to each (a placeholder for a missing secret, a hard error
 * for a missing env-sourced param), so the two lists stay separate here
 * rather than merged into one.
 */

import type { Graph } from '@internal/core';
import { paramManifest, provisionManifest } from '@internal/core';
import { isEnvParamSource, paramName } from './param.ts';
import { secretName } from './secret.ts';

export interface PreflightName {
  readonly name: string;
  readonly serviceAddress: string;
}

export interface PreflightNames {
  /** Every secret slot's bound platform var name, deduped by name (first service wins the reported address). */
  readonly secrets: readonly PreflightName[];
  /** Every env-sourced param binding's platform var name (envParam-bound only — a literal-bound param never touches the platform), deduped the same way. */
  readonly envParams: readonly PreflightName[];
}

function dedupedNames(entries: Iterable<PreflightName>): readonly PreflightName[] {
  const byName = new Map<string, PreflightName>();
  for (const entry of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return [...byName.values()];
}

/** Walks `graph.secrets`/`graph.params` exactly as `runPreflight` did before this extraction. */
export function collectPreflightNames(graph: Graph): PreflightNames {
  const secrets = dedupedNames(
    provisionManifest(graph).map((binding) => ({
      name: secretName(binding),
      serviceAddress: binding.serviceAddress,
    })),
  );
  const envParams = dedupedNames(
    paramManifest(graph)
      .filter((binding) => isEnvParamSource(binding.binding))
      .map((binding) => ({ name: paramName(binding), serviceAddress: binding.serviceAddress })),
  );
  return { secrets, envParams };
}
