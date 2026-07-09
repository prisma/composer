/**
 * Core model: node types and the factories that construct them. All nodes are
 * plain, frozen, serializable data — with two sanctioned behavior slots: a
 * Connection's `hydrate` (validated values → client) and, on the target pack's
 * runnable service subclass, `run`/`load` (the process controller and its
 * pull-DI). The Service node carries NO handler — it is a description; the code
 * that serves is the app's own entrypoint. Config declarations are pure data;
 * core reads no environment. A node's `type` is its routing key at deploy;
 * core never interprets it beyond lookup.
 */
import { blindCast } from './casts.ts';
import type { ConfigParam, Connection, Params, Values } from './config.ts';
import type { Contract } from './contract.ts';

// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
const NODE: unique symbol = Symbol.for('makerkit:node') as never;

export interface NodeBase {
  readonly [NODE]: true;
  readonly kind: 'service' | 'resource' | 'connection';
  /** Human-readable, given at authoring — logs/diagnostics only; identity remains the deploy address (ADR-0006). */
  readonly name: string;
  /**
   * The node's OWN routing key, unqualified (e.g. "postgres", "compute") —
   * never carries a pack prefix. Deploy tooling routes on the (pack, type)
   * pair: `pack` (PackAuthoredNode) selects the target; `type` selects that
   * target's lowering table entry within it.
   */
  readonly type: string;
}

/**
 * Shared base for pack-authored nodes — a service or resource constructed by
 * a target pack's own factory, stamped with that pack's package name. Deploy
 * tooling reads `pack` off the loaded graph to resolve `${pack}/target`
 * (ADR-0003). ConnectionEnd stays pack-less: `rpc(contract)` builds one from a
 * contract alone, with no pack in scope to supply one, and nothing is
 * provisioned for a connection end — only provisioned nodes route through a
 * target.
 */
export interface PackAuthoredNode extends NodeBase {
  /** The pack package name that authored this node, e.g. "@makerkit/prisma-cloud". */
  readonly pack: string;
}

/**
 * A Resource a service depends on, carrying its connection face. C flows from
 * the connection's hydrate return type into the loaded dependency.
 */
export interface ResourceNode<C = unknown> extends PackAuthoredNode {
  readonly kind: 'resource';
  readonly connection: Connection<Params, C>;
}

/**
 * How a service's app becomes a runnable artifact. The DESCRIPTOR is pure data
 * the service node carries (rides in service.ts, into every bundle); it names
 * the adapter, the authoring module, and the built-entry location. `entry`
 * (and any other kind-specific path field, e.g. nextjs's `appDir`) resolves
 * RELATIVE TO `dirname(module)` — exactly like an import specifier — never an
 * absolute or machine path. `module` (the authoring module's
 * `import.meta.url`) is the one sanctioned exception to that rule (ADR-0004):
 * deploy-time metadata only, and bundlers preserve it as an expression rather
 * than a literal, so it re-evaluates inside the deploy artifact instead of
 * baking in a dev-machine path. The heavy assembler is resolved from `pack` at
 * deploy (`${pack}/assemble`, entry-anchored — same mechanism as a target
 * pack's `${pack}/target`) and never ships in a bundle.
 */
export interface BuildAdapter {
  /** Assembler routing key, e.g. "node" · "nextjs" — the resolved module's own discriminant, checked against this. */
  readonly kind: string;
  /**
   * The package name of the adapter that authored this descriptor, e.g.
   * "@makerkit/node" — baked in by the adapter's own factory (`node()`,
   * `nextjs()`), the same uniform rule `PackAuthoredNode.pack` follows: a
   * thing's `pack` names the package that gives it meaning. Deploy tooling
   * resolves `${pack}/assemble` from it — never a hardcoded kind→package map —
   * so a community build adapter works with zero changes to core or the CLI.
   */
  readonly pack: string;
  /**
   * The authoring module's `import.meta.url` — every other path on this
   * descriptor resolves relative to `dirname(module)`. Nothing reads it at
   * runtime.
   */
  readonly module: string;
  /**
   * The app's built runnable, resolved relative to `dirname(module)`. The
   * kind's assembler interprets it. "node": a path to the built server file
   * (e.g. "../dist/server.js"). "nextjs": a bare filename inside the
   * standalone output dir (e.g. "server.js") — see the nextjs adapter's
   * `appDir` for where that output dir itself is anchored.
   */
  readonly entry: string;
}

