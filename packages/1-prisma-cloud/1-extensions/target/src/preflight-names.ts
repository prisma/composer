import type { Graph } from '@internal/core';
import { isParamSource, isSecretSource } from '@internal/core';
import { isGeneratedParamSource, isOriginParamSource } from './param.ts';
import { bindingPlace, platformVariableName, platformVariableNodes } from './platform-variable.ts';

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
