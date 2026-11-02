import { blindCast } from '@internal/foundation/casts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { contractStyleOf } from './contract.ts';
import {
  type AuthoredEdge,
  type BoundaryPort,
  type Edge,
  type Graph,
  type GraphNode,
  LoadError,
  type LoadOptions,
  type NodeId,
  type ParamBinding,
  type PortEndpoint,
  RESOURCE_OUT_PORT,
  type ServiceInputBinding,
} from './graph-types.ts';
import { boundaryPortsOf, slotNodesAndEdges } from './load-service.ts';
import { buildModuleInput } from './module-input.ts';
import {
  type AnyContract,
  type DependencyEnd,
  type Deps,
  isConfigKeySegment,
  isNode,
  type ModuleBuilder,
  type ModuleContext,
  type ModuleNode,
  type ProvisionedRef,
  type ResourceNode,
  type ResourceProps,
  type ServiceNode,
} from './node.ts';
import { type ProvisionedModuleInput, resolveValues } from './resolve-values.ts';
import { topoSort } from './toposort.ts';
import { environmentFacts, isValue } from './value.ts';

/**
 * Brands a ref-port with the AUTHORED endpoint it stands for — which port of
 * which node the author wired, before any forwarding chain resolves. Read
 * only by `authoredSourceOf`; `__providerId` keeps carrying the resolved
 * producer for the flat (post-dereference) edges.
 */
const AUTHORED_PORT = Symbol('prisma:authored-port');

interface AuthoredPortBrand {
  readonly node: NodeId;
  readonly name: string;
}

/** The authored out-port brand carried by `ref`, if any. */
function authoredPortOf(ref: unknown): AuthoredPortBrand | undefined {
  if (typeof ref !== 'object' || ref === null) return undefined;
  const brand = blindCast<
    Record<PropertyKey, unknown>,
    'reading the authored-port brand off an unknown object'
  >(ref)[AUTHORED_PORT];
  if (typeof brand !== 'object' || brand === null) return undefined;
  const { node, name } = blindCast<
    Partial<AuthoredPortBrand>,
    'only this module writes the brand, always as { node, name }; the field checks below re-verify'
  >(brand);
  return typeof node === 'string' && typeof name === 'string' ? { node, name } : undefined;
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
    ports[port] = { ...contract, __providerId: id, [AUTHORED_PORT]: { node: id, name: port } };
  }
  return blindCast<
    ProvisionedRef,
    'ref-ports are built from the service exposed contracts keyed by port name, matching ProvisionedRef mapped shape'
  >({ id, ...ports });
}

/**
 * The resource variant of refFor: a resource has at most one port — the
 * contract it provides — flattened onto the ref itself, tagged with the
 * provider id. `id` and the authored brand are written last so a hostile
 * contract value cannot clobber them. A resource that exposes nothing gets
 * only its id.
 */
function refForResource(id: string, resource: ResourceNode): ProvisionedRef {
  const provides: AnyContract | undefined = resource.provides;
  if (provides === undefined) return { id };
  return blindCast<
    ProvisionedRef,
    'the ref is the provided contract value tagged with the provider id — the `{ id } & RefPort<C>` shape the resource provision() overload pins'
  >({
    ...provides,
    __providerId: id,
    id,
    [AUTHORED_PORT]: { node: id, name: RESOURCE_OUT_PORT },
  });
}

/** A wired value's producer id: a ref-port's `__providerId`, or a bare ref's `id`. */
function producerIdOf(ref: unknown): string | undefined {
  if (typeof ref !== 'object' || ref === null) return undefined;
  if ('__providerId' in ref && typeof ref.__providerId === 'string') return ref.__providerId;
  if ('id' in ref && typeof ref.id === 'string') return ref.id;
  return undefined;
}

/**
 * Brands each `ctx.deps` entry with the input key it stands for (see
 * flatten): diagnostic only — usage attribution relies on the per-key object
 * identity the branding copy creates, never on reading this back.
 */
