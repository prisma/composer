import { POINTER } from '@internal/foundation/pointer';
import { isPlainObject, isValue, originOf } from './value.ts';

/**
 * Resource props as plain data that `structuredClone` copies unchanged, so two props compare by
 * content with `isDeepStrictEqual` even after one crossed a thread. Every object or array is
 * tagged by what it was, so no two different props give the same data:
 *
 * - a `Value` is described by what core knows of it: a source by its kind, pointer kind, label,
 *   secrets key and payload; any other value only as derived, with the kind of its origin;
 * - a `Date`, `RegExp`, `Map` or `Set` keeps its content;
 * - an instance of another class keeps its class name and own enumerable fields;
 * - a function or symbol becomes its text;
 * - a reference back to an object that contains it becomes a cycle marker.
 */
export function comparableProps(props: unknown): unknown {
  return asData(props, new Set());
}

function asData(value: unknown, containing: Set<object>): unknown {
  if (typeof value === 'function') return { function: String(value) };
  if (typeof value === 'symbol') return { symbol: String(value) };
  if (typeof value !== 'object' || value === null) return value;
  if (containing.has(value)) return { cycle: true };
  containing.add(value);
  try {
    return objectAsData(value, (inner) => asData(inner, containing));
  } finally {
    containing.delete(value);
  }
}

function objectAsData(value: object, inner: (value: unknown) => unknown): unknown {
  if (isValue(value)) {
    const origin = originOf(value);
    if (origin.kind !== 'source') return { value: { derived: origin.kind } };
    return {
      value: {
        sourceKind: origin.sourceKind,
        pointer: Reflect.get(value, POINTER),
        label: origin.label,
        secretsKey: origin.sourceKind === 'secret' ? origin.secretsKey : undefined,
        payload: inner(Reflect.get(value, 'payload')),
      },
    };
  }
  if (Array.isArray(value)) return { array: value.map(inner) };
  if (value instanceof Date) return { date: value.getTime() };
  if (value instanceof RegExp) return { regexp: String(value) };
  if (value instanceof Map)
    return { map: [...value].map(([key, entry]) => [inner(key), inner(entry)]) };
  if (value instanceof Set) return { set: [...value].map(inner) };
  const fields = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, inner(entry)]),
  );
  if (isPlainObject(value)) return { object: fields };
  return { instance: value.constructor?.name, fields };
}