/**
 * A Service: inputs + its own declared params + how it is built. This IS the
 * user's default export — inspectable (inputs/type/params/build), inert until
 * run. It carries NO handler; the app's own entrypoint is the code that serves.
 * The BASE node is not runnable: booting needs a target's environment
 * knowledge, so the pack's factory returns a runnable/loadable subclass that
 * adds `run`/`load` (see RunnableServiceNode). The node is the handle.
 */
export interface ServiceNode<
  D extends Deps = Deps,
  P extends Params = Params,
  E extends Expose = Expose,
> extends PackAuthoredNode {
  readonly kind: 'service';
  readonly inputs: D;
  /** Service-level config declarations (e.g. port). */
  readonly params: P;
  /** How the app's entry is built + assembled. */
  readonly build: BuildAdapter;
  /** Named output ports this service exposes — the Contracts a consumer's `rpc(contract)` can require. `undefined` when the service exposes nothing. */
  readonly expose: E | undefined;
}

/**
 * The pack's runnable/loadable service node — what a pack's authoring factory
 * (e.g. `compute()`) returns. `run(address, boot)` is the process controller:
 * deserialize the platform environment (keyed off `address`, the bootstrap's
 * parameter) into a typed Config, stash it under process-local keys, then call
 * `boot()` to start the app's entry. `load()` — called from inside that entry —
 * reads the stash, hydrates + memoizes the deps, and returns them typed. Core
 * defines this shape; only a target pack instantiates it.
 */
export interface RunnableServiceNode<
  D extends Deps = Deps,
  P extends Params = Params,
  E extends Expose = Expose,
> extends ServiceNode<D, P, E> {
  run(address: string, boot: () => Promise<unknown>): Promise<unknown>;
  load(): Loaded<D, P>;
}

/**
 * A service-to-service dependency end. Sits in a Deps slot like a
 * ResourceNode, but nothing is provisioned FOR it — at deploy it becomes an
 * EDGE to the producer service the enclosing hex wires it to; at run it
 * hydrates a client through exactly the same Connection machinery as a
 * resource. The consumer never learns HOW the producer's address reached it.
 *
 * `Req` is the contract this end requires — `unknown` for an untyped end
 * (e.g. `http()`, the escape hatch that accepts anything). `HexBuilder.provision`
 * checks each wired ref-port against `Req` at compile time; `required` carries
 * the same contract as a runtime value so Load can call its `satisfies()` as
 * the backstop.
 */
export interface ConnectionEnd<C = unknown, Req = unknown> extends NodeBase {
  readonly kind: 'connection';
  readonly connection: Connection<Params, C>;
  /** The required contract, or `undefined` for an untyped end (e.g. `http()`). */
  readonly required: Req | undefined;
}

/**
 * A Hex: transparent wiring, no code of its own. The body runs at Load (it
 * is wiring, not user code) and provisions the services it owns, supplying a
 * producer for every ConnectionEnd input. Minimal form — boundary ports and
 * nesting arrive with full Hex composition.
 */
export interface HexNode {
  readonly [NODE]: true;
  readonly kind: 'hex';
  readonly name: string;
  body(h: HexBuilder): void;
}

/**
 * A provisioned producer's exposed port as a wiring-time value: the port's own
 * contract, tagged with which provider produced it. `provision(id, consumer,
 * wiring)` checks a ref-port's contract against the consumer's required slot
 * (plain assignability); Load reads `__providerId` to resolve the edge and
 * calls the port's own `satisfies()` as the runtime mirror of that check.
 */
// biome-ignore lint/suspicious/noExplicitAny: opaque per-port Cmp — matches Expose's own `any` bound.
export type RefPort<C extends Contract<any, any>> = C & { readonly __providerId: string };

