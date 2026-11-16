import type { Graph } from '@internal/core';
import { isSecretSource, paramManifest } from '@internal/core';
import {
  isEnvParamSource,
  isGeneratedParamSource,
  isOriginParamSource,
  paramName,
} from './param.ts';
import { secretName } from './secret.ts';

export const envParamNotTextError = (name: string, address: string, kind: string): Error =>
  new Error(
    `The \`config\` adapters return ${kind} for "${name}", not text, so prisma dev cannot give service "${address}" the value envParam('${name}') reads. Make the adapter return a string.`,
  );

const composerWritesItsValue = (binding: unknown): boolean =>
  isGeneratedParamSource(binding) || isOriginParamSource(binding);

function collectSecretLeafNames(binding: unknown, serviceAddress: string, out: string[]): void {
  if (composerWritesItsValue(binding)) return;
  if (isSecretSource(binding)) {
    out.push(secretName(binding, `a secret in the input of service "${serviceAddress}"`));
    return;
  }
  if (typeof binding !== 'object' || binding === null) return;
  const members = Array.isArray(binding) ? binding : Object.values(binding);
  for (const member of members) collectSecretLeafNames(member, serviceAddress, out);
}

export function inputSecretNames(binding: unknown, serviceAddress: string): readonly string[] {
  const leafNames: string[] = [];
  collectSecretLeafNames(binding, serviceAddress, leafNames);
  return [...new Set(leafNames)];
}

export interface EnvParamBinding {
  readonly name: string;
  readonly serviceAddress: string;
  readonly param: string;
}

export function envParamBindings(graph: Graph): readonly EnvParamBinding[] {
  return paramManifest(graph)
    .filter((binding) => isEnvParamSource(binding.binding))
    .map((binding) => ({
      name: paramName(binding),
      serviceAddress: binding.serviceAddress,
      param: binding.slot,
    }));
}
