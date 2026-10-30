import { describeKind } from '@internal/foundation/errors';

/**
 * The text the config pool holds for `name`, as an environment variable would: `undefined` when it is absent or empty.
 * Throws the error `notText` builds when the pool holds anything else there.
 */
export function poolText(
  pool: Readonly<Record<string, unknown>>,
  name: string,
  notText: (kind: string) => Error,
): string | undefined {
  const value = pool[name];
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string') return value;
  throw notText(describeKind(value));
}
