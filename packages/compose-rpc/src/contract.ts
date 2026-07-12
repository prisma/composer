/**
 * The RPC kind's Contract builder. Its Cmp is the concrete function map
 * `Fns` (each entry built by `rpc()`), never a mapped type over a schema map
 * — that is what makes @prisma/compose's plain assignability check apply real
 * function variance (contravariant input, covariant output). Load-time
 * compatibility is nominal: a value only satisfies itself.
 */
import type { Contract } from '@prisma/compose';

export function contract<
  // biome-ignore lint/suspicious/noExplicitAny: concrete function-map bound, matches contract-satisfaction.poc.ts.
  Fns extends Record<string, (input: any) => Promise<any>>,
>(fns: Fns): Contract<'rpc', Fns> {
  const value: Contract<'rpc', Fns> = {
    kind: 'rpc',
    __cmp: fns,
    satisfies: (required) => value === required,
  };
  return Object.freeze(value);
}
