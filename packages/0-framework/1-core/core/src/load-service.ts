import {
  type BoundaryPort,
  type Edge,
  type Graph,
  type GraphNode,
  LoadError,
  type NodeId,
} from './graph-types.ts';
import { isNode, type ModuleNode, type ServiceNode } from './node.ts';
import { topoSort } from './toposort.ts';

/**
 * The declared boundary ports of a module or service node at `id`: dep slots
 * as `in` ports (contractKind = the slot's `type`), exposed contracts as
 * `out` ports (contractKind = the contract's `kind`). A resource's one
 * `$out` port is recorded at its provision site instead (load-module.ts).
 */
export function boundaryPortsOf(id: NodeId, node: ModuleNode | ServiceNode): BoundaryPort[] {
  const ports: BoundaryPort[] = [];
  const slots: Record<string, unknown> = node.kind === 'module' ? node.deps : node.inputs;
  for (const [name, slot] of Object.entries(slots)) {
    const type =
      typeof slot === 'object' && slot !== null && 'type' in slot && typeof slot.type === 'string'
        ? slot.type
        : undefined;
    ports.push({ node: id, direction: 'in', name, contractKind: type });
  }
  for (const [name, contract] of Object.entries(node.expose ?? {})) {
    const kind =
      typeof contract === 'object' &&
      contract !== null &&
      'kind' in contract &&
      typeof contract.kind === 'string'
        ? contract.kind
        : undefined;
    ports.push({ node: id, direction: 'out', name, contractKind: kind });
  }
  return ports;
}

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
    nodes.push({ id, parent: serviceId, node: value });
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
  // A lone service has no enclosing scope to bind its input — nothing
  // resolves or serializes the input document, so it would fail opaquely at
  // boot. Reject it at Load, the same as an unwired dependency above.
  if (root.inputSchema !== undefined) {
    throw new LoadError(
      `Service "${rootId}" declares an input schema but is being loaded directly — a lone service ` +
        'has no enclosing scope to bind its input. Compose it inside a module whose provision() ' +
        'call binds `input: { … }` (ADR-0042).',
    );
  }
  const rootGraphNode: GraphNode = { id: rootId, parent: undefined, node: root };
  const { nodes, edges } = serviceInputs(root, rootId);
  return {
    root: rootGraphNode,
    nodes: [...topoSort(nodes, edges), rootGraphNode],
    edges,
    ports: boundaryPortsOf(rootId, root),
    authoredEdges: [],
    inputBindings: [],
    params: [],
  };
}
