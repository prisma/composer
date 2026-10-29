import { blindCast } from '@internal/foundation/casts';

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

export type { VALUE, VALUE_ORIGIN, VALUE_TYPE };

/** Where Load gets a value's real value. Internal to core; not re-exported from the public barrel. */
export type ValueOrigin<T> =
  | {
      readonly kind: 'environment';
      /** Which deploy-time fact of the environment this is. Only the name exists today. */
      readonly fact: 'name';
    }
  | {
      readonly kind: 'computed';
      readonly dependencies: readonly Value<unknown>[];
      readonly compute: (values: readonly unknown[]) => T;
    };

/**
 * An opaque stand-in a module body can pass wherever a `T` is accepted; its
 * real value is known by the end of Load (ADR-0062). `environment.name` is one;
 * `resolve()` returns one computed from others.
 */
export interface Value<T> {
  readonly [VALUE]: true;
  readonly [VALUE_TYPE]?: T;
  readonly [VALUE_ORIGIN]: ValueOrigin<T>;
}

/** The tuple of real-value types a dependency tuple stands for: what `resolve()`'s `fn` receives. */
export type RealValuesOf<D extends readonly Value<unknown>[]> = {
  readonly [K in keyof D]: D[K] extends Value<infer T> ? T : never;
};

/** Plain data: what a `resolve()` function may return, and the only thing a value may stand for in a binding. */
export type PlainValue =
  | string
  | number
  | boolean
  | null
  | readonly PlainValue[]
  | { readonly [key: string]: PlainValue };

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

/** True if `value` is a `Value` (checks the brand only, never a prototype). */
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

/** The one `environment` object every module body receives. */
export const environmentFacts: EnvironmentFacts = Object.freeze({
  name: Object.freeze({
    [VALUE]: true as const,
    [VALUE_ORIGIN]: Object.freeze({ kind: 'environment' as const, fact: 'name' as const }),
  }),
});
