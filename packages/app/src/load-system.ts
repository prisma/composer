import { blindCast } from './casts.ts';
import { type Edge, type Graph, type GraphNode, LoadError, type NodeId } from './graph-types.ts';
import { serviceInputs } from './load-service.ts';
import {
  type DependencyEnd,
  type Deps,
  isNode,
  type ProvisionedRef,
  type ResourceNode,
  type ServiceNode,
  type SystemBuilder,
  type SystemContext,
  type SystemNode,
} from './node.ts';
import { topoSort } from './toposort.ts';

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

/**
 * Brands each `ctx.inputs` entry with the input key it stands for (see
 * flatten): diagnostic only — usage attribution relies on the per-key object
 * identity the branding copy creates, never on reading this back.
 */
const SYSTEM_INPUT_KEY = Symbol('prisma:system-input-key');

/** Whether `ref` carries a callable `satisfies` that accepts `required` truthily. */
function satisfiesRequired(ref: unknown, required: unknown): boolean {
  return (
    typeof ref === 'object' &&
    ref !== null &&
    'satisfies' in ref &&
    typeof ref.satisfies === 'function' &&
    ref.satisfies(required)
  );
}

/**
 * A `wiring` object recorded against the Deps of whatever it wired (a
 * service's `.inputs` or a system's `.deps` — the same shape either way),
 * checked once the whole graph is known (see `validateWiring`). Recorded
 * immediately at provision() time so the same call order that already gives
 * the graph its topological order also gives this list its natural order;
 * validated later so a wiring value may legitimately name a producer this
 * same scope (or an ancestor scope, or — forwarded — a descendant scope)
 * provisions, resolved against the one `byId` shared across the entire
 * recursive flatten.
 */
interface PendingWiring {
  readonly deps: Deps;
  readonly wiring: Record<string, unknown>;
  readonly targetId: string;
  readonly targetKind: 'service' | 'system';
  readonly enclosingSystemName: string;
}

/**
 * Checks one recorded `wiring` object against the Deps it was wired against:
 * every named input exists and is a dependency slot, every referenced
 * producer is a real (by-now-provisioned) address, and a wired ref whose
 * slot declares a required contract must satisfy() it — no producer-kind
 * branching, the contract alone determines validity, whether the producer is
 * a service port or a resource. Shared by both provisioned kinds so a
 * system-as-child gets exactly the checks a service gets, and run once per
 * entry against the one `byId` shared by the whole recursive flatten, so a
 * forwarded ref resolves through to its real producer address regardless of
 * which ancestor scope provisioned it.
 */
function validateWiring(
  pending: PendingWiring,
  byId: ReadonlyMap<string, ServiceNode | ResourceNode | SystemNode>,
): void {
  const { deps, wiring, targetId, targetKind, enclosingSystemName } = pending;

  for (const [input, ref] of Object.entries(wiring)) {
    // Cast to the slot's DEFAULT type arguments: the `any`-instantiated union
    // Deps carries trips a narrowing quirk (isNode's predicate drops
    // DependencyEnd<any, any> from the union entirely). The runtime check
    // below — the single `kind === 'dependency'` test — is unaffected by
    // what this cast claims.
    const declared = blindCast<
      DependencyEnd | undefined,
      "sidesteps the any-instantiated narrowing quirk; the runtime kind === 'dependency' check below is what actually validates it"
    >(deps[input]);
    if (declared === undefined || !isNode(declared) || declared.kind !== 'dependency') {
      throw new LoadError(
        `Wiring for "${targetId}" names "${input}", which is not a dependency slot of that ${targetKind}.`,
      );
    }

    const producerId = producerIdOf(ref);
    const producer = producerId !== undefined ? byId.get(producerId) : undefined;
    if (producerId === undefined || producer === undefined) {
      throw new LoadError(
        `Wiring for "${targetId}.${input}" references "${String(producerId)}", which is not ` +
          `provisioned in system "${enclosingSystemName}".`,
      );
    }

    const required = declared.required;
    if (required !== undefined && !satisfiesRequired(ref, required)) {
      throw new LoadError(
        `Wiring for "${targetId}.${input}" does not satisfy its required contract.`,
      );
    }
  }

  for (const [input, rawValue] of Object.entries(deps)) {
    const value = blindCast<
      DependencyEnd | undefined,
      'sidesteps the any-instantiated narrowing quirk (see above); the runtime kind check below validates it'
    >(rawValue);
    if (!isNode(value) || wiring[input] !== undefined) continue;
    if (value.kind === 'dependency') {
      throw new LoadError(
        `Dependency input "${input}" of provisioned ${targetKind} "${targetId}" is not wired to a ` +
          `producer (system "${enclosingSystemName}").`,
      );
    }
  }
}

/** The (unvalidated) edges a `wiring` object implies — one dependency edge per entry; `validateWiring` does the real checking. */
function wiringEdges(wiring: Record<string, unknown>, targetId: string): Edge[] {
  return Object.entries(wiring).map(([input, ref]) => ({
    from: producerIdOf(ref) ?? '',
    to: targetId,
    input,
    kind: 'dependency' as const,
  }));
}

