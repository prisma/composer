/**
 * Core model: node types and the factories that construct them, plain frozen
 * data objects. A node's `extension` + `type` form its deploy-time registry key (ADR-0017).
 */
import { blindCast } from './casts.ts';
import type { ConfigParam, Connection, Params, Values } from './config.ts';
import type { Contract } from './contract.ts';

// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
const NODE: unique symbol = Symbol.for('prisma:node') as never;

/** Opaque `Contract<any, any>` bound shared by every node/port type that doesn't care which contract. */
// biome-ignore lint/suspicious/noExplicitAny: the one alias for this bound — see doc comment.
export type AnyContract = Contract<any, any>;

/** How a service's app becomes a runnable artifact — the build handler's routing key (`extension`/`type`) plus paths resolved relative to the authoring module. */
export interface BuildAdapter {
  /** The extension package that provides the build handler, e.g. "@prisma/app-node". */
  readonly extension: string;
  /** The build handler's node ID within its extension, e.g. "node" · "nextjs". */
  readonly type: string;
  /** The authoring module's `import.meta.url` — every other path on this descriptor resolves relative to `dirname(module)`. */
  readonly module: string;
  /**
   * The app's built runnable, resolved relative to `dirname(module)` and
   * interpreted by the type's build handler (e.g. "node": a server file path;
   * "nextjs": a filename inside the standalone output dir).
   */
  readonly entry: string;
}

/**
 * A Resource's identity: the one place a piece of infrastructure exists.
 * Provisioned by a system, never embedded in a service's deps. `provides`
 * is the Contract the resource offers; `type` is derived from `provides.kind`.
 */
export interface ResourceNode<C extends AnyContract = AnyContract> {
  readonly [NODE]: true;
  readonly kind: 'resource';
  /** Human-readable, given at authoring — logs/diagnostics only; identity remains the deploy address (ADR-0006). */
  readonly name: string;
  /** The extension package that authored this node, e.g. "@prisma/app-cloud" — the registry key at deploy. */
  readonly extension: string;
  readonly type: C['kind'];
  /** The Contract this resource provides — the resource's single port. */
  readonly provides: C;
}

/**
 * A Service: inputs + its own declared params + how it is built. Inspectable,
 * inert until run, and carries NO runtime handler — an extension's factory
 * wraps it into a runnable/loadable shape (see RunnableServiceNode).
 */
export interface ServiceNode<
  D extends Deps = Deps,
  P extends Params = Params,
  E extends Expose = Expose,
> {
  readonly [NODE]: true;
  readonly kind: 'service';
  /** Human-readable, given at authoring — logs/diagnostics only; identity remains the deploy address (ADR-0006). */
  readonly name: string;
  /** The extension package that authored this node, e.g. "@prisma/app-cloud" — the registry key at deploy. */
  readonly extension: string;
  readonly type: string;
  readonly inputs: D;
  /** Service-level config declarations (e.g. port). */
  readonly params: P;
  /** How the app's entry is built + assembled. */
  readonly build: BuildAdapter;
  /** Named output ports this service exposes — the Contracts a consumer's `rpc(contract)` can require. `undefined` when the service exposes nothing. */
  readonly expose: E | undefined;
}

/**
 * The extension's runnable/loadable service node. `run` boots the app after
 * deserializing its Config; `load`/`config` then read deps/params back out
 * (kept separate per ADR-0021 so a same-named dep and param never collide).
 */
export interface RunnableServiceNode<
  D extends Deps = Deps,
  P extends Params = Params,
  E extends Expose = Expose,
> extends ServiceNode<D, P, E> {
  run(address: string, boot: () => Promise<unknown>): Promise<unknown>;
  load(): HydratedDeps<D>;
  config(): Values<P>;
}

/**
 * A service's dependency slot. At Load the enclosing system wires a
 * producer's ref into it; at run it hydrates a client via Connection. `Req`
 * is the required contract (`unknown` for an untyped end like `http()`).
 */
export interface DependencyEnd<C = unknown, Req = unknown> {
  readonly [NODE]: true;
  readonly kind: 'dependency';
  /** Human-readable, given at authoring — logs/diagnostics only. */
  readonly name: string;
  readonly type: string;
  readonly connection: Connection<Params, C>;
  /** The required contract, or `undefined` for an untyped end (e.g. `http()`). */
  readonly required: Req | undefined;
}

/** A System: the same Deps/Expose boundary a service has, around transparent wiring instead of a black-box body — its `body` runs at Load, not at authoring. */
export interface SystemNode<D extends Deps = Deps, E extends Expose = Expose> {
  readonly [NODE]: true;
  readonly kind: 'system';
  /** Human-readable, given at authoring — logs/diagnostics only. */
  readonly name: string;
  readonly deps: D;
  readonly expose: E;
  body(ctx: SystemContext<D>): SystemOutputs<E>;
}