/**
 * What `provision(id, service)` hands back: a stable id — so a service with no
 * exposed ports (or an untyped ConnectionEnd slot) can still be wired
 * wholesale by passing the ref itself — plus one ref-port per exposed
 * contract (empty when the service declares no `expose`).
 */
export type ProvisionedRef<E extends Expose = Record<never, never>> = { readonly id: string } & {
  readonly [P in keyof E]: RefPort<E[P]>;
};

/** A ConnectionEnd's required contract (unknown for an untyped end). */
// biome-ignore lint/suspicious/noExplicitAny: generic ConnectionEnd bound — Req is opaque here.
type ReqOf<CE> = CE extends ConnectionEnd<any, infer Req> ? Req : never;

/** The wireable (ConnectionEnd) keys of a Deps map — resource inputs are never wired here. */
type ConnectionKeys<D extends Deps> = {
  // biome-ignore lint/suspicious/noExplicitAny: matches ReqOf's bound.
  [K in keyof D]: D[K] extends ConnectionEnd<any, any> ? K : never;
}[keyof D];

/**
 * `HexBuilder.provision`'s wiring argument: one ref-port per ConnectionEnd
 * input, each required to be assignable to that input's required contract.
 * `NoInfer` keeps the brand honest — without it, an incompatible ref would
 * just widen the inferred required type instead of failing.
 */
type Wiring<D extends Deps> = { [K in ConnectionKeys<D>]: NoInfer<ReqOf<D[K]>> };

export interface HexBuilder {
  /**
   * Registers an owned service under a stable id, returning a ref carrying
   * its exposed ports (if any) for a later provision() to wire in. Also the
   * form for a service with ConnectionEnd inputs left for the runtime dangling
   * check to catch — TypeScript cannot see whether a service's own inputs got
   * wired anywhere else in the body, only Load can.
   */
  provision<E extends Expose>(
    id: string,
    // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete service node; ServiceNode generics are invariant so `any` is required.
    service: ServiceNode<any, any, E>,
  ): ProvisionedRef<E>;
  /**
   * Registers an owned service under a stable id; `wiring` supplies a
   * producer's ref-port for each of the service's ConnectionEnd inputs.
   * TypeScript checks each against that input's required contract — an
   * untyped input's Req is `unknown`, so it accepts anything (http()'s escape
   * hatch); Load re-checks the same relation via the port's `satisfies()`.
   */
  provision<D extends Deps, E extends Expose>(
    id: string,
    // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete service node; ServiceNode generics are invariant so `any` is required.
    service: ServiceNode<D, any, E>,
    wiring: Wiring<D>,
  ): ProvisionedRef<E>;
}

/** Dependency map: name → what the service consumes. `any`, not `unknown` — keeps inference. */
// biome-ignore lint/suspicious/noExplicitAny: `any` (not `unknown`) preserves loaded-dep inference from each entry's hydrate return.
export type Deps = Record<string, ResourceNode<any> | ConnectionEnd<any, any>>;

/** Output-port map: name → the Contract a service exposes for others to depend on. */
// biome-ignore lint/suspicious/noExplicitAny: opaque per-port Cmp — core never inspects it (see Contract).
export type Expose = Readonly<Record<string, Contract<any, any>>>;

export type Hydrated<N> =
  N extends ResourceNode<infer C>
    ? C
    : // biome-ignore lint/suspicious/noExplicitAny: Req is irrelevant to the hydrated shape.
      N extends ConnectionEnd<infer C, any>
      ? C
      : never;
export type HydratedDeps<D extends Deps> = { readonly [K in keyof D]: Hydrated<D[K]> };

/**
 * What load() returns: the hydrated deps and the service's resolved params,
 * merged for ergonomics (`const { db, port } = service.load()`). Dep and param
 * names are expected distinct; the merge is the surface the app entry consumes.
 */
export type Loaded<D extends Deps, P extends Params> = HydratedDeps<D> & Values<P>;

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

function requirePack(pack: string, factory: string): void {
  if (typeof pack !== 'string' || pack.length === 0) {
    throw new Error(`${factory}() requires a non-empty pack (the authoring pack's package name).`);
  }
}

