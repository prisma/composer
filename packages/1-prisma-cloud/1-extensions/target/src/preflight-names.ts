import type { Graph } from '@internal/core';
import { isSecretSource, paramManifest } from '@internal/core';
import {
  isEnvParamSource,
  isGeneratedParamSource,
  isOriginParamSource,
  paramName,
} from './param.ts';
import { isPlainVariableSource, platformVariableNodes } from './platform-variable.ts';
import { secretName } from './secret.ts';

export const envParamNotTextError = (name: string, address: string, kind: string): Error =>
  new Error(
    `The \`config\` adapters return ${kind} for "${name}", not text, so prisma dev cannot give service "${address}" the value envParam('${name}') reads. Make the adapter return a string.`,
  );

const composerWritesItsValue = (binding: unknown): boolean =>
  isGeneratedParamSource(binding) || isOriginParamSource(binding);

export interface VariableName {
  readonly name: string;
  readonly secret: boolean;
}

function collectVariableNames(
  binding: unknown,
  serviceAddress: string,
  out: Map<string, VariableName>,
): void {
  if (composerWritesItsValue(binding)) return;
  if (isSecretSource(binding)) {
    const name = secretName(binding, `a secret in the input of service "${serviceAddress}"`);
    out.set(name, { name, secret: true });
    return;
  }
  if (isPlainVariableSource(binding)) {
    const { name } = binding.payload;
    out.set(name, { name, secret: false });
    return;
  }
  if (typeof binding !== 'object' || binding === null) return;
  const members = Array.isArray(binding) ? binding : Object.values(binding);
  for (const member of members) collectVariableNames(member, serviceAddress, out);
}

export function inputVariableNames(
  binding: unknown,
  serviceAddress: string,
): readonly VariableName[] {
  const names = new Map<string, VariableName>();
  collectVariableNames(binding, serviceAddress, names);
  return [...names.values()];
}

export interface UnreadVariable {
  readonly name: string;
  readonly node: string;
}

export function unreadVariables(graph: Graph): readonly UnreadVariable[] {
  const read = new Set(graph.valueReads.map((entry) => entry.resource));
  return platformVariableNodes(graph)
    .filter((node) => !read.has(node.address))
    .map((node) => ({ name: node.name, node: node.address }));
}

export interface EnvParamBinding {
  readonly name: string;
  readonly serviceAddress: string;
  readonly param: string;
}

export function perKeyVariableBindings(graph: Graph): readonly EnvParamBinding[] {
  return paramManifest(graph)
    .filter((binding) => isPlainVariableSource(binding.binding))
    .map((binding) => ({
      name: paramName(binding),
      serviceAddress: binding.serviceAddress,
      param: binding.slot,
    }));
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