/**
 * What a system's body receives: its declared inputs as forwardable wiring
 * values, plus `provision` to register the owned services/systems it wires them into.
 */
export interface SystemContext<D extends Deps> {
  /** The system's declared inputs as wiring values — pass them into provision(). */
  readonly inputs: { [K in keyof D]: InputRef<D[K]> };
  /** Registers an owned child (service or system) under a stable id. */
  readonly provision: SystemBuilder['provision'];
}

/**
 * A system's forwarded-input value: the same ref-port shape a producer's
 * output carries, so it flows down a nested `provision()` call indistinguishably
 * from a sibling's exposed port.
 */
export type InputRef<DE> =
  // biome-ignore lint/suspicious/noExplicitAny: matches ReqOf's bound.
  DE extends DependencyEnd<any, infer Req extends AnyContract> ? RefPort<Req> : never;

/** One ref-port per declared expose key, contract-checked against `E` (mirrors `Wiring`'s `NoInfer` use). */
export type SystemOutputs<E extends Expose> = { [P in keyof E]: RefPort<NoInfer<E[P]>> };

/**
 * A provisioned producer's port as a wiring-time value: its contract, tagged
 * with which provider produced it (`__providerId`, read by Load to resolve the edge).
 */
export type RefPort<C extends AnyContract> = C & { readonly __providerId: string };

/**
 * What `provision(id, service)` hands back: a stable id plus one ref-port per
 * exposed contract. `provision(id, resource)` returns the same shape with the
 * resource's one port flattened onto the ref itself.
 */
export type ProvisionedRef<E extends Expose = Record<never, never>> = { readonly id: string } & {
  readonly [P in keyof E]: RefPort<E[P]>;
};

/** A DependencyEnd's required contract (unknown for an untyped end). */
// biome-ignore lint/suspicious/noExplicitAny: generic DependencyEnd bound — Req is opaque here.
type ReqOf<DE> = DE extends DependencyEnd<any, infer Req> ? Req : never;

/** `provision`'s wiring argument: one producer ref per dependency slot, checked against its required contract. */
type Wiring<D extends Deps> = { [K in keyof D]: NoInfer<ReqOf<D[K]>> };

export interface SystemBuilder {
  /** Provisions an owned resource under a stable id, returning its ref for wiring into a consumer. */
  provision<C extends AnyContract>(
    id: string,
    resource: ResourceNode<C>,
  ): { readonly id: string } & RefPort<C>;
  /** Registers an owned service under a stable id, returning a ref carrying its exposed ports. */
  provision<E extends Expose>(
    id: string,
    // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete service node; ServiceNode generics are invariant so `any` is required.
    service: ServiceNode<any, any, E>,
  ): ProvisionedRef<E>;
  /** Registers an owned service under a stable id, wiring a producer ref into each of its dependency slots. */
  provision<D extends Deps, E extends Expose>(
    id: string,
    // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete service node; ServiceNode generics are invariant so `any` is required.
    service: ServiceNode<D, any, E>,
    wiring: Wiring<D>,
  ): ProvisionedRef<E>;
  /** Registers an owned child system under a stable id — same call shape as the no-wiring service overload. */
  provision<D extends Deps, E extends Expose>(
    id: string,
    child: SystemNode<D, E>,
  ): ProvisionedRef<E>;
  /** Registers an owned child system under a stable id, wiring a producer ref into each of its declared deps. */
  provision<D extends Deps, E extends Expose>(
    id: string,
    child: SystemNode<D, E>,
    wiring: Wiring<D>,
  ): ProvisionedRef<E>;
  /** Same as the id-first overloads, but the child's own `name` becomes its id. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque per-contract Cmp — matches RefPort's own `any` bound.
  provision<C extends Contract<any, any>>(
    resource: ResourceNode<C>,
  ): { readonly id: string } & RefPort<C>;
  provision<E extends Expose>(
    // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete service node; ServiceNode generics are invariant so `any` is required.
    service: ServiceNode<any, any, E>,
  ): ProvisionedRef<E>;
  provision<D extends Deps, E extends Expose>(
    // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete service node; ServiceNode generics are invariant so `any` is required.
    service: ServiceNode<D, any, E>,
    wiring: Wiring<D>,
  ): ProvisionedRef<E>;
  provision<D extends Deps, E extends Expose>(child: SystemNode<D, E>): ProvisionedRef<E>;
  provision<D extends Deps, E extends Expose>(
    child: SystemNode<D, E>,
    wiring: Wiring<D>,
  ): ProvisionedRef<E>;
}

/** Dependency map: name → the slot the service declares. Only declarations are admitted, never a concrete ResourceNode. */
// biome-ignore lint/suspicious/noExplicitAny: `any` (not `unknown`) preserves loaded-dep inference from each entry's hydrate return.
export type Deps = Record<string, DependencyEnd<any, any>>;

/** Output-port map: name → the Contract a service exposes for others to depend on. */
export type Expose = Readonly<Record<string, AnyContract>>;

export type Hydrated<N> =
  // biome-ignore lint/suspicious/noExplicitAny: Req is irrelevant to the hydrated shape.
  N extends DependencyEnd<infer C, any> ? C : never;
export type HydratedDeps<D extends Deps> = { readonly [K in keyof D]: Hydrated<D[K]> };

function requireType(type: string, factory: string): void {
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error(`${factory}() requires a non-empty node type.`);
  }
}

