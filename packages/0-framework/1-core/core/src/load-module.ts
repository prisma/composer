import { blindCast } from '@internal/foundation/casts';
import {
  type Edge,
  type Graph,
  type GraphNode,
  LoadError,
  type NodeId,
  type SecretBinding,
} from './graph-types.ts';
import { serviceInputs } from './load-service.ts';
import {
  type DependencyEnd,
  type Deps,
  isNode,
  isSecretSource,
  type ModuleBuilder,
  type ModuleContext,
  type ModuleNode,
  type ProvisionedRef,
  type ResourceNode,
  type ServiceNode,
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
const MODULE_INPUT_KEY = Symbol('prisma:module-input-key');

/** Same per-key identity trick as MODULE_INPUT_KEY, for the parallel `ctx.secrets` forwarding channel. */
const MODULE_SECRET_KEY = Symbol('prisma:module-secret-key');

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
 * service's `.inputs` or a module's `.deps` — the same shape either way),
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
  readonly targetKind: 'service' | 'module';
  readonly enclosingModuleName: string;
}

/**
 * Checks one recorded `wiring` object against the Deps it was wired against:
 * every named input exists and is a dependency slot, every referenced
 * producer is a real (by-now-provisioned) address, and a wired ref whose
 * slot declares a required contract must satisfy() it — no producer-kind
 * branching, the contract alone determines validity, whether the producer is
 * a service port or a resource. Shared by both provisioned kinds so a
 * module-as-child gets exactly the checks a service gets, and run once per
 * entry against the one `byId` shared by the whole recursive flatten, so a
 * forwarded ref resolves through to its real producer address regardless of
 * which ancestor scope provisioned it.
 */
