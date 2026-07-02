/**
 * Core model: node types and the factories that construct them. All nodes are
 * plain, frozen, serializable data — with one exception: a Service node
 * carries the user's handler, the single function reference in the model. A
 * node's `type` is its routing key; core never interprets it beyond lookup.
 */

/** JSON-safe config values. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
const NODE: unique symbol = Symbol.for("makerkit:node") as never;

export interface NodeBase {
  readonly [NODE]: true;
  /** "hex" later — an extension point, not built yet. */
  readonly kind: "service" | "resource";
  /** Routing key, e.g. "prisma-cloud/postgres". */
  readonly type: string;
  /** Constructor opts, opaque to core. */
  readonly config?: JsonObject;
}

/**
 * A Resource a service depends on. H is the phantom hydrated-client type:
 * declared type-only, never set at runtime, erased at compile.
 */
export interface ResourceNode<H = unknown> extends NodeBase {
  readonly kind: "resource";
  readonly __hydrated?: H;
}

/**
 * A Service: inputs + the opaque handler. This IS the user's default export —
 * inspectable (inputs/type/config) and runnable (run), inert until invoked.
 * There is no separate handle type: the node is the handle.
 */
export interface ServiceNode<D extends Deps = Deps> extends NodeBase {
  readonly kind: "service";
  readonly inputs: D;
  run(deps: HydratedDeps<D>, ctx: RuntimeContext): unknown;
}

/** Dependency map: name → ResourceNode. `any`, not `unknown` — keeps phantom inference. */
export type Deps = Record<string, ResourceNode<any>>;

export type Hydrated<N> = N extends ResourceNode<infer H> ? H : never;
export type HydratedDeps<D extends Deps> = { readonly [K in keyof D]: Hydrated<D[K]> };

/**
 * What the host provides a running service besides its deps. Core defines the
 * shape; the target's runtime supplies the values.
 */
export interface RuntimeContext {
  readonly port: number;
}

export type ServiceHandler<D extends Deps> = (deps: HydratedDeps<D>, ctx: RuntimeContext) => unknown;

function requireType(type: string, factory: string): void {
  if (typeof type !== "string" || type.length === 0) {
    throw new Error(`${factory}() requires a non-empty node type.`);
  }
}

/** Constructs a branded, frozen Resource node. Pure — nothing executes. */
export function resource<H>(def: { type: string; config?: JsonObject }): ResourceNode<H> {
  requireType(def.type, "resource");
  const node: ResourceNode<H> = {
    [NODE]: true,
    kind: "resource",
    type: def.type,
    ...(def.config !== undefined ? { config: Object.freeze(def.config) } : {}),
  };
  return Object.freeze(node);
}

/**
 * Constructs a branded, frozen Service node; `handler` becomes the node's
 * `run`. Pure — the handler is never called here.
 */
export function service<D extends Deps>(def: {
  type: string;
  inputs: D;
  handler: ServiceHandler<D>;
  config?: JsonObject;
}): ServiceNode<D> {
  requireType(def.type, "service");
  const node: ServiceNode<D> = {
    [NODE]: true,
    kind: "service",
    type: def.type,
    inputs: Object.freeze({ ...def.inputs }) as D,
    ...(def.config !== undefined ? { config: Object.freeze(def.config) } : {}),
    run(deps, ctx) {
      return def.handler(deps, ctx);
    },
  };
  return Object.freeze(node);
}

/** Internal: true if `value` carries the node brand. */
export function isNode(value: unknown): value is NodeBase {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[NODE] === true
  );
}
