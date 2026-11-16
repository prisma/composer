import { type Graph, GraphCheckError } from '@internal/core';
import { quotedList } from '@internal/foundation/errors';
import { type PlatformVariableNode, platformVariableNodes } from './platform-variable.ts';

function secrecyText(nodes: readonly PlatformVariableNode[]): string {
  const plain = nodes.filter((node) => !node.secret).map((node) => node.address);
  const secret = nodes.filter((node) => node.secret).map((node) => node.address);
  if (plain.length === 0 || secret.length === 0) return '';
  const plainText = `${quotedList(plain)} ${plain.length === 1 ? 'is' : 'are'} plain`;
  const secretText = `${quotedList(secret)} ${secret.length === 1 ? 'is a secret' : 'are secrets'}`;
  return nodes[0]?.secret === true
    ? ` ${secretText} and ${plainText}.`
    : ` ${plainText} and ${secretText}.`;
}

function checkOneNodePerName(nodes: readonly PlatformVariableNode[]): void {
  const byName = new Map<string, PlatformVariableNode[]>();
  for (const node of nodes) {
    const declared = byName.get(node.name);
    if (declared === undefined) byName.set(node.name, [node]);
    else declared.push(node);
  }
  for (const [name, declared] of byName) {
    if (declared.length < 2) continue;
    const times = declared.length === 2 ? 'twice' : `${declared.length} times`;
    throw new GraphCheckError(
      `The platform variable "${name}" is declared ${times} in the app root, by ${quotedList(declared.map((node) => node.address))}. Declare each platform variable once and pass its value to every module that needs it.${secrecyText(declared)}`,
    );
  }
}

function checkNodeAgainstRootInput(graph: Graph, nodes: readonly PlatformVariableNode[]): void {
  const rootFields = new Set(graph.appConfigurationRead.rootInput.map((field) => field.path[0]));
  for (const node of nodes) {
    if (node.secret || !rootFields.has(node.name)) continue;
    throw new GraphCheckError(
      `"${node.name}" is used two ways: as the platform variable "${node.address}", which services read at boot, and as input.${node.name} of root module "${graph.root.id}", which the deploy reads. A name has one meaning in an app. Use one of them, or give the other a different name.`,
    );
  }
}

function checkWholeInputReads(graph: Graph, nodes: readonly PlatformVariableNode[]): void {
  const byAddress = new Map(nodes.map((node) => [node.address, node]));
  for (const read of graph.valueReads) {
    if (read.site.kind !== 'serviceInput' || read.site.path !== '') continue;
    const node = byAddress.get(read.resource);
    if (node === undefined) continue;
    throw new GraphCheckError(
      `The platform variable "${node.name}" is bound as the whole input of service "${read.reader}". Bind it to one field of the input instead.`,
    );
  }
}

export function checkGraph(graph: Graph): void {
  const nodes = platformVariableNodes(graph);
  checkOneNodePerName(nodes);
  checkNodeAgainstRootInput(graph, nodes);
  checkWholeInputReads(graph, nodes);
}
