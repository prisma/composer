/**
 * Core model: node types and the factories that construct them, plain frozen
 * data objects. A node's `extension` + `type` form its deploy-time registry key (ADR-0017).
 */
import { blindCast } from '@internal/foundation/casts';
import type { SecretString } from '@internal/foundation/secret';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ConfigParam, Connection, Params, Values } from './config.ts';
import type { Contract } from './contract.ts';

// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
// Exported as a TYPE only: an extension pack that implements a node interface
// as a concrete class (rather than building a plain object via these
// factories) needs the brand nameable to `implements` it honestly (its
// `declare readonly [NODE]: true` member) — and nothing more. The value is
// already globally reachable via Symbol.for, so a value export adds nothing.
const NODE = Symbol.for('prisma:node');

export type { NODE };

// A secret slot rides its OWN brand + field, structurally distinct from deps and
// params (ADR-0029): sensitivity is by type, not a flag. `secret()` is the NEED
// (a nameless slot); `envSecret('NAME')` is the SOURCE (the platform name the
// root binds it to) — the same need-vs-source split as rpc(contract) vs a
// producer's exposed port.
const SECRET_NEED: unique symbol = blindCast<never, 'unique-symbol brand for a secret need'>(
  Symbol.for('prisma:secret-need'),
);
const SECRET_SOURCE: unique symbol = blindCast<never, 'unique-symbol brand for a secret source'>(
  Symbol.for('prisma:secret-source'),
);

/** A declared secret input slot — nameless; the root binds it and the topology forwards it in. */
export interface SecretNeed {
  readonly [SECRET_NEED]: true;
  readonly kind: 'secret';
}

/** A service/module's secret slots: name → the need it declares. */
export type Secrets = Record<string, SecretNeed>;

/** The wiring value bound to a secret slot: a target-defined payload core forwards but never inspects. A target (e.g. @prisma/composer-prisma-cloud's `envSecret`) builds one via `secretSource()`. */
export interface SecretSource<T = unknown> {
  readonly [SECRET_SOURCE]: true;
  /** Target-defined. Core never reads this; the target that authored the source reads it back. */
  readonly payload: T;
}

/** What `provision(node, { secrets })` supplies: one source per declared secret slot. */
export type SecretBindings<S extends Secrets> = { [K in keyof S]: SecretSource };

/** What `secrets()` returns: one redacting SecretBox per declared slot. */
export type SecretValues<S extends Secrets> = { readonly [K in keyof S]: SecretString };

/** Declares a secret NEED. Nameless — the platform name is bound at the root via `envSecret`. */
export function secret(): SecretNeed {
  return Object.freeze({ [SECRET_NEED]: true as const, kind: 'secret' as const });
}

/** Builds an opaque secret source from a target-defined payload — the SPI a deploy target's own source constructor (e.g. `envSecret`) calls. Core forwards the source and never inspects the payload. */
export function secretSource<T>(payload: T): SecretSource<T> {
  return Object.freeze({ [SECRET_SOURCE]: true as const, payload });
}

/** True if `value` is a secret source (an `envSecret` result or a forwarded ctx.secrets ref). */
export function isSecretSource(value: unknown): value is SecretSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    blindCast<
      Record<PropertyKey, unknown>,
      'reading the secret-source brand off an unknown object'
    >(value)[SECRET_SOURCE] === true
  );
}

// A provisioning NEED rides its own brand, symmetric with SECRET_SOURCE
// (ADR-0031): opaque to core, forwarded to whichever provisioner the
// CONSUMER extension registers under `need.brand`, and never read here.
const PROVISION_NEED: unique symbol = blindCast<never, 'unique-symbol brand for a provision need'>(
  Symbol.for('prisma:provision-need'),
);

/** A param value the framework mints. Opaque to core: it forwards the payload to the resolved provisioner and never reads it (ADR-0031). */
export interface ProvisionNeed<T = unknown> {
  readonly [PROVISION_NEED]: true;
  /** Selects the provisioner in an extension's `provisions` registry. */
  readonly brand: symbol;
  /** Provisioner-defined; core never reads it. */
  readonly payload: T;
}

/** Builds an opaque provisioning need — the declaring package's own brand plus whatever payload its provisioner reads back. */
export function provisionNeed<T = undefined>(brand: symbol, payload?: T): ProvisionNeed<T> {
  return blindCast<
    ProvisionNeed<T>,
    "payload is optional so a zero-arg call (T=undefined) type-checks; the interface's payload field is always present"
  >(Object.freeze({ [PROVISION_NEED]: true as const, brand, payload }));
}