/**
 * Recursively flattens one system's body into the shared graph state and
 * returns its resolved SystemOutputs (one ref-port per expose key) for the
 * caller (the enclosing provision() call, or Load itself for the root) to
 * use. `address` is this system's OWN full address, or `undefined` for the root
 * scope — its direct children then get bare (unprefixed) addresses, keeping
 * a single-level system identical to before nesting existed. `wiring` supplies a
 * resolved producer ref-port for each of this system's OWN declared deps (empty
 * for the root, which may not declare any — see the root non-empty-deps
 * check in loadSystem). `nodes`, `edges`, `pending`, and `byId` are shared
 * across the ENTIRE recursive flatten, not per scope — a nested system may
 * forward in a producer provisioned by an ancestor scope, and it is the
 * shared `byId` (keyed by full address) that lets that resolve.
 */
function flatten(
  systemNode: SystemNode,
  address: string | undefined,
  wiring: Record<string, unknown>,
  nodes: GraphNode[],
  edges: Edge[],
  pending: PendingWiring[],
  byId: Map<string, ServiceNode | ResourceNode | SystemNode>,
): Record<string, unknown> {
  const localIds = new Set<string>();
  const used = new Set<string>();

  // Each ctx.inputs entry gets its OWN object identity: a shallow copy of the
  // wired producer ref, branded (symbol-keyed) with the input key it stands
  // for. Without the copy, wiring ONE producer ref into TWO inputs would
  // alias both entries to the same object, and forwarding one would falsely
  // count as forwarding the other. The copy reads through unchanged —
  // `__providerId`, `satisfies`, and edge construction all see the original
  // ref's own fields — so edges keep carrying the REAL producer address.
  const ctxInputs: Record<string, unknown> = {};
  for (const key of Object.keys(systemNode.deps)) {
    const wired = wiring[key];
    ctxInputs[key] =
      typeof wired === 'object' && wired !== null ? { ...wired, [SYSTEM_INPUT_KEY]: key } : wired;
  }

  // An input counts as USED when its per-key ctx.inputs value shows up in a
  // provision's wiring (forwarded down) — or, below, in the body's returned
  // outputs (passed through). Identity comparison is key-precise because each
  // entry is its own object.
  const markUsed = (values: Record<string, unknown>): void => {
    for (const value of Object.values(values)) {
      for (const key of Object.keys(ctxInputs)) {
        if (value === ctxInputs[key]) used.add(key);
      }
    }
  };

  const provision = (
    idOrChild: string | ServiceNode | ResourceNode | SystemNode,
    childOrWiring?: (ServiceNode | ResourceNode | SystemNode) | Record<string, unknown>,
    maybeWiring?: Record<string, unknown>,
    // biome-ignore lint/suspicious/noExplicitAny: SystemBuilder's real overload set is checked at the call site; the collector implementation is untyped by design (see the existing service overloads).
  ): any => {
    // Two call shapes: `provision(id, child, wiring?)` and the id-omitting
    // `provision(child, wiring?)`, where the child's own `name` is the id. A
    // node first argument (not a string) selects the second shape.
    const idOmitted = isNode(idOrChild);
    const child = blindCast<ServiceNode | ResourceNode | SystemNode, 'reassigned per call shape'>(
      idOmitted ? idOrChild : childOrWiring,
    );
    const provisionWiring = blindCast<Record<string, unknown> | undefined, 'per call shape'>(
      idOmitted ? childOrWiring : maybeWiring,
    );
    const id = idOmitted ? idOrChild.name : idOrChild;
    if (typeof id !== 'string' || id.length === 0) {
      throw new LoadError(`provision() requires a non-empty id (system "${systemNode.name}").`);
    }
    // The id becomes the node's address segment: configKey joins it with "_"
    // (id "auth_db" + param "url" would collide with id "auth" + input "db" +
    // param "url" — both AUTH_DB_URL), and node ids join path segments with
    // "." — so neither may appear inside an id.
    if (id.includes('_') || id.includes('.')) {
      throw new LoadError(
        `provision() id "${id}" (system "${systemNode.name}") may not contain "_" or "." — ` +
          '"_" is the config-key separator and "." the node-id path separator; either ' +
          'inside an id collides with the joined form of other names.',
      );
    }
    if (localIds.has(id)) {
      throw new LoadError(`Duplicate provision id "${id}" in system "${systemNode.name}".`);
    }
    // Brand-check on a widened alias: predicate-narrowing the declared union
    // drops the `any`-instantiated ResourceNode member (the same quirk
    // serviceInputs sidesteps by widening `kind` to a plain string).
    const untrusted: unknown = child;
    if (
      !isNode(untrusted) ||
      (untrusted.kind !== 'service' && untrusted.kind !== 'resource' && untrusted.kind !== 'system')
    ) {
      throw new LoadError(
        `provision("${id}") expects a branded service, resource, or system node (construct it with ` +
          "the service()/resource()/system() factories or a pack's own).",
      );
    }
    localIds.add(id);
    const fullAddress = address === undefined ? id : `${address}.${id}`;

    if (child.kind === 'resource') {
      if (provisionWiring !== undefined) {
        throw new LoadError(
          `provision("${id}") received wiring for a resource — a resource has no inputs to wire.`,
        );
      }
      if (child.type.length === 0) {
        throw new LoadError(`provision("${id}") received a resource with an empty node type.`);
      }
      byId.set(fullAddress, child);
      nodes.push({ id: fullAddress, node: child });
      return refForResource(fullAddress, child);
    }

    const localWiring = { ...(provisionWiring ?? {}) };
    markUsed(localWiring);

    if (child.kind === 'service') {
      const inputs = serviceInputs(child, fullAddress);
      nodes.push(...inputs.nodes, { id: fullAddress, node: child });
      edges.push(...inputs.edges, ...wiringEdges(localWiring, fullAddress));
      pending.push({
        deps: child.inputs,
        wiring: localWiring,
        targetId: fullAddress,
        targetKind: 'service',
        enclosingSystemName: systemNode.name,
      });
      byId.set(fullAddress, child);
      return refFor(fullAddress, child);
    }

    edges.push(...wiringEdges(localWiring, fullAddress));
    pending.push({
      deps: child.deps,
      wiring: localWiring,
      targetId: fullAddress,
      targetKind: 'system',
      enclosingSystemName: systemNode.name,
    });
    const childOutputs = flatten(child, fullAddress, localWiring, nodes, edges, pending, byId);
    nodes.push({ id: fullAddress, node: child });
    byId.set(fullAddress, child);
    return blindCast<
      ProvisionedRef,
      "a nested system's ProvisionedRef is its own id plus its already-validated SystemOutputs, matching ProvisionedRef's mapped shape"
    >({ id: fullAddress, ...childOutputs });
  };

  const ctx = blindCast<
    SystemContext<Deps>,
    "ctxInputs holds one resolved InputRef per systemNode.deps key (built above from wiring, the same ref-port shape a producer's port has), and provision is exactly SystemBuilder['provision'] — together they satisfy SystemContext<D> structurally for whatever D this systemNode declares"
  >({
    inputs: ctxInputs,
    provision: blindCast<
      SystemBuilder['provision'],
      'single implementation behind the provision() overloads — returns the contract-carrying ref for a resource, a ProvisionedRef for a service, and a ProvisionedRef for a nested system, exactly what each overload pins, but an object property cannot carry an overloaded implementation signature'
    >(provision),
  });

  const outputs = blindCast<
    Record<string, unknown>,
    'SystemOutputs<E> is a mapped type over the declared expose keys; the loop below reads it by key, which is all a Record<string, unknown> view needs'
  >(systemNode.body(ctx));

  // Pass-through: returning an input as an expose port re-offers it to the
  // enclosing scope — that is using it, not ignoring it (system-composition.md
  // § Forwarding). The consumer of the pass-through output still resolves to
  // the original producer, since the entry read through to its port.
  markUsed(outputs);

  for (const key of Object.keys(systemNode.deps)) {
    if (!used.has(key)) {
      throw new LoadError(
        `System "${systemNode.name}" declares input "${key}" but never forwards it into a provision nor returns it as an output.`,
      );
    }
  }

  for (const [key, contract] of Object.entries(systemNode.expose)) {
    const port = outputs[key];
    if (port === undefined) {
      throw new LoadError(
        `System "${systemNode.name}" declares expose "${key}" but its body did not return a port for it.`,
      );
    }
    if (!satisfiesRequired(port, contract)) {
      throw new LoadError(
        `System "${systemNode.name}"'s returned port for expose "${key}" does not satisfy its declared contract.`,
      );
    }
  }

  return outputs;
}

export function loadSystem(root: SystemNode, opts?: { id?: NodeId }): Graph {
  const rootId = opts?.id ?? root.name;
  const rootDepKeys = Object.keys(root.deps);
  if (rootDepKeys.length > 0) {
    const names = rootDepKeys.map((k) => `"${k}"`).join(', ');
    throw new LoadError(
      `System "${root.name}" declares input${rootDepKeys.length > 1 ? 's' : ''} ${names} but is being ` +
        'deployed as the root — a root has no enclosing scope to wire them; compose ' +
        `"${root.name}" from another system that provisions and wires it instead.`,
    );
  }

  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  const pending: PendingWiring[] = [];
  const byId = new Map<string, ServiceNode | ResourceNode | SystemNode>();

  flatten(root, undefined, {}, nodes, edges, pending, byId);

  for (const entry of pending) validateWiring(entry, byId);
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
 * deploy first. Resources take no wiring, so only service/system-to-service/system
 * edges can ever participate in a cycle; no special-casing needed.
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
