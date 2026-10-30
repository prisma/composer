/**
 * Core model: node types and the factories that construct them, plain frozen
 * data objects. A node's `extension` + `type` form its deploy-time registry key (ADR-0017).
 */
import { blindCast } from '@internal/foundation/casts';
import type { SecretString } from '@internal/foundation/secret';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ConfigParam, Connection, Params } from './config.ts';
import type { Contract } from './contract.ts';
import { LoadError } from './graph-types.ts';
import { type ModuleInput, primitiveMisuse } from './module-input.ts';
import {
  type EnvironmentFacts,
  isPlainObject,
  isValue,
  originOf,
  type PlainData,
  type SourceOrigin,
  VALUE,
  VALUE_ORIGIN,
  type Value,
} from './value.ts';

// Brand — set by the factories below; how Load tells a node from junk.
// Symbol.for so the check survives duplicated module instances in a workspace.
// Exported as a TYPE only: an extension pack that implements a node interface
// as a concrete class (rather than building a plain object via these
// factories) needs the brand nameable to `implements` it honestly (its
// `declare readonly [NODE]: true` member) — and nothing more. The value is
// already globally reachable via Symbol.for, so a value export adds nothing.
const NODE = Symbol.for('prisma:node');

export type { NODE };

const SECRET_SOURCE: unique symbol = blindCast<never, 'unique-symbol brand for a secret source'>(
  Symbol.for('prisma:secret-source'),
);

/** A secret's source: a target-defined payload core forwards but never inspects. It is a value too, known only at boot; its real value at deploy is the source itself, a pointer. A target (e.g. @prisma/composer-prisma-cloud's `envSecret`) builds one with `secretSource()`. */
export interface SecretSource<T = unknown> extends Value<unknown> {
  readonly [SECRET_SOURCE]: true;
  /** Target-defined. Core never reads this; the target that authored the source reads it back. */
  readonly payload: T;
}

/** What a deploy target says about a source it builds. */
export interface SourceOptions {
  /** How errors name the source, e.g. `envSecret('STRIPE_KEY')`. Defaults to `a secret source` or `a param source`. */
  readonly label?: string;
}

/** What a deploy target says about a param source it builds. */
export interface ParamSourceOptions extends SourceOptions {
  /** The config pool key whose value at deploy is the source's real value, as for `envParam()`. Without one the source is known only at boot, and its real value is the source itself, a pointer. */
  readonly poolKey?: string;
  /** For a source known only at boot: the string a module's input schema checks in its place, because the deploy has no value for it. */
  readonly sentinel?: string;
  /** For a source known only at boot whose value is redacted: a module's input schema checks an empty `SecretString` in its place, as for a secret. */
  readonly redacted?: boolean;
}

/** Builds a secret source from a target-defined payload: the SPI a deploy target's own constructor (e.g. `envSecret`) calls. The source is a value whose real value at deploy is itself, a pointer. Core forwards it and never inspects the payload. */
export function secretSource<P, T = unknown>(
  payload: P,
  options?: SourceOptions,
): SecretSource<P> & Value<T> {
  const label = sourceLabel('secretSource', options?.label, 'a secret source');
  return blindCast<
    SecretSource<P> & Value<T>,
    'the frozen object carries the value brand, a source origin whose source is itself, the source brand and the payload, which is the SecretSource and Value shape'
  >(
    buildSource(SECRET_SOURCE, payload, {
      kind: 'source',
      label,
      poolKey: undefined,
      sentinel: undefined,
      redacted: true,
    }),
  );
}

/** True if `value` is a secret source, such as an `envSecret()` result. */
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

const PARAM_SOURCE: unique symbol = blindCast<never, 'unique-symbol brand for a param source'>(
  Symbol.for('prisma:param-source'),
);

/** A param's source: a target-defined payload core forwards but never inspects. It is a value too: known at deploy when it names a config pool key (`envParam`), otherwise known only at boot, with the source itself, a pointer, as its real value. A target builds one with `paramSource()`. */
export interface ParamSource<T = unknown> extends Value<unknown> {
  readonly [PARAM_SOURCE]: true;
  /** Target-defined. Core never reads this; the target that authored the source reads it back. */
  readonly payload: T;
}

