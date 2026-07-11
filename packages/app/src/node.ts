/**
 * Core model: node types and the factories that construct them. All nodes are
 * plain frozen data objects — with two sanctioned behavior slots: a
 * Connection's `hydrate` (validated values → client) and, on the extension's
 * runnable service shape, `run`/`load` (the process controller and its
 * pull-DI). The Service node carries NO handler — it is a description; the
 * code that serves is the app's own entrypoint. Config declarations are pure
 * data; core reads no environment and loads no modules. A node's `extension`
 * + `type` form its control-plane routing key at deploy
 * (`config.extensions[extension].nodes[type]` — see ADR-0017); core never
 * interprets them beyond lookup.
 */
import { blindCast } from './casts.ts';
import type { ConfigParam, Connection, Params, Values } from './config.ts';
import type { Contract } from './contract.ts';

// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
const NODE: unique symbol = Symbol.for('prisma:node') as never;

/** How a service's app becomes a runnable artifact — the build control's routing key (`extension`/`type`) plus paths resolved relative to the authoring module. */
export interface BuildAdapter {
  /** The extension package that provides the build control, e.g. "@prisma/app-node". */
  readonly extension: string;
  /** The build control's node ID within its extension, e.g. "node" · "nextjs". */
  readonly type: string;
  /**
   * The authoring module's `import.meta.url` — every other path on this
   * descriptor resolves relative to `dirname(module)`. Nothing reads it at
   * runtime.
   */
  readonly module: string;
  /**
   * The app's built runnable, resolved relative to `dirname(module)`. The
   * type's build control interprets it. "node": a path to the built server
   * file (e.g. "../dist/server.js"). "nextjs": a bare filename inside the
   * standalone output dir (e.g. "server.js") — see the nextjs adapter's
   * `appDir` for where that output dir itself is anchored.
   */
  readonly entry: string;
}

/**
 * A Resource's identity: the one place a piece of infrastructure exists.
 * Provisioned by a system (`h.provision(id, postgres({ name }))`), never embedded
 * in a service's deps — a service declares a DependencyEnd slot instead and
 * the system wires this node's ref into it. `provides` is the Contract the
 * resource offers consumers (its one port); `type` — the within-extension
 * routing key — is derived from `provides.kind`, so wiring a slot to a
 * resource whose contract doesn't satisfy the slot's requirement fails at
 * compile time and at Load, through exactly the machinery service ports use.
 * `extension` names the extension package whose registry lowers this node.
 */
