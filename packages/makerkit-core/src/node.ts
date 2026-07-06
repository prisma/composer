/**
 * Core model: node types and the factories that construct them. All nodes are
 * plain, frozen, serializable data — with exactly three sanctioned behavior
 * slots hanging off the graph: the Service node's handler (`run`), a
 * Connection's `hydrate` (validated values → client), and the Service's
 * ConfigAdapter (the platform's config I/O). Config declarations are pure
 * data; only the adapter touches a real environment. A node's `type` is its
 * routing key at deploy; core never interprets it beyond lookup.
 */
import type { ConfigAdapter, ConfigParam, Connection, Params, Values } from "./config.ts";

// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
const NODE: unique symbol = Symbol.for("makerkit:node") as never;

export interface NodeBase {
  readonly [NODE]: true;
  /** "hex" later — an extension point, not built yet. */
  readonly kind: "service" | "resource";
  /** Routing key, e.g. "prisma-cloud/postgres". */
  readonly type: string;
}

/**
 * A Resource a service depends on, carrying its connection face. C flows from
 * the connection's hydrate return type into the handler's parameter.
 */
export interface ResourceNode<C = unknown> extends NodeBase {
  readonly kind: "resource";
  readonly connection: Connection<Params, C>;
}

/**
 * A Service: inputs + its own declared params + the platform's ConfigAdapter
 * + the opaque handler. This IS the user's default export — inspectable
 * (inputs/type/params) and runnable (run), inert until invoked. There is no
 * separate handle type: the node is the handle.
 */
export interface ServiceNode<D extends Deps = Deps, P extends Params = Params> extends NodeBase {
  readonly kind: "service";
  readonly inputs: D;
  /** Service-level config declarations (e.g. port). */
  readonly params: P;
  /** How this service GETS its config on this platform. */
  readonly config: ConfigAdapter;
  run(deps: HydratedDeps<D>, ctx: Values<P>): unknown;
}

/** Dependency map: name → ResourceNode. `any`, not `unknown` — keeps inference. */
export type Deps = Record<string, ResourceNode<any>>;

export type Hydrated<N> = N extends ResourceNode<infer C> ? C : never;
export type HydratedDeps<D extends Deps> = { readonly [K in keyof D]: Hydrated<D[K]> };

/**
 * ctx is nothing special: the service's own resolved params, typed by its
 * declaration.
 */
export type ServiceHandler<D extends Deps, P extends Params> = (
  deps: HydratedDeps<D>,
  ctx: Values<P>,
) => unknown;

function requireType(type: string, factory: string): void {
  if (typeof type !== "string" || type.length === 0) {
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
  requireType(def.type, "resource");
  const connection: Connection<P, C> = Object.freeze({
    params: freezeParams(def.connection.params),
    hydrate: def.connection.hydrate,
  });
  const node: ResourceNode<C> = {
    [NODE]: true,
    kind: "resource",
    type: def.type,
    connection: connection as Connection<Params, C>,
  };
  return Object.freeze(node);
}

/**
 * Constructs a branded, frozen Service node; `handler` becomes the node's
 * `run`. Pure — the handler is never called here.
 */
export function service<D extends Deps, P extends Params>(def: {
  type: string;
  inputs: D;
  params: P;
  config: ConfigAdapter;
  handler: ServiceHandler<D, P>;
}): ServiceNode<D, P> {
  requireType(def.type, "service");
  const node: ServiceNode<D, P> = {
    [NODE]: true,
    kind: "service",
    type: def.type,
    inputs: Object.freeze({ ...def.inputs }) as D,
    params: freezeParams(def.params),
    config: def.config,
    run(deps, ctx) {
      return def.handler(deps, ctx);
    },
  };
  return Object.freeze(node);
}

/** True if `value` is a node constructed by the service()/resource() factories. */
export function isNode(value: unknown): value is NodeBase {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[NODE] === true
  );
}