/** True if `value` is a provisioning need (a `provisionNeed()` result). */
export function isProvisionNeed(value: unknown): value is ProvisionNeed {
  return (
    typeof value === 'object' &&
    value !== null &&
    blindCast<
      Record<PropertyKey, unknown>,
      'reading the provision-need brand off an unknown object'
    >(value)[PROVISION_NEED] === true
  );
}

// A param can be bound at provision time to a literal value OR an opaque
// source — the non-secret sibling of the secret need/source split above,
// mirrored onto the params channel. `param.default` stays the fallback when
// neither is supplied; the param's own declared schema (ConfigParam.schema)
// validates a literal, so — unlike a secret need — a param source has no
// separate nameless "need" of its own at the SERVICE level; it binds directly
// against the already-declared param. A MODULE boundary, which owns no
// schema, forwards a param source through a nameless `ParamNeed` slot,
// exactly the way it forwards a secret need.
const PARAM_SOURCE: unique symbol = blindCast<never, 'unique-symbol brand for a param source'>(
  Symbol.for('prisma:param-source'),
);
const PARAM_NEED: unique symbol = blindCast<
  never,
  'unique-symbol brand for a module param-forwarding need'
>(Symbol.for('prisma:param-need'));

/** The wiring value bound to a param at provision time: a target-defined payload core forwards but never inspects. A target (e.g. @prisma/composer-prisma-cloud's `envParam`) builds one via `paramSource()`. */
export interface ParamSource<T = unknown> {
  readonly [PARAM_SOURCE]: true;
  /** Target-defined. Core never reads this; the target that authored the source reads it back. */
  readonly payload: T;
}

/** Builds an opaque param source from a target-defined payload — the SPI a deploy target's own source constructor (e.g. `envParam`) calls. Core forwards the source and never inspects the payload. */
export function paramSource<T>(payload: T): ParamSource<T> {
  return Object.freeze({ [PARAM_SOURCE]: true as const, payload });
}

/** True if `value` is a param source (an `envParam` result or a forwarded ctx.params ref). */
export function isParamSource(value: unknown): value is ParamSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    blindCast<Record<PropertyKey, unknown>, 'reading the param-source brand off an unknown object'>(
      value,
    )[PARAM_SOURCE] === true
  );
}

/** A module's declared param-forwarding slot — nameless, schema-less; the root (or an ancestor module) binds a `ParamSource` and the topology forwards it into a child's real, schema-bearing param. */
export interface ParamNeed {
  readonly [PARAM_NEED]: true;
  readonly kind: 'param';
}

/** A module's param-forwarding slots: name → the need it declares. */
export type ParamNeeds = Record<string, ParamNeed>;

/** Declares a module param-forwarding NEED. Nameless — bound to a `ParamSource` by an enclosing scope and forwarded into a child's real param. */
export function paramNeed(): ParamNeed {
  return Object.freeze({ [PARAM_NEED]: true as const, kind: 'param' as const });
}

/** What `provision(service, { params })` accepts per declared param: a literal (schema-validated when config is built) or an opaque `ParamSource`, taking precedence over `param.default`. Every entry is optional — an unbound param falls back to its `default`. */
export type ParamBindings<P extends Params> = {
  readonly [K in keyof P]?: StandardSchemaV1.InferOutput<P[K]['schema']> | ParamSource;
};

/** What `provision(moduleChild, { params })` accepts per declared `ParamNeed`: a `ParamSource` only — a need carries no schema to validate a literal against. */
export type ParamNeedBindings<PN extends ParamNeeds> = {
  readonly [K in keyof PN]?: ParamSource;
};

/** Opaque `Contract<any, any>` bound shared by every node/port type that doesn't care which contract. */
// biome-ignore lint/suspicious/noExplicitAny: the one alias for this bound — see doc comment.
export type AnyContract = Contract<any, any>;

/** How a service's app becomes a runnable artifact — the build descriptor's routing key (`extension`/`type`) plus paths resolved relative to the authoring module. */
export interface BuildAdapter {
  /** The extension package that provides the build descriptor, e.g. "@prisma/composer/node". */
  readonly extension: string;
  /** The build descriptor's node ID within its extension, e.g. "node" · "nextjs". */
  readonly type: string;
  /** The authoring module's `import.meta.url` — every other path on this descriptor resolves relative to `dirname(module)`. */
  readonly module: string;
  /** The app's built runnable, resolved relative to `dirname(module)` and interpreted by the type's build descriptor (e.g. "node": a server file; "nextjs": located in the standalone tree). */
  readonly entry: string;
}

