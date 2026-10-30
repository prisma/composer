import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Value } from './core.ts';

// The same registered symbols core's value.ts uses, so core's isValue() and originOf() read these objects unchanged.
const VALUE = Symbol.for('prisma:value');
const VALUE_ORIGIN = Symbol.for('prisma:value-origin');
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** The origin kind this probe adds beside core's 'environment' and 'computed'. */
export interface InputOrigin {
  readonly kind: 'input';
  /** The address of the module whose input this field is. */
  readonly module: string;
  /** The key path inside that module's input; `[]` is the whole input. */
  readonly path: readonly string[];
}

type PlainObject = { readonly [key: string]: unknown };

/**
 * What a module body holds for an input field whose real value has type `T`:
 * a value, plus one value per key when `T` is a plain object.
 */
export type InputValue<T> = Value<T> & FieldsOf<T>;

type FieldsOf<T> = [NonNullable<T>] extends [never]
  ? unknown
  : [NonNullable<T>] extends [readonly unknown[]]
    ? unknown
    : [NonNullable<T>] extends [PlainObject]
      ? Fields<NonNullable<T>, undefined extends T ? undefined : never>
      : unknown;

// `Absent` carries a parent's optionality down: if `a` may be absent, so may `a.b`.
type Fields<O, Absent> = {
  readonly [K in keyof O & string]-?: InputValue<FieldType<O, K> | Absent>;
};

// An optional key's real value may be undefined even under exactOptionalPropertyTypes.
type FieldType<O, K extends keyof O> = {} extends Pick<O, K> ? O[K] | undefined : O[K];

/** The `input` a module body receives for schema `S`. */
export type InputValues<S extends StandardSchemaV1> = InputValue<StandardSchemaV1.InferOutput<S>>;

export class InputValueMisuse extends Error {
  override readonly name = 'InputValueMisuse';
}

function describe(origin: InputOrigin): string {
  const field = origin.path.length === 0 ? 'input' : `input.${origin.path.join('.')}`;
  return `${field} of module "${origin.module}"`;
}

function misuse(origin: InputOrigin, what: string): InputValueMisuse {
  const field = origin.path.length === 0 ? 'input' : `input.${origin.path.join('.')}`;
  return new InputValueMisuse(
    `${describe(origin)} is a value, not its real value, and ${what}. ` +
      'A module body can only pass an input field on: into a provision() input or as a resolve() dependency. ' +
      `To compute with it, list it: resolve([${field}], ([v]) => …).`,
  );
}

function primitiveMisuse(hint: string): string {
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
 * Builds the `input` object for the module at `moduleAddress`. Every property
 * access returns a value recording its key path; the same path always returns
 * the same object, so identity-keyed maps in Load see one value per field.
 */
export function inputValues<S extends StandardSchemaV1>(moduleAddress: string): InputValues<S> {
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
      value: () => `[${describe(origin)}]`,
      configurable: true,
    });
    const proxy = new Proxy(target, handler);
    byPath.set(key, proxy);
    return proxy;
  };

  return valueAt([]) as InputValues<S>;
}

/** The input origin of `value`, or undefined for any other value. */
export function inputOriginOf(value: unknown): InputOrigin | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const origin = (value as Record<PropertyKey, unknown>)[VALUE_ORIGIN] as
    | { kind?: unknown }
    | undefined;
  return origin?.kind === 'input' ? (origin as InputOrigin) : undefined;
}

export function describeInputOrigin(origin: InputOrigin): string {
  return origin.path.length === 0
    ? `the whole input of module "${origin.module}"`
    : `input "${origin.path.join('.')}" of module "${origin.module}"`;
}