/** Builds a param source from a target-defined payload: the SPI a deploy target's own constructor (e.g. `envParam`) calls. Core forwards it and never inspects the payload. */
export function paramSource<P, T = unknown>(
  payload: P,
  options?: ParamSourceOptions,
): ParamSource<P> & Value<T> {
  const label = sourceLabel('paramSource', options?.label, 'a param source');
  const poolKey = options?.poolKey;
  if (poolKey !== undefined && (typeof poolKey !== 'string' || poolKey.length === 0)) {
    throw new Error('paramSource() poolKey must be a non-empty string.');
  }
  const sentinel = options?.sentinel;
  const redacted = options?.redacted === true;
  if (poolKey !== undefined && (sentinel !== undefined || redacted)) {
    throw new Error(
      'paramSource() takes poolKey, for a value known at deploy, or sentinel or redacted, for one known only at boot, not both.',
    );
  }
  if (sentinel !== undefined && redacted) {
    throw new Error('paramSource() takes sentinel or redacted, not both.');
  }
  return blindCast<
    ParamSource<P> & Value<T>,
    'the frozen object carries the value brand, a source origin whose source is itself, the source brand and the payload, which is the ParamSource and Value shape'
  >(buildSource(PARAM_SOURCE, payload, { kind: 'source', label, poolKey, sentinel, redacted }));
}

function sourceLabel(factory: string, label: unknown, fallback: string): string {
  if (label === undefined) return fallback;
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error(`${factory}() label must be a non-empty string.`);
  }
  return label;
}

function buildSource(
  brand: typeof SECRET_SOURCE | typeof PARAM_SOURCE,
  payload: unknown,
  origin: Omit<SourceOrigin, 'source'>,
): object {
  const source = { [VALUE]: true, [VALUE_ORIGIN]: origin, [brand]: true, payload };
  Object.defineProperty(origin, 'source', { value: source });
  Object.defineProperties(source, coercions(origin));
  Object.freeze(origin);
  return Object.freeze(source);
}

function coercions(origin: Omit<SourceOrigin, 'source'>): PropertyDescriptorMap {
  const thrower = (what: string) => () => {
    throw sourceMisuse(origin, what);
  };
  return {
    toString: { value: thrower('its toString() was called') },
    valueOf: { value: thrower('its valueOf() was called') },
    [Symbol.toPrimitive]: {
      value: (hint: string) => {
        throw sourceMisuse(origin, primitiveMisuse(hint));
      },
    },
  };
}

const sourceMisuses = new WeakSet<LoadError>();

function sourceMisuse(origin: Omit<SourceOrigin, 'source'>, what: string): LoadError {
  const { label } = origin;
  const error = new LoadError(
    origin.poolKey === undefined
      ? `${label} is known only at boot: the deploy holds a pointer to it, never its value, and ${what}. ` +
          'A resolve() function may return the pointer, or put it in its result, unchanged; to compute with the value, do it in the service that reads it.'
      : `${label} is a value, not its real value, and ${what}. ` +
          'A module body can only pass it on: into a provision() binding or as a resolve() dependency. ' +
          `To compute with it, list it: resolve([${label}], ([v]) => …).`,
  );
  sourceMisuses.add(error);
  return error;
}

/** True for the error a source throws when code turns it into text or a number. Internal to core. */
export function isSourceMisuse(error: unknown): boolean {
  return error instanceof LoadError && sourceMisuses.has(error);
}

/** A source's origin; `undefined` for a source another installed copy of core built without one. Internal to core. */
export function sourceOriginOf(source: ParamSource | SecretSource): SourceOrigin | undefined {
  if (!isValue(source)) return undefined;
  const origin = originOf(source);
  return origin.kind === 'source' ? origin : undefined;
}

/**
 * True when `value` is a pointer: the real value at deploy of a value known
 * only at boot, such as `envSecret()`, `generatedParam()` or `serviceOrigin()`.
 * A resolve() function receives one in place of such a value; it may return it
 * unchanged, but cannot read it (ADR-0062). `envParam()` is not one: it is known
 * at deploy. A module input field is never one in the body, because Load reads
 * its binding only after the body has run.
 */
export function isRuntimeValue(value: unknown): value is ParamSource | SecretSource {
  if (!isSecretSource(value) && !isParamSource(value)) return false;
  return sourceOriginOf(value)?.poolKey === undefined;
}

