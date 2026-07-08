import {
  type ConnectionEnd,
  type HexBuilder,
  type HexNode,
  isNode,
  type ProvisionedRef,
  type ResourceNode,
  type ServiceNode,
} from './node.ts';

/** Path-derived: root "hello", its input "hello.db". */
export type NodeId = string;

export interface GraphNode {
  readonly id: NodeId;
  readonly node: ServiceNode | ResourceNode | ConnectionEnd | HexNode;
}

/**
 * `input`: a service consumes a declared dependency (resource or connection
 * end) — from the input node to the service. `connection`: a service calls a
 * service — from the producer service to the consumer service, labeled with
 * the consumer's input name (from the hex wiring).
 */
export interface Edge {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly input: string;
  readonly kind: 'input' | 'connection';
}

export interface Graph {
  readonly root: GraphNode;
  /** Root + one per input, topo-ordered (deps first). */
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly Edge[];
}

/** Thrown by Load when the graph is malformed. */
export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadError';
  }
}

/**
 * Builds the in-memory graph. For a service root it walks `root.inputs`,
 * assigns ids, builds `input` edges. For a hex root it EXECUTES the body (the
 * body is wiring, not user code — running it at Load is the designed
 * exception to imports-run-nothing) with a collector HexBuilder, producing
 * the owned services and one `connection` edge per wired ConnectionEnd input.
 *
 * Validation: every node branded with a non-empty type; every ConnectionEnd
 * input of a provisioned service wired to a provisioned producer (dangling =
 * LoadError); the connection edges form a DAG (a cycle is a LoadError with
 * the cycle named). A lone service Loaded outside any hex may have unwired
 * ConnectionEnds — connectedness is a topology-level check; booting it
 * unwired still fails loudly through the ordinary missing-config path.
 * Executes nothing of the user's.
 */
export function Load(root: ServiceNode | HexNode, opts?: { id?: NodeId }): Graph {
  // Brand-check the untrusted root once (a user default-export could be junk
  // TypeScript believes is a node), then route by its discriminant.
  if (!isNode(root)) {
    throw new LoadError(
      'Load expects a branded service or hex node (construct it with the service()/hex() factories).',
    );
  }
  if (root.kind === 'hex') return loadHex(root, opts);
  if (root.kind === 'service') return loadService(root, opts?.id ?? 'root');
  throw new LoadError('Load expects a service or hex root (received another node kind).');
}

function serviceInputs(
  service: ServiceNode,
  serviceId: NodeId,
): { nodes: GraphNode[]; edges: Edge[] } {
  if (typeof service.inputs !== 'object' || service.inputs === null) {
    throw new LoadError(`Service "${serviceId}" has no inputs map.`);
  }
  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  for (const [input, value] of Object.entries(service.inputs)) {
    if (!isNode(value) || (value.kind !== 'resource' && value.kind !== 'connection')) {
      throw new LoadError(
        `Input "${input}" of "${serviceId}" is not a branded resource or connection end ` +
          '(construct it with the resource()/connectionEnd() factories).',
      );
    }
    if (value.type.length === 0) {
      throw new LoadError(`Input "${input}" of "${serviceId}" has an empty node type.`);
    }
    const id = `${serviceId}.${input}`;
    nodes.push({ id, node: value as ResourceNode | ConnectionEnd });
    edges.push({ from: id, to: serviceId, input, kind: 'input' });
  }
  return { nodes, edges };
}

function loadService(root: ServiceNode, rootId: NodeId): Graph {
  const rootGraphNode: GraphNode = { id: rootId, node: root };
  const { nodes, edges } = serviceInputs(root, rootId);
  return {
    root: rootGraphNode,
    nodes: [...nodes, rootGraphNode],
    edges,
  };
}

interface Provisioned {
  readonly id: string;
  readonly service: ServiceNode;
  readonly wiring: Record<string, ProvisionedRef>;
}

function loadHex(root: HexNode, opts?: { id?: NodeId }): Graph {
  const rootId = opts?.id ?? root.name;
  const provisioned: Provisioned[] = [];
  const ids = new Set<string>();

  const builder: HexBuilder = {
    provision(id, service, wiring) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new LoadError(`provision() requires a non-empty id (hex "${root.name}").`);
      }
      if (ids.has(id)) {
        throw new LoadError(`Duplicate provision id "${id}" in hex "${root.name}".`);
      }
      if (!isNode(service) || service.kind !== 'service') {
        throw new LoadError(
          `provision("${id}") expects a branded service node (construct it with the service() factory).`,
        );
      }
      ids.add(id);
      provisioned.push({ id, service, wiring: { ...(wiring ?? {}) } });
      return { id };
    },
  };

  root.body(builder);

  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];

  for (const { id, service, wiring } of provisioned) {
    const inputs = serviceInputs(service, id);
    nodes.push(...inputs.nodes, { id, node: service });
    edges.push(...inputs.edges);

    // Wiring: each entry names a ConnectionEnd input and points it at a
    // provisioned producer — one connection edge per wired input.
    for (const [input, ref] of Object.entries(wiring)) {
      const declared = service.inputs[input];
      if (declared === undefined || !isNode(declared) || declared.kind !== 'connection') {
        throw new LoadError(
          `Wiring for "${id}" names "${input}", which is not a ConnectionEnd input of that service.`,
        );
      }
      if (typeof ref?.id !== 'string' || !ids.has(ref.id)) {
        throw new LoadError(
          `Wiring for "${id}.${input}" references "${String(ref?.id)}", which is not a provisioned service in hex "${root.name}".`,
        );
      }
      edges.push({ from: ref.id, to: id, input, kind: 'connection' });
    }

    // Dangling check: every ConnectionEnd input must be wired.
    for (const [input, value] of Object.entries(service.inputs)) {
      if (isNode(value) && value.kind === 'connection' && wiring[input] === undefined) {
        throw new LoadError(
          `ConnectionEnd input "${input}" of provisioned service "${id}" is not wired to a producer ` +
            `(hex "${root.name}").`,
        );
      }
    }
  }

  assertConnectionDag(edges);

  const rootGraphNode: GraphNode = { id: rootId, node: root };
  return {
    root: rootGraphNode,
    nodes: [...nodes, rootGraphNode],
    edges,
  };
}

/** The connection edges must form a DAG — a cycle means neither service can deploy first. */
function assertConnectionDag(edges: readonly Edge[]): void {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'connection') continue;
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      throw new LoadError(`Connection cycle: ${cycle.join(' → ')} — no deploy order exists.`);
    }
    visiting.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    stack.pop();
    visiting.delete(id);
    done.add(id);
  };

  for (const id of adjacency.keys()) visit(id);
}