/**
 * A Resource's identity: the one place a piece of infrastructure exists.
 * Provisioned by a module, never embedded in a service's deps. `provides`
 * is the Contract the resource offers; `type` is derived from `provides.kind`.
 */
export interface ResourceNode<C extends AnyContract = AnyContract> {
  readonly [NODE]: true;
  readonly kind: 'resource';
  /** Human-readable, given at authoring — logs/diagnostics only; identity remains the deploy address (ADR-0006). */
  readonly name: string;
  /** The extension package that authored this node, e.g. "@prisma/composer-prisma-cloud" — the registry key at deploy. */
  readonly extension: string;
  readonly type: C['kind'];
  /** The Contract this resource provides — the resource's single port. */
  readonly provides: C;
}

/**
 * A Service: inputs + its own declared params + how it is built. Inspectable,
 * inert until run, and carries NO runtime behavior — an extension's factory
 * wraps it into a runnable/loadable shape (see RunnableServiceNode).
 */
export interface ServiceNode<
  D extends Deps = Deps,
  P extends Params = Params,
  E extends Expose = Expose,
  S extends Secrets = Secrets,
> {
  readonly [NODE]: true;
  readonly kind: 'service';
  /** Human-readable, given at authoring — logs/diagnostics only; identity remains the deploy address (ADR-0006). */
  readonly name: string;
  /** The extension package that authored this node, e.g. "@prisma/composer-prisma-cloud" — the registry key at deploy. */
  readonly extension: string;
  readonly type: string;
  readonly inputs: D;
  /** Service-level config declarations (e.g. port). */
  readonly params: P;
  /** Declared secret input slots (authored as `secrets`) — bound at the root via `envSecret`, read via the `secrets()` accessor (ADR-0029). Named `secretSlots` on the node so the data field does not collide with that accessor. */
  readonly secretSlots: S;
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
  S extends Secrets = Secrets,
> extends ServiceNode<D, P, E, S> {
  run(address: string, boot: () => Promise<unknown>): Promise<unknown>;
  load(): HydratedDeps<D>;
  config(): Values<P>;
  /** The service's secrets, each a redacting SecretBox — a third accessor beside load()/config() (ADR-0021). */
  secrets(): SecretValues<S>;
}

/**
 * A service's dependency slot. At Load the enclosing module wires a
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

/** A Module: the same Deps/Expose boundary a service has, around transparent wiring instead of a black-box body — its `body` runs at Load, not at authoring. */
export interface ModuleNode<
  D extends Deps = Deps,
  E extends Expose = Expose,
  S extends Secrets = Secrets,
  PN extends ParamNeeds = ParamNeeds,
> {
  readonly [NODE]: true;
  readonly kind: 'module';
  /** Human-readable, given at authoring — logs/diagnostics only. */
  readonly name: string;
  readonly deps: D;
  /** Declared secret input slots (authored as `secrets`) — forwarded to internals via `ctx.secrets` (ADR-0029). */
  readonly secretSlots: S;
  /** Declared param-forwarding slots (authored as `params`) — forwarded to internals via `ctx.params`, the same rail secrets ride on. */
  readonly paramSlots: PN;
  readonly expose: E;
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  body(ctx: ModuleContext<D, S, PN>): ModuleOutputs<E> | void;
}

/**
 * What a module's body receives: its declared inputs as forwardable wiring
 * values, plus `provision` to register the owned services/modules it wires them into.
 */
export interface ModuleContext<
  D extends Deps,
  S extends Secrets = Secrets,
  PN extends ParamNeeds = ParamNeeds,
> {
  /** The module's declared inputs as wiring values — pass them into provision(). */
  readonly inputs: { [K in keyof D]: InputRef<D[K]> };
  /** The module's declared secret slots as forwardable sources — pass them into a child's `secrets` (ADR-0029). */
  readonly secrets: { readonly [K in keyof S]: SecretSource };
  /** The module's declared param-forwarding slots as forwardable sources — pass them into a child's `params`. */
  readonly params: { readonly [K in keyof PN]: ParamSource };
  /** Registers an owned child (service or module) under a stable id. */
  readonly provision: ModuleBuilder['provision'];
}

/**
 * A module's forwarded-input value: the same ref-port shape a producer's
 * output carries, so it flows down a nested `provision()` call indistinguishably
 * from a sibling's exposed port.
 */
export type InputRef<DE> =
  // biome-ignore lint/suspicious/noExplicitAny: matches ReqOf's bound.
  DE extends DependencyEnd<any, infer Req extends AnyContract> ? RefPort<Req> : never;

/** One ref-port per declared expose key, contract-checked against `E` (mirrors `Wiring`'s `NoInfer` use). */
export type ModuleOutputs<E extends Expose> = { [P in keyof E]: RefPort<NoInfer<E[P]>> };

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

/**
 * The producers that satisfy a node's declared dependency slots — one ref per
 * slot, checked against its required contract. A slot also accepts
 * `InputRef<D[K]>` so a module body can forward its own `ctx.inputs` straight
 * into a nested `provision()` call — the same value shape a producer's own
 * exposed port carries.
 */
type DepBindings<D extends Deps> = {
  [K in keyof D]: NoInfer<ReqOf<D[K]>> | InputRef<D[K]>;
};

/**
 * `provision`'s trailing options: an explicit `id` (default: the node's own
 * `name`) plus, for a node that declares dependency slots, the `deps` that
 * satisfy them. `deps` is required exactly when the node has slots —
 * `[keyof D] extends [never]` is the "no slots" test — so a dependency can
 * never be left unwired at compile time. The whole object is therefore
 * optional for a slot-less node and required for one with slots. `params` is
 * always optional — a bound value overrides `param.default`, but a param may
 * fall back to its default (or be `optional`) instead, unlike `deps`/`secrets`.
 * `PB` is the params-binding map appropriate to the target: `ParamBindings<P>`
 * for a service's real, schema-bearing params; `ParamNeedBindings<PN>` for a
 * child module's nameless forwarding slots.
 */
type ProvisionArgs<D extends Deps, S extends Secrets, PB> = [keyof D] extends [never]
  ? [keyof S] extends [never]
    ? [opts?: { id?: string; params?: PB }]
    : [opts: { id?: string; secrets: SecretBindings<S>; params?: PB }]
  : [keyof S] extends [never]
    ? [opts: { id?: string; deps: DepBindings<D>; params?: PB }]
    : [opts: { id?: string; deps: DepBindings<D>; secrets: SecretBindings<S>; params?: PB }];

export interface ModuleBuilder {
  /** Provisions an owned resource; its id defaults to the node's `name`. */
  provision<C extends AnyContract>(
    resource: ResourceNode<C>,
    opts?: { id?: string },
  ): { readonly id: string } & RefPort<C>;
  /** Registers an owned service; its id defaults to the node's `name`; `deps`/`secrets` are required iff it declares them; a declared param may be bound (literal or `ParamSource`), overriding its default. */
  provision<D extends Deps, P extends Params, E extends Expose, S extends Secrets>(
    service: ServiceNode<D, P, E, S>,
    ...args: ProvisionArgs<D, S, ParamBindings<P>>
  ): ProvisionedRef<E>;
  /**
   * The service call with `deps`/`secrets` spelled out. `ProvisionArgs` above
   * cannot resolve while `D`/`S` are still unbound type parameters — a generic
   * wrapper like `cron()` provisioning a caller-supplied service — so that call
   * site resolves to this concrete overload instead.
   */
  provision<D extends Deps, P extends Params, E extends Expose, S extends Secrets>(
    service: ServiceNode<D, P, E, S>,
    opts: {
      id?: string;
      deps: DepBindings<D>;
      secrets?: SecretBindings<S>;
      params?: ParamBindings<P>;
    },
  ): ProvisionedRef<E>;
  /** Registers an owned child module; its id defaults to the node's `name`; `deps`/`secrets` are required iff it declares them; a declared param-forwarding slot may be bound to a `ParamSource`. */
  provision<D extends Deps, E extends Expose, S extends Secrets, PN extends ParamNeeds>(
    child: ModuleNode<D, E, S, PN>,
    ...args: ProvisionArgs<D, S, ParamNeedBindings<PN>>
  ): ProvisionedRef<E>;
  /** The child-module call with `deps`/`secrets` spelled out — the same generic-wrapper escape as the service overload above. */
  provision<D extends Deps, E extends Expose, S extends Secrets, PN extends ParamNeeds>(
    child: ModuleNode<D, E, S, PN>,
    opts: {
      id?: string;
      deps: DepBindings<D>;
      secrets?: SecretBindings<S>;
      params?: ParamNeedBindings<PN>;
    },
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
function requireNoUnderscoreName(
  name: string,
  kind: 'input' | 'param' | 'secret',
  factory: string,
): void {
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
  kind: 'input' | 'param' | 'secret',
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

function freezeSecrets<S extends Secrets>(secrets: S): S {
  const frozen: Record<string, SecretNeed> = {};
  for (const [name, need] of Object.entries(secrets)) {
    frozen[name] = Object.freeze({ ...need });
  }
  return blindCast<S, 'the frozen per-slot copy is exactly the declared Secrets map S'>(
    Object.freeze(frozen),
  );
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
 * is provisioned until a module provisions it.
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
 * params, build adapter, and the ports it exposes). Pure; carries no runtime behavior.
 */
export function service<
  D extends Deps,
  P extends Params,
  E extends Expose = Record<never, never>,
  S extends Secrets = Record<never, never>,
>(def: {
  name: string;
  extension: string;
  type: string;
  inputs: D;
  params: P;
  secrets?: S;
  build: BuildAdapter;
  expose?: E;
}): ServiceNode<D, P, E, S> {
  requireName(def.name, 'service');
  requireExtension(def.extension, 'service');
  requireType(def.type, 'service');
  requireNoUnderscoreNames(Object.keys(def.inputs), 'input', 'service');
  requireNoUnderscoreNames(Object.keys(def.params), 'param', 'service');
  requireNoUnderscoreNames(Object.keys(def.secrets ?? {}), 'secret', 'service');
  // A secret slot and a service-OWN param of the same name derive the SAME
  // config key (COMPOSER_<addr>_<NAME>), so they'd write two rows to one key.
  // A same-named dependency is fine — its keys carry the input+param segments
  // (COMPOSER_<addr>_<NAME>_<param>), which never collide — matching how a dep
  // and a param may already share a name (ADR-0021).
  for (const slot of Object.keys(def.secrets ?? {})) {
    if (Object.hasOwn(def.params, slot)) {
      throw new Error(
        `service() secret slot "${slot}" collides with a param of the same name — a secret slot and ` +
          `a service param derive the same config key (COMPOSER_<addr>_${slot.toUpperCase()}); rename one.`,
      );
    }
  }
  return Object.freeze({
    [NODE]: true as const,
    kind: 'service' as const,
    name: def.name,
    extension: def.extension,
    type: def.type,
    inputs: frozenShallowCopy(def.inputs),
    params: freezeParams(def.params),
    secretSlots: freezeSecrets(
      def.secrets ?? blindCast<S, 'no secrets declared → an empty slot map'>({}),
    ),
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
 * closed-root shape — `module(name, body)` instead of `module(name, {}, () =>
 * ({}))`.
 */
export function module(
  name: string,
  body: (
    ctx: ModuleContext<Record<never, never>, Record<never, never>, Record<never, never>>,
  ) => void,
): ModuleNode<
  Record<never, never>,
  Record<never, never>,
  Record<never, never>,
  Record<never, never>
>;
/**
 * A module with a boundary: `deps` and/or `expose` declare what wires in and
 * out, the same way a service does. The body returns one port per `expose` key.
 */
export function module<
  D extends Deps = Record<never, never>,
  E extends Expose = Record<never, never>,
  S extends Secrets = Record<never, never>,
  PN extends ParamNeeds = Record<never, never>,
>(
  name: string,
  boundary: { deps?: D; secrets?: S; params?: PN; expose?: E },
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  body: (ctx: ModuleContext<D, S, PN>) => ModuleOutputs<E> | void,
): ModuleNode<D, E, S, PN>;
/**
 * Constructs a branded, frozen Module node. Construction is INERT — the body is
 * wiring, not user code, and runs only when the module is Loaded.
 */
export function module(
  name: string,
  boundaryOrBody:
    | { deps?: Deps; secrets?: Secrets; params?: ParamNeeds; expose?: Expose }
    | ((ctx: ModuleContext<Deps>) => void),
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  maybeBody?: (ctx: ModuleContext<Deps>) => ModuleOutputs<Expose> | void,
): ModuleNode {
  requireName(name, 'module');
  const closedRoot = typeof boundaryOrBody === 'function';
  const boundary = closedRoot ? {} : boundaryOrBody;
  const deps = frozenShallowCopy(boundary.deps ?? {});
  const secretSlots = frozenShallowCopy(boundary.secrets ?? {});
  const paramSlots = frozenShallowCopy(boundary.params ?? {});
  const expose = frozenShallowCopy(boundary.expose ?? {});
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  const body: (ctx: ModuleContext<Deps>) => ModuleOutputs<Expose> | void = closedRoot
    ? (ctx) => {
        boundaryOrBody(ctx);
        return {};
      }
    : // biome-ignore lint/style/noNonNullAssertion: the non-function overload always passes a third argument.
      maybeBody!;
  return Object.freeze({
    [NODE]: true as const,
    kind: 'module' as const,
    name,
    deps,
    secretSlots,
    paramSlots,
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
): value is ServiceNode | ResourceNode | DependencyEnd | ModuleNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[NODE] === true
  );
}
