/**
 * Asserts that a value is defined (not null or undefined).
 * Use for invariants where the value should always exist at runtime.
 *
 * @throws Error if value is null or undefined
 *
 * @example
 * ```typescript
 * const port = config.ports[name];
 * assertDefined(port, `Port "${name}" not found`);
 * // port is now narrowed to non-nullable
 * ```
 */
export function assertDefined<T>(value: T | null | undefined, message: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}

/**
 * Asserts that a condition is true.
 * Use for invariants that should always hold at runtime.
 *
 * @throws Error if condition is false
 *
 * @example
 * ```typescript
 * invariant(edges.length > 0, 'A wired module must have at least one connection');
 * ```
 */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
