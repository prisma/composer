import type { Contract, DependencyEnd, ResourceNode } from '@internal/core';
import { dependency, resource, string } from '@internal/core';

export interface RawPostgresConfig {
  readonly url: string;
}

/**
 * The contract a Postgres provides — and the contract its consumers require.
 * `satisfies` compares KIND, not identity: an extension module can be duplicated
 * across a workspace (same rationale as the Symbol.for node brand), and every
 * duplicate's contract must still satisfy. `__cmp` is the connection config a
 * postgres offers; core never inspects it.
 */
export const rawPostgresContract: Contract<'raw-postgres', RawPostgresConfig> = Object.freeze({
  kind: 'raw-postgres',
  __cmp: { url: '' },
  satisfies: (required: Contract<'raw-postgres', unknown>) => required.kind === 'raw-postgres',
});

/**
 * The one Postgres factory; the argument shape picks the role.
 *
 * `{ name }` — the resource identity a module provisions: the ONE place the
 * database exists, providing `rawPostgresContract`. Return type declared
 * explicitly so nothing widens.
 */
export function rawPostgres(opts: { name: string }): ResourceNode<typeof rawPostgresContract>;
/**
 * `rawPostgres()` — a service's dependency on a Postgres. Its binding (what
 * `load()` returns) is the typed connection config `RawPostgresConfig` itself —
 * the most-derived thing the contract alone can construct. The app builds its
 * own client from `{ url }` with its own driver, in app code (ADR-0015):
 * `const sql = new SQL({ url: db.url })`. No driver choice lives in the
 * declaration.
 */
export function rawPostgres(): DependencyEnd<RawPostgresConfig, typeof rawPostgresContract>;
export function rawPostgres(opts?: {
  name: string;
}):
  | ResourceNode<typeof rawPostgresContract>
  | DependencyEnd<RawPostgresConfig, typeof rawPostgresContract> {
  if (opts?.name !== undefined) {
    return resource({
      name: opts.name,
      extension: '@prisma/composer-prisma-cloud',
      provides: rawPostgresContract,
    });
  }
  return dependency({
    type: 'raw-postgres',
    connection: {
      params: { url: string() },
      // The binding IS the typed config: hydrate is the identity on its values
      // ({ url: string } = RawPostgresConfig). The app constructs its own client.
      hydrate: (v): RawPostgresConfig => v,
    },
    required: rawPostgresContract,
  });
}
