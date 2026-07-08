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
import type { ConfigParam, Connection, Params, Values } from './config.ts';

// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
const NODE: unique symbol = Symbol.for('makerkit:node') as never;

export interface NodeBase {
  readonly [NODE]: true;
  readonly kind: 'service' | 'resource' | 'connection';
  /** Routing key, e.g. "prisma-cloud/postgres". */
  readonly type: string;
}

/**
 * A Resource a service depends on, carrying its connection face. C flows from
 * the connection's hydrate return type into the loaded dependency.
 */
export interface ResourceNode<C = unknown> extends NodeBase {
  readonly kind: 'resource';
  readonly connection: Connection<Params, C>;
}

/**
 * How a service's app becomes a runnable artifact. The DESCRIPTOR is pure data
 * the service node carries (rides in service.ts, into every bundle); it names
 * the adapter and the built-entry location, RELATIVE to the service dir — never
 * an absolute or machine path. The heavy assembler is looked up by `kind` at
 * deploy and never ships in a bundle.
 */
export interface BuildAdapter {
  /** Assembler routing key, e.g. "node" · "nextjs". */
  readonly kind: string;
  /** Built runnable, service-dir-relative (e.g. "dist/server.js"). */
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
export interface ServiceNode<D extends Deps = Deps, P extends Params = Params> extends NodeBase {
  readonly kind: 'service';
  readonly inputs: D;
  /** Service-level config declarations (e.g. port). */
  readonly params: P;
  /** How the app's entry is built + assembled. */
  readonly build: BuildAdapter;
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
export interface RunnableServiceNode<D extends Deps = Deps, P extends Params = Params>
  extends ServiceNode<D, P> {
  run(address: string, boot: () => Promise<unknown>): Promise<unknown>;
  load(): Loaded<D, P>;
}

/**
 * A service-to-service dependency end. Sits in a Deps slot like a
 * ResourceNode, but nothing is provisioned FOR it — at deploy it becomes an
 * EDGE to the producer service the enclosing hex wires it to; at run it
 * hydrates a client through exactly the same Connection machinery as a
 * resource. The consumer never learns HOW the producer's address reached it.
 */
export interface ConnectionEnd<C = unknown> extends NodeBase {
  readonly kind: 'connection';
  readonly connection: Connection<Params, C>;
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

export interface HexBuilder {
  /**
   * Registers an owned service under a stable id; `wiring` satisfies the
   * service's ConnectionEnd inputs with previously provisioned producers.
   */
  provision(
    id: string,
    // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete service node; ServiceNode generics are invariant so `any` is required.
    service: ServiceNode<any, any>,
    wiring?: Record<string, ProvisionedRef>,
  ): ProvisionedRef;
}

/** Opaque handle within the hex body. */
export type ProvisionedRef = { readonly id: string };

/** Dependency map: name → what the service consumes. `any`, not `unknown` — keeps inference. */
// biome-ignore lint/suspicious/noExplicitAny: `any` (not `unknown`) preserves loaded-dep inference from each entry's hydrate return.
export type Deps = Record<string, ResourceNode<any> | ConnectionEnd<any>>;

export type Hydrated<N> =
  N extends ResourceNode<infer C> ? C : N extends ConnectionEnd<infer C> ? C : never;
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

function freezeParams<P extends Params>(params: P): P {
  const frozen: Record<string, ConfigParam> = {};
  for (const [name, param] of Object.entries(params)) {
    frozen[name] = Object.freeze({ ...param });
  }
  return Object.freeze(frozen) as P;
}

/** Constructs a branded, frozen Resource node. Pure — nothing executes. */
export function resource<P extends Params, C>(def: {
  type: string;
  connection: Connection<P, C>;
}): ResourceNode<C> {
  requireType(def.type, 'resource');
  const connection: Connection<P, C> = Object.freeze({
    params: freezeParams(def.connection.params),
    hydrate: def.connection.hydrate,
  });
  const node: ResourceNode<C> = {
    [NODE]: true,
    kind: 'resource',
    type: def.type,
    connection: connection as Connection<Params, C>,
  };
  return Object.freeze(node);
}

/**
 * Constructs a branded, frozen Service node — declarations only (inputs, params,
 * build adapter). Pure; carries no handler.
 */
export function service<D extends Deps, P extends Params>(def: {
  type: string;
  inputs: D;
  params: P;
  build: BuildAdapter;
}): ServiceNode<D, P> {
  requireType(def.type, 'service');
  const node: ServiceNode<D, P> = {
    [NODE]: true,
    kind: 'service',
    type: def.type,
    inputs: Object.freeze({ ...def.inputs }) as D,
    params: freezeParams(def.params),
    build: Object.freeze({ ...def.build }),
  };
  return Object.freeze(node);
}

/**
 * Constructs a branded, frozen ConnectionEnd. Pure — nothing executes; the
 * connection's hydrate runs only through the boot pipeline.
 */
export function connectionEnd<P extends Params, C>(def: {
  type: string;
  connection: Connection<P, C>;
}): ConnectionEnd<C> {
  requireType(def.type, 'connectionEnd');
  const connection: Connection<P, C> = Object.freeze({
    params: freezeParams(def.connection.params),
    hydrate: def.connection.hydrate,
  });
  const node: ConnectionEnd<C> = {
    [NODE]: true,
    kind: 'connection',
    type: def.type,
    connection: connection as Connection<Params, C>,
  };
  return Object.freeze(node);
}

/**
 * Constructs a branded, frozen Hex node. Construction is INERT — the body is
 * wiring, not user code, and runs only when the hex is Loaded.
 */
export function hex(name: string, body: (h: HexBuilder) => void): HexNode {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('hex() requires a non-empty name.');
  }
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