/** True if `value` is a param source, such as an `envParam()` result. */
export function isParamSource(value: unknown): value is ParamSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    blindCast<Record<PropertyKey, unknown>, 'reading the param-source brand off an unknown object'>(
      value,
    )[PARAM_SOURCE] === true
  );
}

/** What `provision(service, { params })` accepts per declared param: a literal (schema-validated when config is built) or an opaque `ParamSource`, taking precedence over `param.default`. Every entry is optional — an unbound param falls back to its `default`. */
export type ParamBindings<P extends Params> = {
  readonly [K in keyof P]?:
    | StandardSchemaV1.InferOutput<P[K]['schema']>
    | ParamSource
    | (StandardSchemaV1.InferOutput<P[K]['schema']> extends PlainData
        ? Value<StandardSchemaV1.InferOutput<P[K]['schema']>>
        : never);
};

/** What a value in a service's input binding may stand for: plain data, a `SecretString` at any depth (a forwarded secret field), and `undefined` (an optional field the binding left out). */
export type InputBindingData =
  | string
  | number
  | boolean
  | null
  | undefined
  | SecretString
  | readonly InputBindingData[]
  | { readonly [key: string]: InputBindingData };

/**
 * What `provision(service, { input })` accepts (ADR-0042): a plain object
 * mirroring the service's input schema, whose leaves are literals,
 * `envParam(...)` sources, or `envSecret(...)` sources. Deliberately a
 * best-effort structural type: the framework never introspects a Standard
 * Schema, so the binding's exact shape cannot be derived from it — deploy-time
 * validation of the resolved binding is the real check.
 */
export type InputBinding =
  | string
  | number
  | boolean
  | null
  | ParamSource
  | SecretSource
  | Value<InputBindingData>
  | readonly InputBinding[]
  | { readonly [key: string]: InputBinding };

/**
 * What `provision(module, { input })` accepts where the module's input schema
 * expects `T` (its Standard Schema input type): the data, a value standing for
 * it, or, for a `SecretString` field, a secret source. An optional key also
 * takes a value that may stand for `undefined`.
 */
export type ModuleInputBinding<T> =
  | Value<T>
  | (T extends SecretString
      ? SecretSource
      : T extends readonly (infer E)[]
        ? T | readonly ModuleInputBinding<E>[]
        : T extends { readonly [key: string]: unknown }
          ? {
              readonly [K in keyof T]:
                | ModuleInputBinding<T[K]>
                | (Record<never, never> extends Pick<T, K> ? Value<T[K] | undefined> : never);
            }
          : T);

/** A module input schema's Standard Schema input type. */
type ModuleInputOf<I extends StandardSchemaV1 | undefined> = StandardSchemaV1.InferInput<
  NonNullable<I>
>;

/** What `input()` returns: the schema's validated output type; `never` on a service that declares no input schema. */
export type InputValueOf<I> = I extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<I> : never;

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
 * is the Contract the resource offers, and `type` is its `kind`; a resource
 * that offers nothing has no `provides` and names its `type` directly.
 */
export interface ResourceNode<
  C extends AnyContract | undefined = AnyContract,
  D extends Deps = Deps,
  P extends ResourceProps = ResourceProps,
> {
  readonly [NODE]: true;
  readonly kind: 'resource';
  /** Human-readable, given at authoring — logs/diagnostics only; identity remains the deploy address (ADR-0006). */
  readonly name: string;
  /** The extension package that authored this node, e.g. "@prisma/composer-prisma-cloud" — the registry key at deploy. */
  readonly extension: string;
  readonly type: string;
  /** The Contract this resource provides — the resource's single port. Undefined for a resource that exposes nothing, such as a public URL. */
  readonly provides: C;
  /** Dependency slots, as a service's `inputs`. Empty for a resource that depends on nothing. */
  readonly inputs: D;
  /** The producer wired into each slot, as a `provision()` call's `deps` supplies for a service. A resource is wired when it is constructed. `deps` names two things: `ModuleNode.deps`, `module()`'s boundary `deps` and `compute()`'s `deps` declare slots, while `provision()`'s and `resource()`'s `deps` bind producers to slots. */
  readonly deps: DepBindings<D>;
  /** Plain data the factory records, the resource's configuration. Load resolves any value inside it; nowhere else on a resource is a value resolved. Empty for a resource with none. */
  readonly props: P;
}

