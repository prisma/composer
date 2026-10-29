/**
 * The platform env-var NAMES deploy preflight and dev preflight must both
 * check — extracted so the two walks (`runPreflight`, `runDevPreflight`)
 * cannot drift (local-dev spec § 5). Deploy checks secrets and env-sourced
 * params identically (one platform-existence check per name); dev applies a
 * DIFFERENT policy to each (a missing secret is an error only when the
 * service's schema rejects its absence, a missing env-sourced param always
 * is), so the two lists stay separate here rather than merged into one.
 *
 * Secrets are the `envSecret` leaves of every service's input binding
 * (ADR-0042); env-sourced params are the `envParam`-bound reserved params.
 * Secrets also include every secret source the graph names elsewhere
 * (secretSourceManifest): one a resolve() lists but does not return, one in a
 * module's input that no service receives, and one a resolve() in a
 * resource's props lists.
 */

import type { Graph, SecretSourceUse } from '@internal/core';
import { inputManifest, isSecretSource, paramManifest, secretSourceManifest } from '@internal/core';
import {
  isEnvParamSource,
  isGeneratedParamSource,
  isOriginParamSource,
  paramName,
} from './param.ts';
import { secretName } from './secret.ts';

export interface PreflightName {
  readonly name: string;
  /** The node that uses the name: a service whose binding holds it, or, when no service receives it, the module whose input holds it or the resource whose props list it in a resolve(). */
  readonly address: string;
  readonly nodeKind: SecretSourceUse['nodeKind'];
}

export interface PreflightNames {
  /** Every secret source in a service's input binding or in `graph.secretSources`, deduped by name; the first entry wins the reported address. */
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
  // A generated leaf provisions its own platform var at deploy — nothing for an
  // operator to seed, nothing to check here. Skip it before the object descent
  // (it is a ParamSource object, so an unskipped walk would recurse pointlessly
  // into its payload).
  if (isGeneratedParamSource(binding) || isOriginParamSource(binding)) return;
  if (isSecretSource(binding)) {
    out.push(secretName(binding, `an input-binding secret leaf of service "${serviceAddress}"`));
    return;
  }
  if (typeof binding !== 'object' || binding === null) return;
  const members = Array.isArray(binding) ? binding : Object.values(binding);
  for (const member of members) collectSecretLeafNames(member, serviceAddress, out);
}

/** The distinct `envSecret` names one service's input binding points at. */
export function inputSecretNames(binding: unknown, serviceAddress: string): readonly string[] {
  const leafNames: string[] = [];
  collectSecretLeafNames(binding, serviceAddress, leafNames);
  return [...new Set(leafNames)];
}

/** Walks each service's input binding for `envSecret` leaves, then `graph.secretSources`, and `graph.params` for env-sourced params (ADR-0042). */
export function collectPreflightNames(graph: Graph): PreflightNames {
  const secretEntries: PreflightName[] = [];
  for (const { serviceAddress, binding } of inputManifest(graph)) {
    for (const name of inputSecretNames(binding, serviceAddress)) {
      secretEntries.push({ name, address: serviceAddress, nodeKind: 'service' });
    }
  }
  for (const use of secretSourceManifest(graph)) {
    secretEntries.push({
      name: secretName(use.source, `a secret source of ${use.nodeKind} "${use.address}"`),
      address: use.address,
      nodeKind: use.nodeKind,
    });
  }
  const envParams = dedupedNames(
    paramManifest(graph)
      .filter((binding) => isEnvParamSource(binding.binding))
      .map((binding) => ({
        name: paramName(binding),
        address: binding.serviceAddress,
        nodeKind: 'service' as const,
      })),
  );
  return { secrets: dedupedNames(secretEntries), envParams };
}
