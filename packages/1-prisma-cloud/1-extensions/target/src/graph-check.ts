import { type Graph, isParamSource, isSecretSource } from '@internal/core';
import { isEnvParamSource } from './param.ts';

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

/** Refuses a name that `envParam()` and a field of the root's input both use. */
export function checkGraph(graph: Graph): void {
  const rootFields = new Map(
    graph.appConfigurationRead.rootInput.map((field) => [field.path[0], field]),
  );
  for (const use of envParamUses(graph)) {
    const field = rootFields.get(use.name);
    if (field === undefined) continue;
    throw new Error(
      `${use.where} and input.${field.path.join('.')} of root module "${graph.root.id}" both use the name "${use.name}". A name has one meaning in an app: read "${use.name}" either with envParam() or as a field of the root's input, not both, or give one of them a different name.`,
    );
  }
}