/** A resource's configuration: plain data and values, nested in objects and arrays. */
export type ResourceProps = { readonly [key: string]: ResourcePropsMember };
export type ResourcePropsMember =
  | string
  | number
  | boolean
  | null
  | Value<PlainData>
  | readonly ResourcePropsMember[]
  | { readonly [key: string]: ResourcePropsMember };

/**
 * A Service: inputs + its own declared params + how it is built. Inspectable,
 * inert until run, and carries NO runtime behavior — an extension's factory
 * wraps it into a runnable/loadable shape (see RunnableServiceNode).
 */
export interface ServiceNode<
  D extends Deps = Deps,
  P extends Params = Params,
  E extends Expose = Expose,
  I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  readonly [NODE]: true;
  readonly kind: 'service';
  /** Human-readable, given at authoring — logs/diagnostics only; identity remains the deploy address (ADR-0006). */
  readonly name: string;
  /** The extension package that authored this node, e.g. "@prisma/composer-prisma-cloud" — the registry key at deploy. */
  readonly extension: string;
  readonly type: string;
  readonly inputs: D;
  /** Extension-reserved config declarations (e.g. compute's `port`) — never user-authored (ADR-0042). */
  readonly params: P;
  /** The service's whole incoming configuration as ONE Standard Schema (authored as `input`, ADR-0042), or `undefined` when it takes none. The framework never introspects it — it only calls `~standard.validate`. Named `inputSchema` on the node so the data field does not collide with the `input()` accessor. */
  readonly inputSchema: I;
  /** How the app's entry is built + assembled. */
  readonly build: BuildAdapter;
  /** Named output ports this service exposes — the Contracts a consumer's `rpc(contract)` can require. `undefined` when the service exposes nothing. */
  readonly expose: E | undefined;
}

/**
 * The extension's runnable/loadable service node. `run` boots the app after
 * deserializing its environment; `load` reads the hydrated deps and `input`
 * the validated, typed input object (ADR-0042).
 */
export interface RunnableServiceNode<
  D extends Deps = Deps,
  P extends Params = Params,
  E extends Expose = Expose,
  I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> extends ServiceNode<D, P, E, I> {
  run(address: string, boot: () => Promise<unknown>): Promise<unknown>;
  load(): HydratedDeps<D>;
  /** The service's validated input — one typed object, secrets as redacting `SecretString` boxes (ADR-0042). */
  input(): InputValueOf<I>;
}

/**
 * A service's dependency slot. At Load the enclosing module wires a
 * producer's ref into it; at run it hydrates a client via Connection. `Req`
 * is the required contract (`unknown` for an untyped end).
 */
export interface DependencyEnd<C = unknown, Req = unknown> {
  readonly [NODE]: true;
  readonly kind: 'dependency';
  /** Human-readable, given at authoring — logs/diagnostics only. */
  readonly name: string;
  readonly type: string;
  readonly connection: Connection<Params, C>;
  /** The required contract, or `undefined` for an untyped end. */
  readonly required: Req | undefined;
}

/** A Module: the same Deps/Expose boundary a service has, around transparent wiring instead of a black-box body — its `body` runs at Load, not at authoring. */
export interface ModuleNode<
  D extends Deps = Deps,
  E extends Expose = Expose,
  I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  readonly [NODE]: true;
  readonly kind: 'module';
  /** Human-readable, given at authoring — logs/diagnostics only. */
  readonly name: string;
  readonly deps: D;
  /** The module's whole incoming configuration as one Standard Schema (authored as `input`, ADR-0061), or `undefined` when it takes none. Load only calls its `~standard.validate`. */
  readonly inputSchema: I;
  readonly expose: E;
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  body(ctx: ModuleContext<D, I>): ModuleOutputs<E> | void;
}

/**
 * What a module's body receives: its declared dependencies as forwardable wiring
 * values, plus `provision` to register the owned services/modules it wires them into.
 */
