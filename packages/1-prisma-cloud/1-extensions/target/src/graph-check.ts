import { type Graph, GraphCheckError, isParamSource, isSecretSource } from '@internal/core';
import { isEnvParamSource } from './param.ts';
import { type PlatformVariableNode, platformVariableNodes } from './platform-variable.ts';

interface EnvParamUse {
  readonly name: string;
  readonly where: string;
}

function bindingUses(binding: unknown, serviceAddress: string, path: string, out: EnvParamUse[]) {
  if (isEnvParamSource(binding)) {
    const name = binding.payload.name;
    const field = path === '' ? '' : `, field "${path}"`;
    out.push({
      name,
      where: `envParam('${name}') in the input of service "${serviceAddress}"${field}`,
    });
    return;
  }
  if (isParamSource(binding) || isSecretSource(binding)) return;
  if (typeof binding !== 'object' || binding === null) return;
  for (const [key, member] of Object.entries(binding)) {
    bindingUses(member, serviceAddress, path === '' ? key : `${path}.${key}`, out);
  }
}

function envParamUses(graph: Graph): readonly EnvParamUse[] {
  const uses: EnvParamUse[] = [];
  for (const { serviceAddress, binding } of graph.inputBindings) {
    bindingUses(binding, serviceAddress, '', uses);
  }
  for (const { serviceAddress, slot, binding } of graph.params) {
    if (!isEnvParamSource(binding)) continue;
    const name = binding.payload.name;
    uses.push({
      name,
      where: `envParam('${name}') in param "${slot}" of service "${serviceAddress}"`,
    });
  }
  return uses;
}

export const quotedList = (addresses: readonly string[]): string => {
  const quoted = addresses.map((address) => `"${address}"`);
  const last = quoted.pop();
  return quoted.length === 0 ? `${last}` : `${quoted.join(', ')} and ${last}`;
};

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
  const rootFields = new Map(
    graph.appConfigurationRead.rootInput.map((field) => [field.path[0], field]),
  );
  for (const use of envParamUses(graph)) {
    const field = rootFields.get(use.name);
    if (field === undefined) continue;
    throw new GraphCheckError(
      `${use.where} and input.${field.path.join('.')} of root module "${graph.root.id}" both use the name "${use.name}". A name has one meaning in an app: read "${use.name}" either with envParam() or as a field of the root's input, not both, or give one of them a different name.`,
    );
  }
}
