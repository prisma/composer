import { blindCast } from './casts.ts';
import {
  type DependencyEnd,
  type HexBuilder,
  type HexNode,
  isNode,
  type ProvisionedRef,
  type ResourceNode,
  type ServiceNode,
} from './node.ts';

/** Path-derived: root "shop", a provision "auth", its input "auth.db". */
export type NodeId = string;

export interface GraphNode {
  readonly id: NodeId;
  readonly node: ServiceNode | ResourceNode | DependencyEnd | HexNode;
}

/**
 * `input`: a service consumes its own declared dependency slot — from the
 * slot node to the service. `dependency`: a service consumes a provisioned
 * producer (a service or a resource — the one wiring mechanism) — from the
 * producer to the consumer, labeled with the consumer's input name (from the
 * hex wiring).
 */
export interface Edge {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly input: string;
  readonly kind: 'input' | 'dependency';
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
 * the owned resources and services and one `dependency` edge per wired slot.
 *
 * Validation: every node branded with a non-empty type; every dependency slot
 * of a provisioned service wired to a provisioned producer (dangling =
 * LoadError); a wired ref whose slot declares a required contract must
 * satisfy() it (LoadError on mismatch — TypeScript already rejects it at the
 * wiring site, so reaching here means a cast bypassed it); the dependency
 * edges form a DAG (a cycle is a LoadError with the cycle named). A service
 * Loaded directly as the root (not via a hex) may not carry any dependency
 * slot — nothing at the root wires or provisions for it — so that is a
 * LoadError naming the input and pointing at the composing hex instead
 * (ADR-0003). Executes nothing of the user's.
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
    // `inputs` is untrusted at runtime (a user module could carry junk the
    // types don't see), so the kind is re-checked as a plain string.
    const kind: string | undefined = isNode(value) ? value.kind : undefined;
    if (kind === 'resource') {
      throw new LoadError(
        `Input "${input}" of "${serviceId}" is a resource node — a resource is provisioned by ` +
          'the composing hex, never created for a service that mentions it. Declare the input ' +
          "as a dependency (the pack's dependency factory) and wire the hex-provisioned " +
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

function loadService(root: ServiceNode, rootId: NodeId): Graph {
  for (const [input, value] of Object.entries(root.inputs)) {
    if (isNode(value) && value.kind === 'dependency') {
      throw new LoadError(
        `Service "${rootId}" has an unwired dependency input "${input}" — this service is composed ` +
          `by a hex; deploy the hex instead of loading "${rootId}" directly.`,
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

/**
 * Stable topological sort: every edge's `from` precedes its `to` in the
 * result. Ties (nodes with no ordering constraint between them) keep their
 * relative order from `nodes` — so a graph already authored producer-first
 * comes out byte-identical to its pre-sort layout; only a graph that
 * genuinely needs reordering (e.g. a hex wired via a forged ref pointing at a
 * not-yet-provisioned producer) actually moves. A Kahn's-algorithm variant
 * that always picks the ready node with the smallest original index. Edges
 * whose endpoint falls outside `nodes` (e.g. a service-root's input edges
 * targeting the root, which is appended separately) are ignored. Cycles
 * cannot reach here: `assertDependencyDag` already rejects them for
 * dependency edges, and input edges never cycle.
 */
function topoSort(nodes: readonly GraphNode[], edges: readonly Edge[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
  const indegree = new Map<NodeId, number>(nodes.map((n) => [n.id, 0]));
  const successors = new Map<NodeId, NodeId[]>();

  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const targets = successors.get(edge.from) ?? [];
    targets.push(edge.to);
    successors.set(edge.from, targets);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const ready = new Set(nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id));
  const order: NodeId[] = [];

  while (ready.size > 0) {
    let next: NodeId | undefined;
    let bestIndex = Number.POSITIVE_INFINITY;
    for (const id of ready) {
      const index = indexOf.get(id) ?? Number.POSITIVE_INFINITY;
      if (index < bestIndex) {
        bestIndex = index;
        next = id;
      }
    }
    if (next === undefined) break;
    ready.delete(next);
    order.push(next);
    for (const target of successors.get(next) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) ready.add(target);
    }
  }

  // Kahn's leaves cyclic nodes unprocessed rather than looping. A cycle can't
  // reach here (assertDependencyDag runs first; input edges never cycle), but
  // if that guard were ever bypassed, dropping nodes silently would be far
  // worse than failing — so assert completeness.
  if (order.length !== nodes.length) {
    throw new LoadError(
      `topological sort processed ${order.length} of ${nodes.length} nodes — ` +
        'the graph contains a cycle that slipped past the DAG validation.',
    );
  }

  return order.map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
}

interface Provisioned {
  readonly id: string;
  readonly node: ServiceNode | ResourceNode;
  readonly wiring: Record<string, unknown>;
}

/**
 * Builds the ref a provision() call hands back: the id (so a producer with no
 * exposed ports — or an untyped slot — can still be wired wholesale) plus one
 * ref-port per exposed contract, each the contract's own runtime value (so
 * its `satisfies()` still works) tagged with the provider's id.
 */
function refFor(id: string, service: ServiceNode): ProvisionedRef {
  const ports: Record<string, unknown> = {};
  for (const [port, contract] of Object.entries(service.expose ?? {})) {
    ports[port] = { ...contract, __providerId: id };
  }
  return blindCast<
    ProvisionedRef,
    'ref-ports are built from the service exposed contracts keyed by port name, matching ProvisionedRef mapped shape'
  >({ id, ...ports });
}

/**
 * The resource variant of refFor: a resource has exactly one port — the
 * contract it provides — flattened onto the ref itself, tagged with the
 * provider id. `id` is written last so a hostile contract value cannot
 * clobber it.
 */
function refForResource(id: string, resource: ResourceNode): ProvisionedRef {
  return blindCast<
    ProvisionedRef,
    'the ref is the provided contract value tagged with the provider id — the `{ id } & RefPort<C>` shape the resource provision() overload pins'
  >({ ...resource.provides, __providerId: id, id });
}

/** A wired value's producer id: a ref-port's `__providerId`, or a bare ref's `id`. */
function producerIdOf(ref: unknown): string | undefined {
  if (typeof ref !== 'object' || ref === null) return undefined;
  if ('__providerId' in ref && typeof ref.__providerId === 'string') return ref.__providerId;
  if ('id' in ref && typeof ref.id === 'string') return ref.id;
  return undefined;
}

function loadHex(root: HexNode, opts?: { id?: NodeId }): Graph {
  const rootId = opts?.id ?? root.name;
  const provisioned: Provisioned[] = [];
  const byId = new Map<string, ServiceNode | ResourceNode>();

  const provision = (
    id: string,
    node: ServiceNode | ResourceNode,
    wiring?: Record<string, unknown>,
  ): ProvisionedRef => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new LoadError(`provision() requires a non-empty id (hex "${root.name}").`);
    }
    // The id becomes the node's address segment: configKey joins it with "_"
    // (id "auth_db" + param "url" would collide with id "auth" + input "db" +
    // param "url" — both AUTH_DB_URL), and node ids join path segments with
    // "." — so neither may appear inside an id.
    if (id.includes('_') || id.includes('.')) {
      throw new LoadError(
        `provision() id "${id}" (hex "${root.name}") may not contain "_" or "." — ` +
          '"_" is the config-key separator and "." the node-id path separator; either ' +
          'inside an id collides with the joined form of other names.',
      );
    }
    if (byId.has(id)) {
      throw new LoadError(`Duplicate provision id "${id}" in hex "${root.name}".`);
    }
    // Brand-check on a widened alias: predicate-narrowing the declared union
    // drops the `any`-instantiated ResourceNode member (the same quirk
    // serviceInputs sidesteps by widening `kind` to a plain string).
    const untrusted: unknown = node;
    if (!isNode(untrusted) || (untrusted.kind !== 'service' && untrusted.kind !== 'resource')) {
      throw new LoadError(
        `provision("${id}") expects a branded service or resource node (construct it with ` +
          "the service()/resource() factories or a pack's own).",
      );
    }
    if (node.kind === 'resource') {
      if (wiring !== undefined) {
        throw new LoadError(
          `provision("${id}") received wiring for a resource — a resource has no inputs to wire.`,
        );
      }
      if (node.type.length === 0) {
        throw new LoadError(`provision("${id}") received a resource with an empty node type.`);
      }
      byId.set(id, node);
      provisioned.push({ id, node, wiring: {} });
      return refForResource(id, node);
    }
    byId.set(id, node);
    provisioned.push({ id, node, wiring: { ...(wiring ?? {}) } });
    return refFor(id, node);
  };

  const builder: HexBuilder = {
    provision: blindCast<
      HexBuilder['provision'],
      'single implementation behind the provision() overloads — returns the contract-carrying ref for a resource and a ProvisionedRef for a service, exactly what each overload pins, but an object property cannot carry an overloaded implementation signature'
    >(provision),
  };

  root.body(builder);

  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];

  for (const { id, node, wiring } of provisioned) {
    if (node.kind === 'resource') {
      nodes.push({ id, node });
      continue;
    }

    const inputs = serviceInputs(node, id);
    nodes.push(...inputs.nodes, { id, node });
    edges.push(...inputs.edges);

    // Wiring: each entry names a dependency slot and points it at a
    // provisioned producer — one dependency edge per wired input. No
    // producer-kind branching: the contract determines validity, whether the
    // producer is a service port or a resource.
    for (const [input, ref] of Object.entries(wiring)) {
      const declared: DependencyEnd | undefined = node.inputs[input];
      if (declared === undefined || !isNode(declared) || declared.kind !== 'dependency') {
        throw new LoadError(
          `Wiring for "${id}" names "${input}", which is not a dependency slot of that service.`,
        );
      }
      const producerId = producerIdOf(ref);
      const producer = producerId !== undefined ? byId.get(producerId) : undefined;
      if (producerId === undefined || producer === undefined) {
        throw new LoadError(
          `Wiring for "${id}.${input}" references "${String(producerId)}", which is not provisioned in hex "${root.name}".`,
        );
      }

      const required = declared.required;
      if (required !== undefined) {
        if (
          typeof ref !== 'object' ||
          ref === null ||
          !('satisfies' in ref) ||
          typeof ref.satisfies !== 'function' ||
          !ref.satisfies(required)
        ) {
          throw new LoadError(
            `Wiring for "${id}.${input}" does not satisfy its required contract.`,
          );
        }
      }

      edges.push({ from: producerId, to: id, input, kind: 'dependency' });
    }

    // Dangling check: every dependency slot must be wired. The kind is read
    // as a plain string — same untrusted-inputs treatment as serviceInputs.
    for (const [input, value] of Object.entries(node.inputs)) {
      if (!isNode(value) || wiring[input] !== undefined) continue;
      const kind: string = value.kind;
      if (kind === 'dependency') {
        throw new LoadError(
          `Dependency input "${input}" of provisioned service "${id}" is not wired to a producer ` +
            `(hex "${root.name}").`,
        );
      }
    }
  }

  assertDependencyDag(edges);

  const rootGraphNode: GraphNode = { id: rootId, node: root };
  return {
    root: rootGraphNode,
    nodes: [...topoSort(nodes, edges), rootGraphNode],
    edges,
  };
}

/**
 * The dependency edges must form a DAG — a cycle means neither producer can
 * deploy first. Resources take no wiring, so only service-to-service edges
 * can ever participate in a cycle; no special-casing needed.
 */
function assertDependencyDag(edges: readonly Edge[]): void {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'dependency') continue;
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
      throw new LoadError(`Dependency cycle: ${cycle.join(' → ')} — no deploy order exists.`);
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
