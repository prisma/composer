import { blindCast } from '@internal/foundation/casts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { LoadError, type NodeId } from './graph-types.ts';
import { type InputOrigin, VALUE, VALUE_ORIGIN, type Value } from './value.ts';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

type PlainObject = { readonly [key: string]: unknown };

/**
 * What a module body holds for an input field whose real value has type `T`:
 * a value, plus one `ModuleInputField` per key when `T` is a plain object.
 */
export type ModuleInputField<T> = Value<T> & FieldsOf<T>;

type FieldsOf<T> = [NonNullable<T>] extends [never]
  ? unknown
  : [NonNullable<T>] extends [readonly unknown[]]
    ? unknown
    : [NonNullable<T>] extends [PlainObject]
      ? Fields<NonNullable<T>, undefined extends T ? undefined : never>
      : unknown;

// `Absent` carries a parent's optionality down: if `a` may be absent, so may `a.b`.
type Fields<O, Absent> = {
  readonly [K in keyof O & string]-?: ModuleInputField<FieldType<O, K> | Absent>;
};

// An optional key's real value may be undefined even under exactOptionalPropertyTypes.
type FieldType<O, K extends keyof O> =
  Record<never, never> extends Pick<O, K> ? O[K] | undefined : O[K];

/** The `input` a module body receives for its input schema `S`: one value per field, typed from the schema's output (ADR-0061). */
export type ModuleInput<S extends StandardSchemaV1> = ModuleInputField<
  StandardSchemaV1.InferOutput<S>
>;

/** `input` or `input.a.b`: how an error names an input field. */
export function inputFieldLabel(origin: InputOrigin): string {
  return origin.path.length === 0 ? 'input' : `input.${origin.path.join('.')}`;
}

function misuse(origin: InputOrigin, what: string): LoadError {
  const field = inputFieldLabel(origin);
  return new LoadError(
    `${field} of module "${origin.module}" is a value, not its real value, and ${what}. ` +
      'A module body can only pass an input field on: into a provision() binding or as a resolve() dependency. ' +
      `To compute with it, it must be a plain field, not a wrapped or secret one; list it: resolve([${field}], ([v]) => …).`,
  );
}

/** What a coercion with `hint` did to a value, worded for a misuse error. */
export function primitiveMisuse(hint: string): string {
  switch (hint) {
    case 'string':
      return 'it was turned into text (a template literal or String())';
    case 'number':
      return 'it was turned into a number (arithmetic, or a comparison such as <)';
    default:
      return 'it was combined with + or compared with ==';
  }
}

/**
 * Builds the `input` a module body receives. Every property access returns a
 * value recording its key path, and the same path always returns the same
 * object, so Load's identity-keyed maps see one value per field. Any way of
 * reading the real value throws a LoadError naming the field.
 */
export function buildModuleInput(moduleAddress: NodeId): ModuleInput<StandardSchemaV1> {
  const byPath = new Map<string, object>();

  const valueAt = (path: readonly string[]): object => {
    const key = JSON.stringify(path);
    const existing = byPath.get(key);
    if (existing !== undefined) return existing;
    const origin: InputOrigin = Object.freeze({
      kind: 'input' as const,
      module: moduleAddress,
      path: Object.freeze([...path]),
    });
    const thrower = (what: string) => () => {
      throw misuse(origin, what);
    };
    const handler: ProxyHandler<object> = {
      get(_target, property) {
        if (property === VALUE) return true;
        if (property === VALUE_ORIGIN) return origin;
        if (property === Symbol.toPrimitive) {
          return (hint: string) => {
            throw misuse(origin, primitiveMisuse(hint));
          };
        }
        if (property === 'toString') return thrower('its toString() was called');
        if (property === 'valueOf') return thrower('its valueOf() was called');
        if (property === 'toJSON') return thrower('it was serialized with JSON.stringify');
        if (property === Symbol.iterator || property === Symbol.asyncIterator) {
          return thrower('it was iterated (array spread, for…of or array destructuring)');
        }
        if (typeof property === 'symbol') return undefined;
        return valueAt([...path, property]);
      },
      has(_target, property) {
        if (property === VALUE || property === VALUE_ORIGIN) return true;
        if (typeof property === 'symbol') return false;
        throw misuse(origin, `it was checked with the in operator ("${property}" in …)`);
      },
      ownKeys() {
        throw misuse(
          origin,
          'its keys were listed (Object.keys, object spread, for…in or Object.entries)',
        );
      },
      getOwnPropertyDescriptor() {
        throw misuse(origin, 'its properties were inspected');
      },
      set(_target, property) {
        throw misuse(origin, `its field "${String(property)}" was assigned to`);
      },
      defineProperty(_target, property) {
        throw misuse(origin, `its field "${String(property)}" was assigned to`);
      },
      deleteProperty() {
        throw misuse(origin, 'a property was deleted from it');
      },
      setPrototypeOf() {
        throw misuse(origin, 'its prototype was changed');
      },
      preventExtensions() {
        throw misuse(origin, 'it was frozen or sealed');
      },
    };
    // util.inspect and console.log read the proxy's target without calling any trap, so the description sits on the target.
    const target = Object.create(null);
    Object.defineProperty(target, INSPECT, {
      value: () => `[${inputFieldLabel(origin)} of module "${origin.module}"]`,
      configurable: true,
    });
    const proxy = new Proxy(target, handler);
    byPath.set(key, proxy);
    return proxy;
  };

  return blindCast<
    ModuleInput<StandardSchemaV1>,
    'the proxy answers the value brand and origin, and returns a further proxy for every string key, which is the shape ModuleInput describes'
  >(valueAt([]));
}