export interface ModuleContext<
  D extends Deps,
  I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  /** The module's declared dependencies as wiring values — pass them into provision(). */
  readonly deps: { [K in keyof D]: InputRef<D[K]> };
  /** The module's input: one value per field, typed from its input schema's output (ADR-0061); `undefined` when it declares none. A root's input is the config pool, validated by its schema; a root passes on its fields one by one, never its whole input. Pass a field into a provision() binding or list it as a resolve() dependency. */
  readonly input: I extends StandardSchemaV1 ? ModuleInput<I> : undefined;
  /** The deploy-time facts of the environment, each a value (ADR-0062). List `environment.name` as a `resolve()` dependency. Never environment variables: user code never reads those. */
  readonly environment: EnvironmentFacts;
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
 * `InputRef<D[K]>` so a module body can forward its own `ctx.deps` straight
 * into a nested `provision()` call — the same value shape a producer's own
 * exposed port carries.
 */
export type DepBindings<D extends Deps> = {
  [K in keyof D]: NoInfer<ReqOf<D[K]>> | InputRef<D[K]>;
};

/**
 * A SERVICE provision's trailing options: an explicit `id` (default: the
 * node's own `name`); `deps` required exactly when the node declares
 * dependency slots (`[keyof D] extends [never]` is the "no slots" test);
 * `input` required exactly when the node declares an input schema (ADR-0042).
 * `params` is always optional — it binds only extension-reserved params (e.g.
 * compute's `port`), which fall back to their own defaults.
 */
type ServiceProvisionArgs<D extends Deps, I extends StandardSchemaV1 | undefined, PB> = [
  keyof D,
] extends [never]
  ? I extends undefined
    ? [opts?: { id?: string; params?: PB }]
    : [opts: { id?: string; input: InputBinding; params?: PB }]
  : I extends undefined
    ? [opts: { id?: string; deps: DepBindings<D>; params?: PB }]
    : [opts: { id?: string; deps: DepBindings<D>; input: InputBinding; params?: PB }];

/**
 * A child-MODULE provision's trailing options: `deps` and `input` each
 * required exactly when the module declares them.
 */
type ModuleProvisionOptions<D extends Deps, I extends StandardSchemaV1 | undefined> = {
  id?: string;
} & ([keyof D] extends [never] ? unknown : { deps: DepBindings<D> }) &
  ([I] extends [StandardSchemaV1] ? { input: ModuleInputBinding<ModuleInputOf<I>> } : unknown);

/** The options are optional exactly when nothing is required. */
type ModuleProvisionArgs<D extends Deps, I extends StandardSchemaV1 | undefined> = [
  keyof D,
] extends [never]
  ? [I] extends [StandardSchemaV1]
    ? [opts: ModuleProvisionOptions<D, I>]
    : [opts?: ModuleProvisionOptions<D, I>]
  : [opts: ModuleProvisionOptions<D, I>];