const MODULE_INPUT_KEY = Symbol('prisma:module-input-key');

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
  readonly targetKind: 'service' | 'module' | 'resource';
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
        `Dependency "${input}" of provisioned ${targetKind} "${targetId}" is not wired to a ` +
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
 * Checks the params wired into a provisioned SERVICE: a declared param is never
 * required to be bound here — it may fall back to its own `default` (checked
 * later, at `buildConfig`) — so this only rejects a wired key that names
 * something other than a real declared param.
 */
function validateServiceParamBinding(
  child: ServiceNode,
  id: string,
  paramWiring: Record<string, unknown>,
  enclosingModuleName: string,
): void {
  for (const slot of Object.keys(paramWiring)) {
    if (!Object.hasOwn(child.params, slot)) {
      throw new LoadError(
        `The params for "${id}" name "${slot}", which is not a param of that service ` +
          `(module "${enclosingModuleName}").`,
      );
    }
  }
}

/**
 * Recursively flattens one module's body into the shared graph state and
 * returns its resolved ModuleOutputs (one ref-port per expose key) for the
 * caller (the enclosing provision() call, or Load itself for the root) to
 * use. `wiring` supplies a
 * resolved producer ref-port for each of this module's OWN declared deps (empty
 * for the root, which may not declare any — see the root non-empty-deps
 * check in loadModule). `nodes`, `edges`, `pending`, and `byId` are shared
 * across the ENTIRE recursive flatten, not per scope — a nested module may
 * forward in a producer provisioned by an ancestor scope, and it is the
 * shared `byId` (keyed by full address) that lets that resolve.
 *
 * `selfId` is this module's own full address — for the root, the deployed app
 * name (ADR-0057). Every child's address is `selfId` plus its provision id, so
 * every address starts with the app name. It also anchors the authored view:
 * children carry it as their `parent`, and this module's own boundary ports
 * (and the authored edges touching them) are recorded against it.
 */
