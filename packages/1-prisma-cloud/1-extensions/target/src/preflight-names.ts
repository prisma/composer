import type { Graph } from '@internal/core';
import { isParamSource, isSecretSource, paramManifest } from '@internal/core';
import { isGeneratedParamSource, isOriginParamSource, paramName } from './param.ts';
import {
  bindingPlace,
  isPlainVariableSource,
  platformVariableName,
  platformVariableNodes,
} from './platform-variable.ts';

const composerWritesItsValue = (binding: unknown): boolean =>
  isGeneratedParamSource(binding) || isOriginParamSource(binding);

export interface VariableName {
  readonly name: string;
  readonly secret: boolean;
}

function collectVariableNames(
  binding: unknown,
  serviceAddress: string,
  path: string,
  out: Map<string, VariableName>,
): void {
  if (composerWritesItsValue(binding)) return;
  if (isSecretSource(binding) || isParamSource(binding)) {
    const name = platformVariableName(binding, bindingPlace(path, serviceAddress));
    out.set(name, { name, secret: isSecretSource(binding) });
    return;
  }
  if (typeof binding !== 'object' || binding === null) return;
  for (const [key, member] of Object.entries(binding)) {
    collectVariableNames(member, serviceAddress, path === '' ? key : `${path}.${key}`, out);
  }
}

export function inputVariableNames(
  binding: unknown,
  serviceAddress: string,
): readonly VariableName[] {
  const names = new Map<string, VariableName>();
  collectVariableNames(binding, serviceAddress, '', names);
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

export interface PerKeyVariableBinding {
  readonly name: string;
  readonly serviceAddress: string;
  readonly param: string;
}

export function perKeyVariableBindings(graph: Graph): readonly PerKeyVariableBinding[] {
  return paramManifest(graph)
    .filter((binding) => isPlainVariableSource(binding.binding))
    .map((binding) => ({
      name: paramName(binding),
      serviceAddress: binding.serviceAddress,
      param: binding.slot,
    }));
}
