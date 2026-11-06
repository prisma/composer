/**
 * The platform variable names the deploy preflight and the dev preflight both
 * walk: the `envSecret` leaves of a service's input binding (ADR-0042) and the
 * per-key params bound to `envParam()`.
 */

import type { Graph } from '@internal/core';
import { isSecretSource, paramManifest } from '@internal/core';
import {
  isEnvParamSource,
  isGeneratedParamSource,
  isOriginParamSource,
  paramName,
} from './param.ts';
import { secretName } from './secret.ts';

/** An env-sourced param's app configuration value that preflight cannot write to a platform variable. */
export const envParamNotTextError = (name: string, address: string, kind: string): Error =>
  new Error(
    `The \`config\` adapters return ${kind} for "${name}", not text, so preflight cannot set the platform variable envParam('${name}') of service "${address}" reads. Make the adapter return a string.`,
  );

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

/** A per-key param bound to `envParam()`: the platform variable it points at, and its service and param name. */
export interface EnvParamBinding {
  readonly name: string;
  readonly serviceAddress: string;
  readonly param: string;
}

/** Every per-key param bound to `envParam()`, one entry per param. */
export function envParamBindings(graph: Graph): readonly EnvParamBinding[] {
  return paramManifest(graph)
    .filter((binding) => isEnvParamSource(binding.binding))
    .map((binding) => ({
      name: paramName(binding),
      serviceAddress: binding.serviceAddress,
      param: binding.slot,
    }));
}
