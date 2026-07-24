/**
 * The platform env-var NAMES deploy preflight and dev preflight must both
 * check — extracted so the two walks (`runPreflight`, `runDevPreflight`)
 * cannot drift (local-dev spec § 5). Deploy checks secrets and env-sourced
 * params identically (one platform-existence check per name); dev applies a
 * DIFFERENT policy to each (a placeholder for a missing secret, a hard error
 * for a missing env-sourced param), so the two lists stay separate here
 * rather than merged into one.
 *
 * Secrets are the `envSecret` leaves of every service's input binding
 * (ADR-0042); env-sourced params are the `envParam`-bound reserved params.
 */

import type { Graph } from '@internal/core';
import { inputManifest, isSecretSource, paramManifest } from '@internal/core';
import { isEnvParamSource, paramName } from './param.ts';
import { secretName } from './secret.ts';

export interface PreflightName {
  readonly name: string;
  readonly serviceAddress: string;
}

export interface PreflightNames {
  /** Every input-binding secret leaf's bound platform var name, deduped by name (first service wins the reported address). */
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

/** Every `envSecret` leaf of one input binding: its platform name, found by the same dumb recursive descent the serializer uses (ADR-0042). */
function collectSecretLeafNames(binding: unknown, serviceAddress: string, out: string[]): void {
  if (isSecretSource(binding)) {
    out.push(secretName(binding, `an input-binding secret leaf of service "${serviceAddress}"`));
    return;
  }
  if (typeof binding !== 'object' || binding === null) return;
  const members = Array.isArray(binding) ? binding : Object.values(binding);
  for (const member of members) collectSecretLeafNames(member, serviceAddress, out);
}

/** Walks each service's input binding for `envSecret` leaves, and `graph.params` for env-sourced params (ADR-0042). */
export function collectPreflightNames(graph: Graph): PreflightNames {
  const secretEntries: PreflightName[] = [];
  for (const { serviceAddress, binding } of inputManifest(graph)) {
    const leafNames: string[] = [];
    collectSecretLeafNames(binding, serviceAddress, leafNames);
    for (const name of leafNames) secretEntries.push({ name, serviceAddress });
  }
  const envParams = dedupedNames(
    paramManifest(graph)
      .filter((binding) => isEnvParamSource(binding.binding))
      .map((binding) => ({ name: paramName(binding), serviceAddress: binding.serviceAddress })),
  );
  return { secrets: dedupedNames(secretEntries), envParams };
}
