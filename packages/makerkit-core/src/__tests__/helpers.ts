import type { Connection, Params, Values } from '../config.ts';
import type { Contract } from '../contract.ts';

/** A test connection: declared params + a recording/simple hydrate. */
export const conn = <P extends Params, C>(
  params: P,
  make: (values: Values<P>) => C | Promise<C>,
): Connection<P, C> => ({ params, hydrate: make });

/**
 * A stand-in provider contract — kind-satisfies, mirroring what a pack ships
 * for its resources (e.g. postgresContract): every value of the same kind
 * satisfies, even across duplicated module instances.
 */
export const providerContract = <K extends string, Cmp>(kind: K, cmp: Cmp): Contract<K, Cmp> =>
  Object.freeze({
    kind,
    __cmp: cmp,
    satisfies: (required: Contract<K, unknown>) => required.kind === kind,
  });
