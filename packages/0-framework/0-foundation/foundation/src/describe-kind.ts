/** How an error names the kind of a value it did not expect, without printing the value. */
export function describeKind(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}
