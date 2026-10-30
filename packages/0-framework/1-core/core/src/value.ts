import { blindCast } from '@internal/foundation/casts';
import type { Pointer } from '@internal/foundation/pointer';
import type { ParamSource, SecretSource } from './node.ts';

// Brands, Symbol.for so a check survives duplicated module instances (as NODE in node.ts).
const VALUE: unique symbol = blindCast<never, 'unique-symbol brand for a value'>(
  Symbol.for('prisma:value'),
);
// Core-only: where Load gets a value's real value. Symbol-keyed so a module body sees no member it could read.
const VALUE_ORIGIN: unique symbol = blindCast<never, 'unique-symbol key for a value origin'>(
  Symbol.for('prisma:value-origin'),
);
// Type-only, never assigned: carries T so Value<number> is not a Value<string>.
declare const VALUE_TYPE: unique symbol;

export type { VALUE_TYPE };
export { VALUE, VALUE_ORIGIN };

/** Where Load gets a value's real value. Internal to core; not re-exported from the public barrel. */
export type ValueOrigin<T> =
  | {
      readonly kind: 'environment';
      /** Which deploy-time fact of the environment this is. Only the name exists today. */
      readonly fact: keyof EnvironmentFacts;
    }
  | {
      readonly kind: 'computed';
      readonly dependencies: readonly Value<unknown>[];
      readonly compute: (values: readonly unknown[]) => T;
    }
  | {
      readonly kind: 'input';
      /** The address of the module whose input this field is. */
      readonly module: string;
      /** The key path inside that module's input; `[]` is the whole input. */
      readonly path: readonly string[];
    }
  | {
      readonly kind: 'source';
      /** How an error names the source, e.g. `envSecret('STRIPE_KEY')`. */
      readonly label: string;
      /** The config pool key whose value at deploy is the real value, as for `envParam()`. `undefined` for a value known only at boot, whose real value is `source`, a pointer. */
      readonly poolKey: string | undefined;
      /** For a param source known only at boot: the string a module's input schema checks in its place. */
      readonly sentinel: string | undefined;
      /** A module's input schema checks an empty `SecretString` in its place: always for a secret source, and for a redacted param source. */
      readonly redacted: boolean;
      /** The source itself. Not enumerable, so a copy's origin compares equal and the origin holds no cycle. */
      readonly source: ParamSource | SecretSource;
    };

/** The origin of a module input field. Internal to core. */
export type InputOrigin = Extract<ValueOrigin<unknown>, { readonly kind: 'input' }>;

/** The origin of a deploy target's source. Internal to core. */
export type SourceOrigin = Extract<ValueOrigin<unknown>, { readonly kind: 'source' }>;

/**
 * An opaque stand-in a module body can pass wherever a `T` is accepted
 * (ADR-0062). `environment.name` is one; each field of a module's `input` is
 * one; `resolve()` returns one computed from others; a deploy target's source,
 * such as `envParam()` or `envSecret()`, is one too. A deploy-time value's real
 * value is known by the end of Load; a runtime value's real value at deploy is a pointer.
 */
export interface Value<T> {
  readonly [VALUE]: true;
  readonly [VALUE_TYPE]?: T;
  readonly [VALUE_ORIGIN]: ValueOrigin<T>;
}

/** A value known only at boot (ADR-0062): its real value at deploy is a `Pointer<T>`, which names the platform variable the service reads at boot. */
export type RuntimeValue<T> = Value<Pointer<T>>;

/** The tuple of real-value types a dependency tuple stands for: what `resolve()`'s `fn` receives. */
export type RealValuesOf<D extends readonly Value<unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Value<infer T> ? T : never;
};

/** Plain data: what a `resolve()` function may return. */
export type PlainData =
  | string
  | number
  | boolean
  | null
  | readonly PlainData[]
  | { readonly [key: string]: PlainData };

/**
 * A value computed from other values. `fn` receives the dependencies' real
 * values as one tuple, in order, and returns plain data. Load runs it after
 * every module body, with `provision` disabled (ADR-0062). `fn` must be a pure
 * function of its dependencies: a deploy runs it in two processes.
 */
export function resolve<const D extends readonly Value<unknown>[], T>(
  dependencies: D,
  fn: (values: RealValuesOf<D>) => T,
): Value<T> {
  if (!Array.isArray(dependencies)) {
    throw new Error('resolve() requires a tuple of values as its first argument.');
  }
  dependencies.forEach((dependency: unknown, index) => {
    if (!isValue(dependency)) {
      throw new Error(
        `resolve() dependency at index ${index} is not a value — list environment.name or another resolve() result.`,
      );
    }
  });
  if (typeof fn !== 'function') {
    throw new Error('resolve() requires a function as its second argument.');
  }
  const frozenDependencies: readonly Value<unknown>[] = Object.freeze([...dependencies]);
  const compute = blindCast<
    (values: readonly unknown[]) => T,
    'fn is typed against RealValuesOf<D>; Load supplies exactly that tuple'
  >(fn);
  return Object.freeze({
    [VALUE]: true as const,
    [VALUE_ORIGIN]: Object.freeze({
      kind: 'computed' as const,
      dependencies: frozenDependencies,
      compute,
    }),
  });
}

/** True if `value` is a `Value`, a source included (checks the brand only, never a prototype). */
export function isValue(value: unknown): value is Value<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    blindCast<Record<PropertyKey, unknown>, 'reading the value brand off an unknown object'>(value)[
      VALUE
    ] === true
  );
}

/** True for an object whose prototype is `Object.prototype` or `null`: the only objects Load walks into. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Where Load gets `value`'s real value. Internal to core. */
export function originOf<T>(value: Value<T>): ValueOrigin<T> {
  return value[VALUE_ORIGIN];
}

/** The deploy-time facts a module body receives, each as a value (ADR-0062). */
export interface EnvironmentFacts {
  /** The environment's name, as `--environment` gave it. */
  readonly name: Value<string>;
}

/** The real values of the environment facts: what Load is given for the environment being loaded. */
export type EnvironmentRealValues = {
  readonly [K in keyof EnvironmentFacts]: EnvironmentFacts[K] extends Value<infer T> ? T : never;
};

/** The one `environment` object every module body receives. */
export const environmentFacts: EnvironmentFacts = Object.freeze({
  name: Object.freeze({
    [VALUE]: true as const,
    [VALUE_ORIGIN]: Object.freeze({ kind: 'environment' as const, fact: 'name' as const }),
  }),
});