function validateWiring(
  pending: PendingWiring,
  byId: ReadonlyMap<string, ServiceNode | ResourceNode | ModuleNode>,
): void {
  const { deps, wiring, targetId, targetKind, enclosingModuleName } = pending;

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
        `The deps for "${targetId}" name "${input}", which is not a dependency slot of that ${targetKind}.`,
      );
    }

    const producerId = producerIdOf(ref);
    const producer = producerId !== undefined ? byId.get(producerId) : undefined;
    if (producerId === undefined || producer === undefined) {
      throw new LoadError(
        `The deps for "${targetId}.${input}" reference "${String(producerId)}", which is not ` +
          `provisioned in module "${enclosingModuleName}".`,
      );
    }

    const required = declared.required;
    if (required !== undefined && !satisfiesRequired(ref, required)) {
      throw new LoadError(
        `The deps for "${targetId}.${input}" do not satisfy the slot's required contract.`,
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
          `producer (module "${enclosingModuleName}").`,
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
 * Checks the secrets wired into one provisioned child: every declared slot is
 * bound to a real secret source (an `envSecret` or a forwarded ctx.secrets
 * ref), and no wired key names a slot the child doesn't declare — the secret
 * analog of `validateWiring`'s per-input checks, but resolved inline (a source
 * carries its own name, so no whole-graph pass is needed).
 */
function validateSecretBinding(
  child: ServiceNode | ModuleNode,
  id: string,
  secretWiring: Record<string, unknown>,
  enclosingModuleName: string,
): void {
  const { kind } = child;
  for (const slot of Object.keys(child.secretSlots)) {
    const bound = secretWiring[slot];
    if (bound === undefined) {
      throw new LoadError(
        `Secret slot "${slot}" of provisioned ${kind} "${id}" is not bound (module ` +
          `"${enclosingModuleName}") — bind it with envSecret('NAME') or forward ctx.secrets.`,
      );
    }
    if (!isSecretSource(bound)) {
      throw new LoadError(
        `Secret slot "${slot}" of "${id}" (module "${enclosingModuleName}") was wired with a ` +
          "non-secret value — use envSecret('NAME') or a forwarded ctx.secrets ref.",
      );
    }
  }
  for (const slot of Object.keys(secretWiring)) {
    if (!Object.hasOwn(child.secretSlots, slot)) {
      throw new LoadError(
        `The secrets for "${id}" name "${slot}", which is not a secret slot of that ${kind} ` +
          `(module "${enclosingModuleName}").`,
      );
    }
  }
}

/**
 * Recursively flattens one module's body into the shared graph state and
 * returns its resolved ModuleOutputs (one ref-port per expose key) for the
 * caller (the enclosing provision() call, or Load itself for the root) to
 * use. `address` is this module's OWN full address, or `undefined` for the root
 * scope — its direct children then get bare (unprefixed) addresses, keeping
 * a single-level module identical to before nesting existed. `wiring` supplies a
 * resolved producer ref-port for each of this module's OWN declared deps (empty
 * for the root, which may not declare any — see the root non-empty-deps
 * check in loadModule). `nodes`, `edges`, `pending`, and `byId` are shared
 * across the ENTIRE recursive flatten, not per scope — a nested module may
 * forward in a producer provisioned by an ancestor scope, and it is the
 * shared `byId` (keyed by full address) that lets that resolve.
 */
function flatten(
  moduleNode: ModuleNode,
  address: string | undefined,
  wiring: Record<string, unknown>,
  secretWiring: Record<string, unknown>,
  nodes: GraphNode[],
  edges: Edge[],
  pending: PendingWiring[],
  secretBindings: SecretBinding[],
  byId: Map<string, ServiceNode | ResourceNode | ModuleNode>,
): Record<string, unknown> {
  const localIds = new Set<string>();
  const used = new Set<string>();
  const usedSecrets = new Set<string>();

  // Each ctx.inputs entry gets its OWN object identity: a shallow copy of the
  // wired producer ref, branded (symbol-keyed) with the input key it stands
  // for. Without the copy, wiring ONE producer ref into TWO inputs would
  // alias both entries to the same object, and forwarding one would falsely
  // count as forwarding the other. The copy reads through unchanged —
  // `__providerId`, `satisfies`, and edge construction all see the original
  // ref's own fields — so edges keep carrying the REAL producer address.
  const ctxInputs: Record<string, unknown> = {};
  for (const key of Object.keys(moduleNode.deps)) {
    const wired = wiring[key];
    ctxInputs[key] =
      typeof wired === 'object' && wired !== null ? { ...wired, [MODULE_INPUT_KEY]: key } : wired;
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

  // The secrets forwarding channel mirrors ctx.inputs: each declared secret slot
  // gets its OWN branded copy of the source bound to it, so forwarding one down a
  // provision counts precisely (identity), and `name` reads through unchanged.
  const ctxSecrets: Record<string, unknown> = {};
  for (const key of Object.keys(moduleNode.secretSlots)) {
    const bound = secretWiring[key];
    ctxSecrets[key] =
      typeof bound === 'object' && bound !== null ? { ...bound, [MODULE_SECRET_KEY]: key } : bound;
  }
  const markSecretsUsed = (values: Record<string, unknown>): void => {
    for (const value of Object.values(values)) {
      for (const key of Object.keys(ctxSecrets)) {
        if (value === ctxSecrets[key]) usedSecrets.add(key);
      }
    }
  };

  const provision = (
    child: ServiceNode | ResourceNode | ModuleNode,
    opts?: { id?: string; deps?: Record<string, unknown>; secrets?: Record<string, unknown> },
    // biome-ignore lint/suspicious/noExplicitAny: ModuleBuilder's real overload set is checked at the call site; the collector implementation is untyped by design.
  ): any => {
    // The id defaults to the node's own `name`; `opts.deps`/`opts.secrets` carry
    // the producers and secret sources that satisfy its slots. The "_"/"." and
    // duplicate-id checks, brand-check and address join below are identical
    // whether the id was written or inferred.
    const id = opts?.id ?? child.name;
    const provisionWiring = opts?.deps;
    const provisionSecrets = opts?.secrets;
    if (typeof id !== 'string' || id.length === 0) {
      throw new LoadError(`provision() requires a non-empty id (module "${moduleNode.name}").`);
    }
    // The id becomes the node's address segment: configKey joins it with "_"
    // (id "auth_db" + param "url" would collide with id "auth" + input "db" +
    // param "url" — both AUTH_DB_URL), and node ids join path segments with
    // "." — so neither may appear inside an id.
    if (id.includes('_') || id.includes('.')) {
      throw new LoadError(
        `provision() id "${id}" (module "${moduleNode.name}") may not contain "_" or "." — ` +
          '"_" is the config-key separator and "." the node-id path separator; either ' +
          'inside an id collides with the joined form of other names.',
      );
    }
    if (localIds.has(id)) {
      throw new LoadError(`Duplicate provision id "${id}" in module "${moduleNode.name}".`);
    }
    // Brand-check on a widened alias: predicate-narrowing the declared union
    // drops the `any`-instantiated ResourceNode member (the same quirk
    // serviceInputs sidesteps by widening `kind` to a plain string).
    const untrusted: unknown = child;
    if (
      !isNode(untrusted) ||
      (untrusted.kind !== 'service' && untrusted.kind !== 'resource' && untrusted.kind !== 'module')
    ) {
      throw new LoadError(
        `provision("${id}") expects a branded service, resource, or module node (construct it with ` +
          "the service()/resource()/module() factories or a pack's own).",
      );
    }
    localIds.add(id);
    const fullAddress = address === undefined ? id : `${address}.${id}`;

    if (child.kind === 'resource') {
      if (provisionWiring !== undefined) {
        throw new LoadError(
          `provision("${id}") received deps for a resource — a resource has no dependency slots to satisfy.`,
        );
      }
      if (provisionSecrets !== undefined) {
        throw new LoadError(
          `provision("${id}") received secrets for a resource — a resource has no secret slots to satisfy.`,
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

    // Secrets: validate every declared slot is bound to a real secret source,
    // reject extras, and mark forwarded refs used (identity). No `pending`
    // deferral — a secret source carries its own name, so nothing needs the
    // whole graph to resolve (unlike a dependency's producer).
    const localSecrets = { ...(provisionSecrets ?? {}) };
    markSecretsUsed(localSecrets);
    validateSecretBinding(child, id, localSecrets, moduleNode.name);

    if (child.kind === 'service') {
      // A service's slots resolve to names HERE — record one binding per slot.
      for (const slot of Object.keys(child.secretSlots)) {
        const bound = localSecrets[slot];
        if (isSecretSource(bound)) {
          secretBindings.push({ serviceAddress: fullAddress, slot, source: bound });
        }
      }
      const inputs = serviceInputs(child, fullAddress);
      nodes.push(...inputs.nodes, { id: fullAddress, node: child });
      edges.push(...inputs.edges, ...wiringEdges(localWiring, fullAddress));
      pending.push({
        deps: child.inputs,
        wiring: localWiring,
        targetId: fullAddress,
        targetKind: 'service',
        enclosingModuleName: moduleNode.name,
      });
      byId.set(fullAddress, child);
      return refFor(fullAddress, child);
    }

    edges.push(...wiringEdges(localWiring, fullAddress));
    pending.push({
      deps: child.deps,
      wiring: localWiring,
      targetId: fullAddress,
      targetKind: 'module',
      enclosingModuleName: moduleNode.name,
    });
    const childOutputs = flatten(
      child,
      fullAddress,
      localWiring,
      localSecrets,
      nodes,
      edges,
      pending,
      secretBindings,
      byId,
    );
    nodes.push({ id: fullAddress, node: child });
    byId.set(fullAddress, child);
    return blindCast<
      ProvisionedRef,
      "a nested module's ProvisionedRef is its own id plus its already-validated ModuleOutputs, matching ProvisionedRef's mapped shape"
    >({ id: fullAddress, ...childOutputs });
  };

  const ctx = blindCast<
    ModuleContext<Deps>,
    "ctxInputs/ctxSecrets hold one resolved ref per moduleNode.deps/secrets key (the same shapes a producer port and an envSecret source carry), and provision is exactly ModuleBuilder['provision'] — together they satisfy ModuleContext<D, S> structurally for whatever D/S this moduleNode declares"
  >({
    inputs: ctxInputs,
    secrets: ctxSecrets,
    provision: blindCast<
      ModuleBuilder['provision'],
      'single implementation behind the provision() overloads — returns the contract-carrying ref for a resource, a ProvisionedRef for a service, and a ProvisionedRef for a nested module, exactly what each overload pins, but an object property cannot carry an overloaded implementation signature'
    >(provision),
  });

  const outputs = blindCast<
    Record<string, unknown>,
    'ModuleOutputs<E> is a mapped type over the declared expose keys; the loop below reads it by key, which is all a Record<string, unknown> view needs'
  >(moduleNode.body(ctx) ?? {});

  // Pass-through: returning an input as an expose port re-offers it to the
  // enclosing scope — that is using it, not ignoring it (module-composition.md
  // § Forwarding). The consumer of the pass-through output still resolves to
  // the original producer, since the entry read through to its port.
  markUsed(outputs);

  for (const key of Object.keys(moduleNode.deps)) {
    if (!used.has(key)) {
      throw new LoadError(
        `Module "${moduleNode.name}" declares input "${key}" but never forwards it into a provision nor returns it as an output.`,
      );
    }
  }

  // A declared secret slot must be forwarded into a provision (a secret is not
  // re-exposed as a port, so there is no pass-through case for it).
  for (const key of Object.keys(moduleNode.secretSlots)) {
    if (!usedSecrets.has(key)) {
      throw new LoadError(
        `Module "${moduleNode.name}" declares secret "${key}" but never forwards it into a provision.`,
      );
    }
  }

  for (const [key, contract] of Object.entries(moduleNode.expose)) {
    const port = outputs[key];
    if (port === undefined) {
      throw new LoadError(
        `Module "${moduleNode.name}" declares expose "${key}" but its body did not return a port for it.`,
      );
    }
    if (!satisfiesRequired(port, contract)) {
      throw new LoadError(
        `Module "${moduleNode.name}"'s returned port for expose "${key}" does not satisfy its declared contract.`,
      );
    }
  }

  return outputs;
}

export function loadModule(root: ModuleNode, opts?: { id?: NodeId }): Graph {
  const rootId = opts?.id ?? root.name;
  const rootDepKeys = Object.keys(root.deps);
  if (rootDepKeys.length > 0) {
    const names = rootDepKeys.map((k) => `"${k}"`).join(', ');
    throw new LoadError(
      `Module "${root.name}" declares input${rootDepKeys.length > 1 ? 's' : ''} ${names} but is being ` +
        'deployed as the root — a root has no enclosing scope to wire them; compose ' +
        `"${root.name}" from another module that provisions and wires it instead.`,
    );
  }
  const rootSecretKeys = Object.keys(root.secretSlots);
  if (rootSecretKeys.length > 0) {
    const names = rootSecretKeys.map((k) => `"${k}"`).join(', ');
    throw new LoadError(
      `Module "${root.name}" declares secret${rootSecretKeys.length > 1 ? 's' : ''} ${names} but is ` +
        'being deployed as the root — a root has no enclosing scope to bind them; the root binds ' +
        `secrets with envSecret('NAME'), it does not declare secret slots of its own.`,
    );
  }

  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  const pending: PendingWiring[] = [];
  const secretBindings: SecretBinding[] = [];
  const byId = new Map<string, ServiceNode | ResourceNode | ModuleNode>();

  flatten(root, undefined, {}, {}, nodes, edges, pending, secretBindings, byId);

  for (const entry of pending) validateWiring(entry, byId);
  assertDependencyDag(edges);

  const rootGraphNode: GraphNode = { id: rootId, node: root };
  return {
    root: rootGraphNode,
    nodes: [...topoSort(nodes, edges), rootGraphNode],
    edges,
    secrets: secretBindings,
  };
}

/**
 * The dependency edges must form a DAG — a cycle means neither producer can
 * deploy first. Resources take no wiring, so only service/module-to-service/module
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