// biome-ignore lint/suspicious/noExplicitAny: opaque per-contract Cmp — matches Contract's own bound.
export interface ResourceNode<C extends Contract<any, any> = Contract<any, any>> {
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
 * A Service: inputs + its own declared params + how it is built. This IS the
 * user's default export — inspectable (inputs/type/params/build), inert until
 * run. It carries NO handler; the app's own entrypoint is the code that
 * serves. The BASE node is not runnable: booting needs an extension's
 * environment knowledge, so the extension's factory returns a
 * runnable/loadable shape that adds `run`/`load` (see RunnableServiceNode).
 * The node is the handle. `extension` + `type` form the control-plane
 * registry key at deploy; `build.extension` + `build.type` do the same for
 * assembly.
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
 * The extension's runnable/loadable service node — what an extension's
 * authoring factory (e.g. `compute()`) returns. `run(address, boot)` is the
 * process controller: deserialize the platform environment (keyed off
 * `address`, the bootstrap's parameter) into a typed Config, stash it under
 * process-local keys, then call `boot()` to start the app's entry. From inside
 * that entry, `load()` reads the stash and returns the hydrated, memoized
 * dependencies; `config()` returns the resolved, typed config params. The two
 * are separate so a dependency and a param of the same name never collide
 * (ADR-0021). Core defines this shape; only an extension instantiates it.
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
 * A service's dependency declaration — THE slot, whoever the producer is.
 * Nothing is provisioned FOR it: at Load the enclosing system wires a provisioned
 * producer's ref into it (a service's exposed port, or a resource — the
 * contract determines validity, never the producer's kind), and at deploy it
 * becomes an EDGE from that producer to the consumer. At run it hydrates a
 * client through the Connection machinery; the consumer never learns HOW the
 * producer's address reached it. Carries no `extension` — a dependency end
 * is never provisioned, so deploy tooling never routes one to a registry.
 *
 * `Req` is the contract this end requires — `unknown` for an untyped end
 * (e.g. `http()`, the escape hatch that accepts anything). `SystemBuilder.provision`
 * checks each wired ref against `Req` at compile time; `required` carries the
 * same contract as a runtime value so Load can call its `satisfies()` as the
 * backstop.
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
 * values, and `provision` to register the owned services/systems it wires them
 * into. `inputs[K]` stands for "whatever the enclosing scope wires here" —
 * Load resolves it, at the system's own provision() call, to the actual producer
 * the enclosing scope supplied.
 */
export interface SystemContext<D extends Deps> {
  /** The system's declared inputs as wiring values — pass them into provision(). */
  readonly inputs: { [K in keyof D]: InputRef<D[K]> };
  /** Registers an owned child (service or system) under a stable id. */
  readonly provision: SystemBuilder['provision'];
}

/**
 * A system's forwarded-input value: the same ref-port shape a producer's output
 * carries, so it satisfies the identical `Wiring<D>` assignability at any
 * nested `provision()` call — an input flows down by being indistinguishable,
 * at the wiring site, from a sibling's exposed port. Because a dependency
 * slot always carries a contract (resource-backed or service-backed alike —
 * the unified model has no untyped-by-construction resource slot), a
 * resource-backed input forwards across a system boundary exactly like a
 * service-backed one.
 */
export type InputRef<DE> =
  // biome-ignore lint/suspicious/noExplicitAny: matches ReqOf's bound.
  DE extends DependencyEnd<any, infer Req extends Contract<any, any>> ? RefPort<Req> : never;

/** One ref-port per declared expose key, contract-checked against `E` (mirrors `Wiring`'s `NoInfer` use). */
export type SystemOutputs<E extends Expose> = { [P in keyof E]: RefPort<NoInfer<E[P]>> };

/**
 * A provisioned producer's port as a wiring-time value: the port's own
 * contract, tagged with which provider produced it. `provision(id, consumer,
 * wiring)` checks a ref-port's contract against the consumer's required slot
 * (plain assignability); Load reads `__providerId` to resolve the edge and
 * calls the port's own `satisfies()` as the runtime mirror of that check.
 */
// biome-ignore lint/suspicious/noExplicitAny: opaque per-port Cmp — matches Expose's own `any` bound.
export type RefPort<C extends Contract<any, any>> = C & { readonly __providerId: string };

/**
 * What `provision(id, service)` hands back: a stable id — so a service with no
 * exposed ports (or an untyped dependency slot) can still be wired wholesale
 * by passing the ref itself — plus one ref-port per exposed contract (empty
 * when the service declares no `expose`). `provision(id, resource)` returns
 * the same shape with the resource's ONE port — its provided contract —
 * flattened onto the ref itself: `{ id } & RefPort<C>`.
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
  // biome-ignore lint/suspicious/noExplicitAny: opaque per-contract Cmp — matches RefPort's own `any` bound.
  provision<C extends Contract<any, any>>(
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
}

/**
 * Dependency map: name → the slot the service declares. Only declarations
 * are admitted — a concrete ResourceNode never sits in deps, so a service
 * cannot cause infrastructure to exist by mentioning it. `any`, not
 * `unknown` — keeps inference.
 */
// biome-ignore lint/suspicious/noExplicitAny: `any` (not `unknown`) preserves loaded-dep inference from each entry's hydrate return.
export type Deps = Record<string, DependencyEnd<any, any>>;

/** Output-port map: name → the Contract a service exposes for others to depend on. */
// biome-ignore lint/suspicious/noExplicitAny: opaque per-port Cmp — core never inspects it (see Contract).
export type Expose = Readonly<Record<string, Contract<any, any>>>;

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
 * `configKey` (the extension's semantic↔physical config mapping) joins address
 * segments, an input's name, and a param's name with "_" and uppercases the
 * result — so an underscore INSIDE a name is indistinguishable from that
 * separator. Without this check, service param "db_url" and input "db"'s
 * param "url" would both serialize to the env key "DB_URL" and silently
 * collide. Rejected at construction, naming the offender.
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
 * Constructs a branded, frozen Resource node — an identity plus the Contract
 * it provides; the routing `type` is the contract's `kind`. Pure — nothing
 * executes; nothing is provisioned until a system provisions it. `extension`
 * (e.g. "@prisma/app-cloud") keys the control-plane registry lookup at
 * deploy — the extension itself is loaded only by `prisma-app.config.ts`.
 */
// biome-ignore lint/suspicious/noExplicitAny: opaque per-contract Cmp — matches ResourceNode's own bound.
export function resource<C extends Contract<any, any>>(def: {
  name: string;
  extension: string;
  provides: C;
}): ResourceNode<C> {
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
  return Object.freeze({
    [NODE]: true as const,
    kind: 'resource' as const,
    name: def.name,
    extension: def.extension,
    type: provides.kind,
    provides,
  });
}

/**
 * Constructs a branded, frozen Service node — declarations only (inputs, params,
 * build adapter, and the ports it exposes). Pure; carries no handler.
 * `extension` (e.g. "@prisma/app-cloud") keys the control-plane registry
 * lookup at deploy — the extension itself is loaded only by
 * `prisma-app.config.ts`.
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
 * Constructs a branded, frozen DependencyEnd. Pure — nothing executes; the
 * connection's hydrate runs only through the boot pipeline. `required` (if
 * given) is the contract this end depends on — the same value Load compares
 * a wired ref against via `satisfies()`. `name` is diagnostic only and
 * optional — a consumer's dep key (e.g. `deps: { auth: http({ name: "auth" }) }`)
 * already identifies the end at the wiring site; an unnamed end falls back to
 * its `type`.
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
 * Constructs a branded, frozen System node. Construction is INERT — the body is
 * wiring, not user code, and runs only when the system is Loaded. `boundary`
 * declares the system's `Deps`/`Expose` the same way a service does; both are
 * optional — an empty boundary (`system(name, {}, body)`) is the closed,
 * deploy-root form, not a separate shape.
 */
export function system<
  D extends Deps = Record<never, never>,
  E extends Expose = Record<never, never>,
>(
  name: string,
  boundary: { deps?: D; expose?: E },
  body: (ctx: SystemContext<D>) => SystemOutputs<E>,
): SystemNode<D, E> {
  requireName(name, 'system');
  const deps = blindCast<
    D,
    'an omitted `deps` only arises when D itself infers to the empty default'
  >(boundary.deps ?? {});
  const expose = blindCast<
    E,
    'an omitted `expose` only arises when E itself infers to the empty default'
  >(boundary.expose ?? {});
  return Object.freeze({
    [NODE]: true as const,
    kind: 'system' as const,
    name,
    deps: frozenShallowCopy(deps),
    expose: frozenShallowCopy(expose),
    body,
  });
}

/**
 * True if `value` was constructed by this module's factories. Checks the
 * brand ONLY — never a prototype — because a graph may mix nodes built by a
 * different installed copy of core (dual-package hazard); nodes are plain
 * data, so the Symbol.for brand is the whole identity story.
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