export interface ModuleBuilder {
  /** Provisions an owned resource; its id defaults to the node's `name`. */
  provision<C extends AnyContract | undefined>(
    resource: ResourceNode<C>,
    opts?: { id?: string },
  ): { readonly id: string } & (C extends AnyContract ? RefPort<C> : Record<never, never>);
  /** Registers an owned service; its id defaults to the node's `name`; `deps`/`input` are required iff it declares them; a reserved param may be bound (literal or `ParamSource`), overriding its default. */
  provision<
    D extends Deps,
    P extends Params,
    E extends Expose,
    I extends StandardSchemaV1 | undefined,
  >(
    service: ServiceNode<D, P, E, I>,
    ...args: ServiceProvisionArgs<D, I, ParamBindings<P>>
  ): ProvisionedRef<E>;
  /**
   * The service call with `deps`/`input` spelled out. `ServiceProvisionArgs`
   * above cannot resolve while `D`/`I` are still unbound type parameters — a
   * generic wrapper like `cron()` provisioning a caller-supplied service — so
   * that call site resolves to this concrete overload instead.
   */
  provision<
    D extends Deps,
    P extends Params,
    E extends Expose,
    I extends StandardSchemaV1 | undefined,
  >(
    service: ServiceNode<D, P, E, I>,
    opts: {
      id?: string;
      deps: DepBindings<D>;
      input?: InputBinding;
      params?: ParamBindings<P>;
    },
  ): ProvisionedRef<E>;
  /** Registers an owned child module; its id defaults to the node's `name`; `deps` and `input` are required iff it declares them. */
  provision<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(
    child: ModuleNode<D, E, I>,
    ...args: ModuleProvisionArgs<D, I>
  ): ProvisionedRef<E>;
  /** The child-module call with `deps` spelled out — the same generic-wrapper escape as the service overload above. */
  provision<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(
    child: ModuleNode<D, E, I>,
    opts: {
      id?: string;
      deps: DepBindings<D>;
      input?: ModuleInputBinding<ModuleInputOf<I>>;
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
 * Core's grammar for every name that becomes a config-key segment —
 * addresses, input/param/secret names: ASCII letters and digits only.
 * Conservative by design so any target medium — POSIX env-var keys
 * included — can uppercase and "_"-join segments without escaping.
 */
export function isConfigKeySegment(name: string): boolean {
  return /^[A-Za-z0-9]+$/.test(name);
}

function requireConfigKeySegmentName(
  name: string,
  kind: 'input' | 'param' | 'secret',
  factory: string,
): void {
  if (!isConfigKeySegment(name)) {
    throw new Error(
      `${factory}() ${kind} name "${name}" must contain only ASCII letters and digits ` +
        '([A-Za-z0-9]) — declared names derive deterministic config keys, uppercased and joined ' +
        'with "_" (an input "db"\'s param "url" becomes config key "DB_URL"), so an underscore ' +
        'inside a name collides with that separator and any other character has no place in a ' +
        `config key. "${name}" would put "${name.toUpperCase()}" inside the derived key.`,
    );
  }
}

/**
 * `$out` names a resource's single anonymous output on the wire (the
 * application topology's reserved port name), so no declared port — a dep
 * slot or an expose entry — may claim it. Input names are already confined
 * to [A-Za-z0-9] by the config-key rule; expose and module-dep names are
 * not, so the reservation is checked wherever a port name is declared.
 */
function requireNotReservedPortNames(names: Iterable<string>, factory: string): void {
  for (const name of names) {
    if (name === '$out') {
      throw new Error(
        `${factory}() declares a port named "$out" — that name is reserved for a resource's ` +
          'anonymous output; choose another name.',
      );
    }
  }
}

function requireConfigKeySegmentNames(
  names: Iterable<string>,
  kind: 'input' | 'param' | 'secret',
  factory: string,
): void {
  for (const name of names) requireConfigKeySegmentName(name, kind, factory);
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

/** The slots, wiring and configuration a resource may carry, checked once for `resource()` and `ResourceNodeBase`. */
function requireResourceWiring(def: {
  inputs?: Deps;
  deps?: Record<string, unknown>;
  props?: ResourceProps;
}): void {
  const inputs = def.inputs ?? {};
  const deps = def.deps ?? {};
  requireConfigKeySegmentNames(Object.keys(inputs), 'input', 'resource');
  for (const [input, slot] of Object.entries(inputs)) {
    const declared: unknown = slot;
    if (!isNode(declared) || declared.kind !== 'dependency') {
      throw new Error(
        `resource() dependency "${input}" is not a branded dependency end (construct it with the dependency() factory).`,
      );
    }
  }
  for (const input of Object.keys(inputs)) {
    if (deps[input] === undefined) {
      throw new Error(
        `resource() declares dependency "${input}" but its deps leave it unwired. A resource is wired when it is constructed.`,
      );
    }
  }
  for (const [input, producer] of Object.entries(deps)) {
    if (!Object.hasOwn(inputs, input)) {
      throw new Error(`resource() deps name "${input}", which is not a declared input.`);
    }
    if (isValue(producer)) {
      throw new Error(
        `resource() deps wire "${input}" to a value. A value can configure a node, never decide its edges (ADR-0062).`,
      );
    }
  }
  if (def.props !== undefined && !isPlainObject(def.props)) {
    throw new Error('resource() props must be a plain object.');
  }
}

/** A resource's routing `type`: its contract's `kind`, or the `type` named by a resource that offers nothing. */
function resourceType(def: { provides?: unknown; type?: string }): string {
  const provides = def.provides;
  if (provides === undefined) {
    if (typeof def.type !== 'string' || def.type.length === 0) {
      throw new Error(
        'resource() requires provides, the contract it offers, or type, for a resource that offers nothing.',
      );
    }
    return def.type;
  }
  if (def.type !== undefined) {
    throw new Error(
      "resource() takes either provides or type, not both — type is the contract's kind when a contract is provided.",
    );
  }
  if (
    typeof provides !== 'object' ||
    provides === null ||
    !('kind' in provides) ||
    typeof provides.kind !== 'string' ||
    provides.kind.length === 0 ||
    !('satisfies' in provides) ||
    typeof provides.satisfies !== 'function'
  ) {
    throw new Error(
      'resource() requires `provides` — the Contract this resource offers ' +
        '(a non-empty `kind` plus its `satisfies()`).',
    );
  }
  return provides.kind;
}

/**
 * Everything `resource()` establishes, minus the freeze — an extension
 * whose resource node carries extra fields extends this, assigns them, and
 * calls `freezeNode(this)` as its constructor's last statement.
 * A class built on this base must not use #private fields: Load copies a node whose props hold a value, and a copy carries own properties only.
 */
export abstract class ResourceNodeBase<
  C extends AnyContract | undefined = AnyContract,
  D extends Deps = Record<never, never>,
  P extends ResourceProps = Record<never, never>,
> implements ResourceNode<C, D, P>
{
  readonly [NODE] = true as const;
  readonly kind = 'resource' as const;
  readonly name: string;
  readonly extension: string;
  readonly type: string;
  readonly provides: C;
  readonly inputs: D;
  readonly deps: DepBindings<D>;
  readonly props: P;

  constructor(def: {
    name: string;
    extension: string;
    provides?: C;
    type?: string;
    inputs?: D;
    deps?: DepBindings<D>;
    props?: P;
  }) {
    requireName(def.name, 'resource');
    requireExtension(def.extension, 'resource');
    this.type = resourceType(def);
    requireResourceWiring(def);
    this.name = def.name;
    this.extension = def.extension;
    this.provides = blindCast<
      C,
      'provides is the authored C itself; an omitted provides is the undefined that C admits, since a resource that offers nothing is typed ResourceNode<undefined>'
    >(def.provides);
    this.inputs = blindCast<
      D,
      'an omitted inputs map is the empty Deps; the deps-match check above guarantees the keys agree at runtime'
    >(frozenShallowCopy(def.inputs ?? {}));
    this.deps = blindCast<
      DepBindings<D>,
      'omitted deps are the empty bindings of the empty Deps; the deps-match check above guarantees the keys agree at runtime'
    >(frozenShallowCopy(def.deps ?? {}));
    this.props = blindCast<
      P,
      'omitted props are the empty props; the plain-object check above is the runtime guard'
    >(frozenShallowCopy(def.props ?? {}));
  }
}

/** The core leaf: exactly the base, frozen. */
class FrozenResourceNode<
  C extends AnyContract | undefined,
  D extends Deps,
  P extends ResourceProps,
> extends ResourceNodeBase<C, D, P> {
  constructor(def: {
    name: string;
    extension: string;
    provides?: C;
    type?: string;
    inputs?: D;
    deps?: DepBindings<D>;
    props?: P;
  }) {
    super(def);
    freezeNode(this);
  }
}

/**
 * Constructs a branded, frozen Resource node — an identity plus the Contract
 * it provides; the routing `type` is the contract's `kind`. A resource that
 * offers nothing omits `provides` and names its `type`. Pure — nothing is
 * provisioned until a module provisions it.
 */
export function resource<
  C extends AnyContract | undefined = undefined,
  D extends Deps = Record<never, never>,
  P extends ResourceProps = Record<never, never>,
>(def: {
  name: string;
  extension: string;
  provides?: C;
  type?: string;
  inputs?: D;
  deps?: DepBindings<D>;
  props?: P;
}): ResourceNode<C, D, P> {
  return new FrozenResourceNode(def);
}

/**
 * Constructs a branded, frozen Service node — declarations only (inputs,
 * params, the input schema, build adapter, and the ports it exposes). Pure;
 * carries no runtime behavior.
 */
export function service<
  D extends Deps,
  P extends Params,
  E extends Expose = Record<never, never>,
  I extends StandardSchemaV1 | undefined = undefined,
>(def: {
  name: string;
  extension: string;
  type: string;
  inputs: D;
  params: P;
  input?: I;
  build: BuildAdapter;
  expose?: E;
}): ServiceNode<D, P, E, I> {
  requireName(def.name, 'service');
  requireExtension(def.extension, 'service');
  requireType(def.type, 'service');
  requireConfigKeySegmentNames(Object.keys(def.inputs), 'input', 'service');
  requireConfigKeySegmentNames(Object.keys(def.params), 'param', 'service');
  if (def.expose !== undefined) requireNotReservedPortNames(Object.keys(def.expose), 'service');
  if (def.input !== undefined && typeof def.input['~standard']?.validate !== 'function') {
    throw new Error(
      'service() `input` must be a Standard Schema (an object with a "~standard".validate ' +
        'function) — see https://standardschema.dev (ADR-0042).',
    );
  }
  return Object.freeze({
    [NODE]: true as const,
    kind: 'service' as const,
    name: def.name,
    extension: def.extension,
    type: def.type,
    inputs: frozenShallowCopy(def.inputs),
    params: freezeParams(def.params),
    inputSchema: blindCast<
      I,
      'omitted input (I = undefined by default) is the undefined member of I'
    >(def.input),
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
  requireConfigKeySegmentNames(Object.keys(def.connection.params), 'param', 'dependency');
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
  body: (ctx: ModuleContext<Record<never, never>, undefined>) => void,
): ModuleNode<Record<never, never>, Record<never, never>, undefined>;
/**
 * A module with a boundary: `deps` and/or `expose` declare what wires in and
 * out, the same way a service does. The body returns one port per `expose` key.
 */
export function module<
  D extends Deps = Record<never, never>,
  E extends Expose = Record<never, never>,
  I extends StandardSchemaV1 | undefined = undefined,
>(
  name: string,
  boundary: { deps?: D; input?: I; expose?: E },
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  body: (ctx: ModuleContext<D, I>) => ModuleOutputs<E> | void,
): ModuleNode<D, E, I>;
/**
 * Constructs a branded, frozen Module node. Construction is INERT — the body is
 * wiring, not user code, and runs only when the module is Loaded.
 */
export function module(
  name: string,
  boundaryOrBody:
    | { deps?: Deps; input?: StandardSchemaV1; expose?: Expose }
    | ((ctx: ModuleContext<Deps, undefined>) => void),
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  maybeBody?: (ctx: ModuleContext<Deps>) => ModuleOutputs<Expose> | void,
): ModuleNode {
  requireName(name, 'module');
  const closedRoot = typeof boundaryOrBody === 'function';
  const boundary = closedRoot ? {} : boundaryOrBody;
  if (Object.hasOwn(boundary, 'params')) {
    throw new Error(
      `module("${name}") declares \`params\`, which a module no longer takes. Declare each value ` +
        "as a field of the module's `input` schema, and bind it with provision(module, { input: { … } }) (ADR-0061).",
    );
  }
  if (Object.hasOwn(boundary, 'secrets')) {
    throw new Error(
      `module("${name}") declares \`secrets\`, which a module no longer takes. Declare each secret ` +
        "as a secretString() field of the module's `input` schema, and bind it with provision(module, { input: { … } }) (ADR-0061).",
    );
  }
  requireNotReservedPortNames(Object.keys(boundary.deps ?? {}), 'module');
  requireNotReservedPortNames(Object.keys(boundary.expose ?? {}), 'module');
  if (boundary.input !== undefined && typeof boundary.input['~standard']?.validate !== 'function') {
    throw new Error(
      'module() `input` must be a Standard Schema (an object with a "~standard".validate ' +
        'function) — see https://standardschema.dev (ADR-0061).',
    );
  }
  const deps = frozenShallowCopy(boundary.deps ?? {});
  const expose = frozenShallowCopy(boundary.expose ?? {});
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  const body: (ctx: ModuleContext<Deps>) => ModuleOutputs<Expose> | void = closedRoot
    ? (ctx) => {
        boundaryOrBody({ ...ctx, input: undefined });
        return {};
      }
    : // biome-ignore lint/style/noNonNullAssertion: the non-function overload always passes a third argument.
      maybeBody!;
  return Object.freeze({
    [NODE]: true as const,
    kind: 'module' as const,
    name,
    deps,
    inputSchema: boundary.input,
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

/** A node's dependency slots. A resource node built by another installed copy of core may have no `inputs`; that means none. */
export function slotsOf(node: ServiceNode | ResourceNode): ServiceNode['inputs'] {
  return node.kind === 'resource' ? (node.inputs ?? {}) : node.inputs;
}