function requireName(name: string, factory: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${factory}() requires a non-empty name.`);
  }
}

function requireExtension(extension: string, factory: string): void {
  if (typeof extension !== 'string' || extension.length === 0) {
    throw new Error(
      `${factory}() requires a non-empty extension (the authoring extension's package name).`,
    );
  }
}

/**
 * Config keys join address/input/param names with "_" and uppercase — an
 * underscore inside a name would collide with that separator (e.g. param
 * "db_url" vs input "db"'s param "url" both hitting env key "DB_URL").
 */
function requireNoUnderscoreName(name: string, kind: 'input' | 'param', factory: string): void {
  if (name.includes('_')) {
    throw new Error(
      `${factory}() ${kind} name "${name}" may not contain "_" — config keys join names with ` +
        '"_" as the separator (e.g. an input "db"\'s param "url" becomes env key "DB_URL"), so ' +
        'an underscore inside a name would collide with that separator.',
    );
  }
}

function requireNoUnderscoreNames(
  names: Iterable<string>,
  kind: 'input' | 'param',
  factory: string,
): void {
  for (const name of names) requireNoUnderscoreName(name, kind, factory);
}

function freezeParams<P extends Params>(params: P): P {
  const frozen: Record<string, ConfigParam> = {};
  for (const [name, param] of Object.entries(params)) {
    frozen[name] = Object.freeze({ ...param });
  }
  return Object.freeze(frozen) as P;
}

/** A frozen shallow copy that keeps the caller's declared type. */
function frozenShallowCopy<T extends object>(obj: T): T {
  return blindCast<
    T,
    'frozen shallow copy of the caller value; freeze widens the inferred type but the runtime shape is unchanged'
  >(Object.freeze({ ...obj }));
}

/**
 * Seals a node instance after its constructor has assigned all fields — the
 * last statement of a concrete node class's constructor. A free function, not
 * a base-class method, so an instance stays structurally a plain frozen node.
 */
export function freezeNode<T extends object>(node: T): T {
  Object.freeze(node);
  return node;
}

/**
 * Everything `resource()` establishes, minus the freeze — an extension
 * whose resource node carries extra fields extends this, assigns them, and
 * calls `freezeNode(this)` as its constructor's last statement.
 */
export abstract class ResourceNodeBase<C extends AnyContract = AnyContract>
  implements ResourceNode<C>
{
  readonly [NODE] = true as const;
  readonly kind = 'resource' as const;
  readonly name: string;
  readonly extension: string;
  readonly type: C['kind'];
  readonly provides: C;

  constructor(def: { name: string; extension: string; provides: C }) {
    requireName(def.name, 'resource');
    requireExtension(def.extension, 'resource');
    const provides = def.provides;
    if (
      typeof provides !== 'object' ||
      provides === null ||
      typeof provides.kind !== 'string' ||
      provides.kind.length === 0 ||
      typeof provides.satisfies !== 'function'
    ) {
      throw new Error(
        'resource() requires `provides` — the Contract this resource offers ' +
          '(a non-empty `kind` plus its `satisfies()`).',
      );
    }
    this.name = def.name;
    this.extension = def.extension;
    this.type = provides.kind;
    this.provides = provides;
  }
}

/** The core leaf: exactly the base, frozen. */
class FrozenResourceNode<C extends AnyContract> extends ResourceNodeBase<C> {
  constructor(def: { name: string; extension: string; provides: C }) {
    super(def);
    freezeNode(this);
  }
}

/**
 * Constructs a branded, frozen Resource node — an identity plus the Contract
 * it provides; the routing `type` is the contract's `kind`. Pure — nothing
 * is provisioned until a system provisions it.
 */