function flatten(
  moduleNode: ModuleNode,
  selfId: NodeId,
  wiring: Record<string, unknown>,
  nodes: GraphNode[],
  edges: Edge[],
  pending: PendingWiring[],
  inputBindings: ServiceInputBinding[],
  paramBindings: ParamBinding[],
  moduleInputs: ProvisionedModuleInput[],
  byId: Map<string, ServiceNode | ResourceNode | ModuleNode>,
  ports: BoundaryPort[],
  authoredEdges: AuthoredEdge[],
  loading: { sealed: boolean },
): Record<string, unknown> {
  ports.push(...boundaryPortsOf(selfId, moduleNode));
  const localIds = new Set<string>();
  const used = new Set<string>();

  // Each ctx.deps entry gets its OWN object identity: a shallow copy of the
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

  // An input counts as USED when its per-key ctx.deps value shows up in a
  // provision's wiring (forwarded down) — or, below, in the body's returned
  // outputs (passed through). Identity comparison is key-precise because each
  // entry is its own object.
  const markUsed = (values: readonly unknown[]): void => {
    for (const value of values) {
      for (const key of Object.keys(ctxInputs)) {
        if (value === ctxInputs[key]) used.add(key);
      }
    }
  };

  // The authored SOURCE endpoint a wiring value stands for: this module's own
  // `in` port when the value is one of its forwarded ctx.deps (identity,
  // like markUsed — and checked FIRST, because a forwarded copy still carries
  // the original producer's authored brand), else the producer `out` port the
  // ref-port was built for. A whole ref wired wholesale into an untyped slot
  // names no port, so it authors no edge.
  const authoredSourceOf = (value: unknown): PortEndpoint | undefined => {
    for (const key of Object.keys(ctxInputs)) {
      if (value === ctxInputs[key]) return { node: selfId, direction: 'in', name: key };
    }
    const brand = authoredPortOf(value);
    return brand === undefined
      ? undefined
      : { node: brand.node, direction: 'out', name: brand.name };
  };

  /** Records the authored edge each wiring entry declares: source port → the target's own `in` port. */
  const recordAuthoredWiring = (targetId: NodeId, targetWiring: Record<string, unknown>): void => {
    for (const [input, ref] of Object.entries(targetWiring)) {
      const from = authoredSourceOf(ref);
      if (from !== undefined) {
        authoredEdges.push({ from, to: { node: targetId, direction: 'in', name: input } });
      }
    }
  };

  const provision = (
    child: ServiceNode | ResourceNode | ModuleNode,
    opts?: {
      id?: string;
      deps?: Record<string, unknown>;
      secrets?: Record<string, unknown>;
      input?: unknown;
      params?: Record<string, unknown>;
    },
    // biome-ignore lint/suspicious/noExplicitAny: ModuleBuilder's real overload set is checked at the call site; the collector implementation is untyped by design.
  ): any => {
    if (loading.sealed) {
      throw new LoadError(
        `provision() was called after module "${moduleNode.name}" was loaded, from inside a ` +
          'resolve() function. resolve() computes values, never structure: the graph is the same ' +
          'whatever inputs Composer is given (ADR-0062). Provision the node in the module body and ' +
          'pass the value into it.',
      );
    }
    // The id defaults to the node's own `name`; `opts.deps`, `opts.input` and a
    // service's `opts.params` carry the producers, the input binding and the
    // param bindings. `opts.secrets` is read only to refuse it. The "_"/"." and
    // duplicate-id checks, brand-check and address join below are identical
    // whether the id was written or inferred.
    const id = opts?.id ?? child.name;
    const provisionWiring = opts?.deps;
    const provisionSecrets = opts?.secrets;
    const provisionInput = opts?.input;
    const provisionParams = opts?.params;
    if (isValue(id)) {
      throw new LoadError(
        `provision() received a value as its id (module "${moduleNode.name}"). A value can ` +
          'configure a node, never decide its address: the graph is the same whatever inputs ' +
          'Composer is given (ADR-0062).',
      );
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new LoadError(`provision() requires a non-empty id (module "${moduleNode.name}").`);
    }
    // The id becomes the node's address segment, and addresses derive
    // deterministic config keys (segments uppercased, "_"-joined — see
    // isConfigKeySegment). So an id must be ASCII letters and digits only:
    // "_" collides with the key separator (id "auth_db" + param "url" vs id
    // "auth" + input "db" + param "url" — both AUTH_DB_URL), "." is the
    // address path separator, and anything else (e.g. "-") has no place in
    // a config key.
    if (!isConfigKeySegment(id)) {
      throw new LoadError(
        `provision() id "${id}" (module "${moduleNode.name}") must contain only ASCII letters ` +
          'and digits ([A-Za-z0-9]) — the id becomes an address segment, and addresses derive ' +
          'deterministic config keys (segments uppercased and joined with "_"). ' +
          `"${id}" would put "${id.toUpperCase()}" inside the derived key. ` +
          '("_" collides with the key separator and "." with the address separator.)',
      );
    }
    if (localIds.has(id)) {
      throw new LoadError(`Duplicate provision id "${id}" in module "${moduleNode.name}".`);
    }
    // Brand-check on a widened alias: predicate-narrowing the declared union
    // drops the `any`-instantiated ResourceNode member (the same quirk
    // slotNodesAndEdges sidesteps by widening `kind` to a plain string).
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
    const fullAddress = `${selfId}.${id}`;

    if (child.kind === 'resource') {
      if (provisionWiring !== undefined) {
        throw new LoadError(
          `provision("${id}") received deps for a resource — a resource's slots are wired when it is constructed, not at provision().`,
        );
      }
      if (provisionSecrets !== undefined) {
        throw new LoadError(
          `provision("${id}") received secrets for a resource — a resource has no secret slots to satisfy.`,
        );
      }
      if (provisionInput !== undefined) {
        throw new LoadError(
          `provision("${id}") received an input binding for a resource — a resource declares no input schema.`,
        );
      }
      if (provisionParams !== undefined) {
        throw new LoadError(
          `provision("${id}") received params for a resource — a resource has no params to satisfy.`,
        );
      }
      if (child.type.length === 0) {
        throw new LoadError(`provision("${id}") received a resource with an empty node type.`);
      }
      const localWiring = { ...child.deps };
      markUsed(Object.values(localWiring));
      byId.set(fullAddress, child);
      const slots = slotNodesAndEdges(child, fullAddress);
      nodes.push(...slots.nodes, { id: fullAddress, parent: selfId, node: child });
      edges.push(...slots.edges, ...wiringEdges(localWiring, fullAddress));
      ports.push(...boundaryPortsOf(fullAddress, child));
      const provides: AnyContract | undefined = child.provides;
      if (provides !== undefined) {
        ports.push({
          node: fullAddress,
          direction: 'out',
          name: RESOURCE_OUT_PORT,
          contractKind: provides.kind,
          style: contractStyleOf(provides),
        });
      }
      recordAuthoredWiring(fullAddress, localWiring);
      pending.push({
        deps: child.inputs ?? {},
        wiring: localWiring,
        targetId: fullAddress,
        targetKind: 'resource',
        enclosingModuleName: moduleNode.name,
      });
      return refForResource(fullAddress, child);
    }

    for (const [input, ref] of Object.entries(provisionWiring ?? {})) {
      if (isValue(ref)) {
        throw new LoadError(
          `The deps for "${fullAddress}.${input}" are bound to a value. A value can configure a ` +
            'node, never decide its edges: the graph is the same whatever inputs Composer is given ' +
            '(ADR-0062).',
        );
      }
    }
    const localWiring = { ...(provisionWiring ?? {}) };
    markUsed(Object.values(localWiring));

    const localParams = { ...(provisionParams ?? {}) };

    if (child.kind === 'service') {
      if (provisionSecrets !== undefined) {
        throw new LoadError(
          `provision("${id}") received secrets for a service — a service takes its secrets as ` +
            'envSecret(...) leaves of its `input` binding (ADR-0042), not a secrets map.',
        );
      }
      // The input binding pairs 1:1 with a declared input schema — a schema
      // with no binding has nothing to resolve at deploy, and a binding with
      // no schema has no judge (ADR-0042).
      if (child.inputSchema !== undefined && provisionInput === undefined) {
        throw new LoadError(
          `Input of provisioned service "${id}" is not bound (module "${moduleNode.name}") — the ` +
            'service declares an input schema; bind it with `input: { … }` on its provision() call.',
        );
      }
      if (child.inputSchema === undefined && provisionInput !== undefined) {
        throw new LoadError(
          `provision("${id}") received an input binding, but the service declares no input schema ` +
            `(module "${moduleNode.name}").`,
        );
      }
      if (provisionInput !== undefined) {
        inputBindings.push({
          serviceAddress: fullAddress,
          binding: blindCast<
            ServiceInputBinding['binding'],
            'the provision overloads type the binding as InputBinding; the collector receives it untyped'
          >(provisionInput),
        });
      }
      // A service param binding is optional per slot (default is the
      // fallback), so this only rejects a name that isn't a real param —
      // every entry actually supplied is recorded, literal or source alike.
      validateServiceParamBinding(child, id, localParams, moduleNode.name);
      for (const [slot, binding] of Object.entries(localParams)) {
        paramBindings.push({ serviceAddress: fullAddress, slot, binding });
      }
      const inputs = slotNodesAndEdges(child, fullAddress);
      nodes.push(...inputs.nodes, { id: fullAddress, parent: selfId, node: child });
      edges.push(...inputs.edges, ...wiringEdges(localWiring, fullAddress));
      ports.push(...boundaryPortsOf(fullAddress, child));
      recordAuthoredWiring(fullAddress, localWiring);
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

    if (provisionSecrets !== undefined) {
      throw new LoadError(
        `provision("${id}") received secrets for a module, which a module no longer takes. A ` +
          'module takes a secret as a secretString() field of its `input` binding (ADR-0061), not a secrets map.',
      );
    }
    if (provisionParams !== undefined) {
      throw new LoadError(
        `provision("${id}") received params for a module, which a module no longer takes. A ` +
          'module takes its values as fields of its `input` binding (ADR-0061), not a params map.',
      );
    }
    const childInputSchema: StandardSchemaV1 | undefined = child.inputSchema;
    if (childInputSchema === undefined && provisionInput !== undefined) {
      throw new LoadError(
        `provision("${id}") received an input binding, but the module declares no input schema ` +
          `(module "${moduleNode.name}").`,
      );
    }
    if (childInputSchema !== undefined && provisionInput === undefined) {
      throw new LoadError(
        `Input of provisioned module "${id}" is not bound (module "${moduleNode.name}") — the ` +
          'module declares an input schema; bind it with `input: { … }` on its provision() call.',
      );
    }
    if (childInputSchema !== undefined) {
      moduleInputs.push({
        moduleAddress: fullAddress,
        schema: childInputSchema,
        binding: provisionInput,
        fromConfigPool: false,
      });
    }
    edges.push(...wiringEdges(localWiring, fullAddress));
    recordAuthoredWiring(fullAddress, localWiring);
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
      nodes,
      edges,
      pending,
      inputBindings,
      paramBindings,
      moduleInputs,
      byId,
      ports,
      authoredEdges,
      loading,
    );
    nodes.push({ id: fullAddress, parent: selfId, node: child });
    byId.set(fullAddress, child);
    // Each returned output gets its OWN shallow copy branded as THIS module's
    // out port — the same per-key copy trick ctx.deps uses — so wiring it
    // into a sibling authors an edge from the module boundary, not from the
    // inner producer the flat view resolves to. `__providerId` and
    // `satisfies` read through unchanged.
    const brandedOutputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(childOutputs)) {
      brandedOutputs[key] =
        typeof value === 'object' && value !== null
          ? { ...value, [AUTHORED_PORT]: { node: fullAddress, name: key } }
          : value;
    }
    return blindCast<
      ProvisionedRef,
      "a nested module's ProvisionedRef is its own id plus its already-validated ModuleOutputs, matching ProvisionedRef's mapped shape"
    >({ id: fullAddress, ...brandedOutputs });
  };

  const ctx = blindCast<
    ModuleContext<Deps>,
    "ctxInputs holds one resolved ref per moduleNode.deps key (the shape a producer port carries), input is buildModuleInput(selfId) exactly when the node declares an input schema, and provision is exactly ModuleBuilder['provision'] — together they satisfy ModuleContext<D, I> structurally for whatever D/I this moduleNode declares"
  >({
    deps: ctxInputs,
    input: moduleNode.inputSchema === undefined ? undefined : buildModuleInput(selfId),
    environment: environmentFacts,
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
  markUsed(Object.values(outputs));

  for (const key of Object.keys(moduleNode.deps)) {
    if (!used.has(key)) {
      throw new LoadError(
        `Module "${moduleNode.name}" declares dependency "${key}" but never forwards it into a provision nor returns it as an exposed interface.`,
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
    if (isValue(port)) {
      throw new LoadError(
        `Module "${moduleNode.name}" returned a value for expose "${key}". A value can configure a ` +
          'node, never decide its edges: return a port of a node the body provisions.',
      );
    }
    if (!satisfiesRequired(port, contract)) {
      throw new LoadError(
        `Module "${moduleNode.name}"'s returned port for expose "${key}" does not satisfy its declared contract.`,
      );
    }
    // The boundary edge the returned port authors: a child's output exposed
    // by this module (out → out), or a re-exposed own input (in → out).
    const from = authoredSourceOf(port);
    if (from !== undefined) {
      authoredEdges.push({ from, to: { node: selfId, direction: 'out', name: key } });
    }
  }

  return outputs;
}

export function loadModule(root: ModuleNode, opts?: LoadOptions): Graph {
  const rootId = opts?.id ?? root.name;
  const rootDepKeys = Object.keys(root.deps);
  if (rootDepKeys.length > 0) {
    const names = rootDepKeys.map((k) => `"${k}"`).join(', ');
    throw new LoadError(
      `Module "${root.name}" declares ${rootDepKeys.length > 1 ? 'dependencies' : 'dependency'} ${names} but is being ` +
        'deployed as the root — a root has no enclosing scope to wire them; compose ' +
        `"${root.name}" from another module that provisions and wires it instead.`,
    );
  }
  const moduleInputs: ProvisionedModuleInput[] = [];
  if (root.inputSchema !== undefined) {
    if (opts?.configPool === undefined) {
      throw new LoadError(
        `Module "${root.name}" declares input and is being deployed as the root, but Load was given ` +
          'no values from the `config` adapters to fill it from. Pass { configPool } to Load; prisma deploy and prisma dev ' +
          'pass the values the `config` adapters return.',
      );
    }
    moduleInputs.push({
      moduleAddress: rootId,
      schema: root.inputSchema,
      binding: opts.configPool,
      fromConfigPool: true,
    });
  }

  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  const pending: PendingWiring[] = [];
  const inputBindings: ServiceInputBinding[] = [];
  const paramBindings: ParamBinding[] = [];
  const byId = new Map<string, ServiceNode | ResourceNode | ModuleNode>();
  const ports: BoundaryPort[] = [];
  const authoredEdges: AuthoredEdge[] = [];
  const loading = { sealed: false };

  try {
    flatten(
      root,
      rootId,
      {},
      nodes,
      edges,
      pending,
      inputBindings,
      paramBindings,
      moduleInputs,
      byId,
      ports,
      authoredEdges,
      loading,
    );
    for (const entry of pending) validateWiring(entry, byId);
    assertDependencyDag(edges);
  } finally {
    loading.sealed = true;
  }
  const resources = new Map<NodeId, ResourceNode>();
  for (const [address, node] of byId) {
    if (node.kind === 'resource') resources.set(address, node);
  }
  const resolved = resolveValues({
    environment: opts?.environment,
    configPool: opts?.configPool,
    inputBindings,
    params: paramBindings,
    moduleInputs,
    resources,
  });
  const resolvedNodes = nodes.map((entry): GraphNode => {
    const props = resolved.resourceProps.get(entry.id);
    if (entry.node.kind !== 'resource' || props === undefined || props === entry.node.props) {
      return entry;
    }
    return { ...entry, node: withResolvedProps(entry.node, props) };
  });

  const rootGraphNode: GraphNode = { id: rootId, parent: undefined, node: root };
  return {
    root: rootGraphNode,
    nodes: [...topoSort(resolvedNodes, edges), rootGraphNode],
    edges,
    ports,
    authoredEdges,
    inputBindings: resolved.inputBindings,
    params: resolved.params,
    secretSources: resolved.secretSources,
  };
}

/**
 * A frozen copy of `node` holding `props`, keeping its prototype (a class built
 * on `ResourceNodeBase` keeps its methods) and its own properties, the brand included.
 */
function withResolvedProps(node: ResourceNode, props: ResourceProps): ResourceNode {
  const copy: ResourceNode = Object.freeze(
    Object.create(Object.getPrototypeOf(node), {
      ...Object.getOwnPropertyDescriptors(node),
      props: {
        value: Object.freeze(props),
        enumerable: true,
        writable: false,
        configurable: false,
      },
    }),
  );
  return copy;
}

/**
 * The dependency edges must form a DAG — a cycle means neither producer can
 * deploy first. A resource with dependency slots can take part in a cycle too.
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
