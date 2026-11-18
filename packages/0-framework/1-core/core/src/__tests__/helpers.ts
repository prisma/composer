import type { Pointer } from '@internal/foundation/pointer';
import type { SecretString } from '@internal/foundation/secret';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ConfigDeclaration, Connection, Params, Values } from '../config.ts';
import type { Contract } from '../contract.ts';
import { paramSource, secretSource, valueResource } from '../node.ts';

/** A pass-anything Standard Schema for input-schema tests — Load never validates a binding; the deploy target does. */
export const anyInputSchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

/** A test connection: declared params + a recording/simple hydrate. */
export const conn = <P extends Params, C>(
  params: P,
  make: (values: Values<P>) => C | Promise<C>,
): Connection<P, C> => ({ params, hydrate: make });

/**
 * A stand-in provider contract — kind-satisfies, mirroring what a pack ships
 * for its resources (e.g. rawPostgresContract): every value of the same kind
 * satisfies, even across duplicated module instances.
 */
export const providerContract = <K extends string, Cmp>(kind: K, cmp: Cmp): Contract<K, Cmp> =>
  Object.freeze({
    kind,
    __cmp: cmp,
    satisfies: (required: Contract<K, unknown>) => required.kind === kind,
  });

/** The ConfigDeclaration `configOf` produces for a scalar param — one place for the shape. */
export function scalarDeclaration(
  owner: ConfigDeclaration['owner'],
  name: string,
  opts: { optional?: boolean; default?: unknown } = {},
): ConfigDeclaration {
  return {
    owner,
    name,
    schema: { vendor: '@prisma/composer' },
    optional: opts.optional ?? false,
    default: opts.default,
  };
}

interface TestPayload {
  readonly name: string;
}

export const plainValue = (name: string, id = name.toLowerCase().replaceAll('_', '')) =>
  valueResource({
    name: id,
    extension: 'test/pack',
    type: 'test-value',
    props: { name },
    value: paramSource<TestPayload, Pointer<string>>(
      { name },
      { label: `the test value "${name}"` },
    ),
  });

export const secretValue = (name: string, id = name.toLowerCase().replaceAll('_', '')) =>
  valueResource({
    name: id,
    extension: 'test/pack',
    type: 'test-value',
    props: { name },
    value: secretSource<TestPayload, Pointer<SecretString>>(
      { name },
      { label: `the test secret "${name}"`, secretsKey: name },
    ),
  });