/**
 * `configKey` (the pack's semantic↔physical config mapping) joins address
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

/** Constructs a branded, frozen Resource node. Pure — nothing executes. */
export function resource<P extends Params, C>(def: {
  name: string;
  pack: string;
  type: string;
  connection: Connection<P, C>;
}): ResourceNode<C> {
  requireName(def.name, 'resource');
  requirePack(def.pack, 'resource');
  requireType(def.type, 'resource');
  requireNoUnderscoreNames(Object.keys(def.connection.params), 'param', 'resource');
  const connection: Connection<P, C> = Object.freeze({
    params: freezeParams(def.connection.params),
    hydrate: def.connection.hydrate,
  });
  const node: ResourceNode<C> = {
    [NODE]: true,
    kind: 'resource',
    name: def.name,
    pack: def.pack,
    type: def.type,
    connection: connection as Connection<Params, C>,
  };
  return Object.freeze(node);
}

/**
 * Constructs a branded, frozen Service node — declarations only (inputs, params,
 * build adapter, and the ports it exposes). Pure; carries no handler.
 */
export function service<
  D extends Deps,
  P extends Params,
  E extends Expose = Record<never, never>,
>(def: {
  name: string;
  pack: string;
  type: string;
  inputs: D;
  params: P;
  build: BuildAdapter;
  expose?: E;
}): ServiceNode<D, P, E> {
  requireName(def.name, 'service');
  requirePack(def.pack, 'service');
  requireType(def.type, 'service');
  requireNoUnderscoreNames(Object.keys(def.inputs), 'input', 'service');
  requireNoUnderscoreNames(Object.keys(def.params), 'param', 'service');
  const node: ServiceNode<D, P, E> = {
    [NODE]: true,
    kind: 'service',
    name: def.name,
    pack: def.pack,
    type: def.type,
    inputs: frozenShallowCopy(def.inputs),
    params: freezeParams(def.params),
    build: Object.freeze({ ...def.build }),
    expose: def.expose !== undefined ? frozenShallowCopy(def.expose) : undefined,
  };
  return Object.freeze(node);
}

/**
 * Constructs a branded, frozen ConnectionEnd. Pure — nothing executes; the
 * connection's hydrate runs only through the boot pipeline. `required` (if
 * given) is the contract this end depends on — the same value Load compares
 * a wired ref-port against via `satisfies()`. `name` is diagnostic only and
 * optional — a consumer's dep key (e.g. `deps: { auth: http({ name: "auth" }) }`)
 * already identifies the end at the wiring site; an unnamed end falls back to
 * its `type`.
 */
export function connectionEnd<P extends Params, C, Req = unknown>(def: {
  name?: string;
  type: string;
  connection: Connection<P, C>;
  required?: Req;
}): ConnectionEnd<C, Req> {
  requireType(def.type, 'connectionEnd');
  requireNoUnderscoreNames(Object.keys(def.connection.params), 'param', 'connectionEnd');
  const connection: Connection<P, C> = Object.freeze({
    params: freezeParams(def.connection.params),
    hydrate: def.connection.hydrate,
  });
  const node: ConnectionEnd<C, Req> = {
    [NODE]: true,
    kind: 'connection',
    name: def.name !== undefined && def.name.length > 0 ? def.name : def.type,
    type: def.type,
    connection: connection as Connection<Params, C>,
    required: def.required,
  };
  return Object.freeze(node);
}

/**
 * Constructs a branded, frozen Hex node. Construction is INERT — the body is
 * wiring, not user code, and runs only when the hex is Loaded.
 */
export function hex(name: string, body: (h: HexBuilder) => void): HexNode {
  requireName(name, 'hex');
  const node: HexNode = {
    [NODE]: true,
    kind: 'hex',
    name,
    body,
  };
  return Object.freeze(node);
}

/**
 * True if `value` was constructed by this module's factories. Includes hexes:
 * a HexNode carries the same brand even though it is not a routable NodeBase.
 */
export function isNode(value: unknown): value is NodeBase | HexNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[NODE] === true
  );
}
