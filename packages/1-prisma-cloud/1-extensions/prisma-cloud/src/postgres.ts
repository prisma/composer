import type { Contract, DependencyEnd, ResourceNode } from '@internal/core';
import { dependency, resource, string } from '@internal/core';

export interface PostgresConfig {
  readonly url: string;
}

/**
 * The contract a Postgres provides — and the contract its consumers require.
 * `satisfies` compares KIND, not identity: an extension module can be duplicated
 * across a workspace (same rationale as the Symbol.for node brand), and every
 * duplicate's contract must still satisfy. `__cmp` is the connection config a
 * postgres offers; core never inspects it.
 */
export const postgresContract: Contract<'postgres', PostgresConfig> = Object.freeze({
  kind: 'postgres',
  __cmp: { url: '' },
  satisfies: (required: Contract<'postgres', unknown>) => required.kind === 'postgres',
});

/**
 * The one Postgres factory; the argument shape picks the role.
 *
 * `{ name }` — the resource identity a module provisions: the ONE place the
 * database exists, providing `postgresContract`. Return type declared
 * explicitly so nothing widens.
 */
export function postgres(opts: { name: string }): ResourceNode<typeof postgresContract>;
/**
 * `postgres()` — a service's dependency on a Postgres. Its binding (what
 * `load()` returns) is the typed connection config `PostgresConfig` itself —
 * the most-derived thing the contract alone can construct. The app builds its
 * own client from `{ url }` with its own driver, in app code (ADR-0015):
 * `const sql = new SQL({ url: db.url })`. No driver choice lives in the
 * declaration.
 */
export function postgres(): DependencyEnd<PostgresConfig, typeof postgresContract>;
export function postgres(opts?: {
  name: string;
}): ResourceNode<typeof postgresContract> | DependencyEnd<PostgresConfig, typeof postgresContract> {
  if (opts?.name !== undefined) {
    return resource({
      name: opts.name,
      extension: '@prisma/compose-prisma-cloud',
      provides: postgresContract,
    });
  }
  return dependency({
    type: 'postgres',
    connection: {
      params: { url: string({ secret: true }) },
      // The binding IS the typed config: hydrate is the identity on its values
      // ({ url: string } = PostgresConfig). The app constructs its own client.
      hydrate: (v): PostgresConfig => v,
    },
    required: postgresContract,
  });
}
