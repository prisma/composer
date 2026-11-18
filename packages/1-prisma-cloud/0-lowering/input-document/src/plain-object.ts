export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function setOwn<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export type JsonData =
  | string
  | number
  | boolean
  | null
  | readonly JsonData[]
  | { readonly [key: string]: JsonData };

export function isJsonData(value: unknown): value is JsonData {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonData);
  return isPlainObject(value) && Object.values(value).every(isJsonData);
}