export function resource<C extends AnyContract>(def: {
  name: string;
  extension: string;
  provides: C;
}): ResourceNode<C> {
  return new FrozenResourceNode(def);
}

/**
 * Constructs a branded, frozen Service node — declarations only (inputs,
 * params, build adapter, and the ports it exposes). Pure; carries no runtime handler.
 */
export function service<
  D extends Deps,
  P extends Params,
  E extends Expose = Record<never, never>,
>(def: {
  name: string;
  extension: string;
  type: string;
  inputs: D;
  params: P;
  build: BuildAdapter;
  expose?: E;
}): ServiceNode<D, P, E> {
  requireName(def.name, 'service');
  requireExtension(def.extension, 'service');
  requireType(def.type, 'service');
  requireNoUnderscoreNames(Object.keys(def.inputs), 'input', 'service');
  requireNoUnderscoreNames(Object.keys(def.params), 'param', 'service');
  return Object.freeze({
    [NODE]: true as const,
    kind: 'service' as const,
    name: def.name,
    extension: def.extension,
    type: def.type,
    inputs: frozenShallowCopy(def.inputs),
    params: freezeParams(def.params),
    build: Object.freeze({ ...def.build }),
    expose: def.expose !== undefined ? frozenShallowCopy(def.expose) : undefined,
  });
}

/**
 * Constructs a branded, frozen DependencyEnd. `required` (if given) is the
 * contract Load compares a wired ref against via `satisfies()`; an unnamed
 * end's diagnostic `name` falls back to its `type`.
 */
export function dependency<P extends Params, C, Req = unknown>(def: {
  name?: string;
  type: string;
  connection: Connection<P, C>;
  required?: Req;
}): DependencyEnd<C, Req> {
  requireType(def.type, 'dependency');
  requireNoUnderscoreNames(Object.keys(def.connection.params), 'param', 'dependency');
  const connection: Connection<P, C> = Object.freeze({
    params: freezeParams(def.connection.params),
    hydrate: def.connection.hydrate,
  });
  return Object.freeze({
    [NODE]: true as const,
    kind: 'dependency' as const,
    name: def.name !== undefined && def.name.length > 0 ? def.name : def.type,
    type: def.type,
    connection: connection as Connection<Params, C>,
    required: def.required,
  });
}

/**
 * A closed root: no `deps`, no `expose`, nothing wiring in or out. The body
 * only provisions and needs no return. Omitting the boundary argument IS the
 * closed-root shape — `system(name, body)` instead of `system(name, {}, () =>
 * ({}))`.
 */
export function system(
  name: string,
  body: (ctx: SystemContext<Record<never, never>>) => void,
): SystemNode<Record<never, never>, Record<never, never>>;
/**
 * A system with a boundary: `deps` and/or `expose` declare what wires in and
 * out, the same way a service does. The body returns one port per `expose` key.
 */
export function system<
  D extends Deps = Record<never, never>,
  E extends Expose = Record<never, never>,
>(
  name: string,
  boundary: { deps?: D; expose?: E },
  body: (ctx: SystemContext<D>) => SystemOutputs<E>,
): SystemNode<D, E>;
/**
 * Constructs a branded, frozen System node. Construction is INERT — the body is
 * wiring, not user code, and runs only when the system is Loaded.
 */
export function system(
  name: string,
  boundaryOrBody: { deps?: Deps; expose?: Expose } | ((ctx: SystemContext<Deps>) => void),
  maybeBody?: (ctx: SystemContext<Deps>) => SystemOutputs<Expose>,
): SystemNode {
  requireName(name, 'system');
  const closedRoot = typeof boundaryOrBody === 'function';
  const boundary = closedRoot ? {} : boundaryOrBody;
  const deps = frozenShallowCopy(boundary.deps ?? {});
  const expose = frozenShallowCopy(boundary.expose ?? {});
  const body: (ctx: SystemContext<Deps>) => SystemOutputs<Expose> = closedRoot
    ? (ctx) => {
        boundaryOrBody(ctx);
        return {};
      }
    : // biome-ignore lint/style/noNonNullAssertion: the non-function overload always passes a third argument.
      maybeBody!;
  return Object.freeze({
    [NODE]: true as const,
    kind: 'system' as const,
    name,
    deps,
    expose,
    body,
  });
}

/**
 * True if `value` was constructed by this module's factories. Checks the
 * brand only, never a prototype — a graph may mix nodes from a different
 * installed copy of core (dual-package hazard).
 */
export function isNode(
  value: unknown,
): value is ServiceNode | ResourceNode | DependencyEnd | SystemNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[NODE] === true
  );
}
