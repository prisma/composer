import { type Edge, type Graph, type GraphNode, LoadError, type NodeId } from './graph-types.ts';
import { isNode, type ServiceNode } from './node.ts';
import { topoSort } from './toposort.ts';

export function serviceInputs(
  service: ServiceNode,
  serviceId: NodeId,
): { nodes: GraphNode[]; edges: Edge[] } {
  if (typeof service.inputs !== 'object' || service.inputs === null) {
    throw new LoadError(`Service "${serviceId}" has no inputs map.`);
  }
  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  for (const [input, value] of Object.entries(service.inputs)) {
    // `inputs` is untrusted at runtime (a user module could carry junk the
    // types don't see), so the kind is re-checked as a plain string.
    const kind: string | undefined = isNode(value) ? value.kind : undefined;
    if (kind === 'resource') {
      throw new LoadError(
        `Input "${input}" of "${serviceId}" is a resource node — a resource is provisioned by ` +
          'the composing module, never created for a service that mentions it. Declare the input ' +
          "as a dependency (the pack's dependency factory) and wire the module-provisioned " +
          "resource's ref into it.",
      );
    }
    if (kind !== 'dependency') {
      throw new LoadError(
        `Input "${input}" of "${serviceId}" is not a branded dependency end ` +
          '(construct it with the dependency() factory).',
      );
    }
    if (value.type.length === 0) {
      throw new LoadError(`Input "${input}" of "${serviceId}" has an empty node type.`);
    }
    const id = `${serviceId}.${input}`;
    nodes.push({ id, node: value });
    edges.push({ from: id, to: serviceId, input, kind: 'input' });
  }
  return { nodes, edges };
}

export function loadService(root: ServiceNode, rootId: NodeId): Graph {
  for (const [input, value] of Object.entries(root.inputs)) {
    if (isNode(value) && value.kind === 'dependency') {
      throw new LoadError(
        `Service "${rootId}" has an unwired dependency input "${input}" — this service is composed ` +
          `by a module; deploy the module instead of loading "${rootId}" directly.`,
      );
    }
  }
  const rootGraphNode: GraphNode = { id: rootId, node: root };
  const { nodes, edges } = serviceInputs(root, rootId);
  return {
    root: rootGraphNode,
    nodes: [...topoSort(nodes, edges), rootGraphNode],
    edges,
  };
}
