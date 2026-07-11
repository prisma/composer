/**
 * `pnPostgres()` is the `prisma-next` kind's single entry, overloaded by what
 * it's given — the typed sibling of bare `postgres()` (untouched in
 * `postgres.ts`). A resource end takes `{ name, config }`, where
 * `config.contract` anchors the resource's provided contract; a dependency
 * end takes that same wrapped contract value and hydrates to a typed Prisma
 * Next client, `Client<Contract>`, over the injected `{ url }` connection.
 * This amends ADR-0015 for this one dep kind (see ADR-0021): Prisma Next is
 * framework-blessed like rpc, so the binding is the typed client itself, not
 * a config the app builds its own client from.
 *
 * `Cmp` (`PnCmp`) carries the deserialized contract data (`contractJson`,
 * read by hydrate) plus a type-only `_contract` anchor pinning the emitted
 * contract's branded `storageHash` literal — the lever that makes plain
 * TypeScript assignability between two wrapped contracts exact-version
 * equality. `satisfies()` mirrors it at Load with a real `storageHash`
 * comparison (not `rpc`'s identity check — this kind needs a genuine
 * version-equality test, since two distinct in-memory contract values can
 * carry the same hash).
 *
 * Marker verification is warn-only by construction, not by a wrapper here:
 * Prisma Next's own `verifyMarker: 'onFirstUse'` never throws on a mismatch
 * — confirmed by reading `@prisma-next/sql-runtime`'s `verifyMarker()`
 * implementation (not just its `.d.ts`): a missing or mismatched marker logs
 * `CONTRACT.MARKER_MISSING` / `CONTRACT.MARKER_MISMATCH` and returns. The one
 * gap: `@prisma-next/postgres@0.14.0`'s public `postgres()` options don't
 * forward a `log` sink to the runtime, so that warning lands in Prisma
 * Next's internal no-op logger and isn't visible anywhere by default in this
 * version — a Prisma Next limitation, not something hydrate can route around
 * without depending on unexported internals or querying the DB at hydrate
 * (which would break the lazy-pool contract). The "never throws" half of the
 * requirement holds regardless.
 */

import type { Contract, DependencyEnd, ResourceNode } from '@prisma/app';
import { dependency, resource } from '@prisma/app';
import type { Contract as PnRawContract } from '@prisma-next/contract/types';
import pnPostgresRuntime, { type PostgresClient } from '@prisma-next/postgres/runtime';
import type { SqlStorage } from '@prisma-next/sql-contract/types';

/**
 * Any Prisma Next contract this primitive can carry — the bound both
 * authoring modes (TS no-emit `defineContract()`, or PSL/emitted
 * `contract.d.ts`) satisfy.
 */
export type AnyPnContract = PnRawContract<SqlStorage>;

/**
 * The comparison payload behind a `prisma-next` Contract. `contractJson` is
 * the plain, deserialized contract data hydrate hands the Prisma Next
 * runtime — the same shape as an emitted `contract.json`, or a TS-authored
 * contract's own value (both satisfy `postgres()`'s `contractJson: unknown`
 * parameter). `_contract` never exists at runtime — it is the type-only
 * anchor that carries the emitted contract's type, so plain assignability
 * between two `PnCmp`s requires `_contract`'s type to match, which for a
 * branded `storageHash` literal means the hashes must be identical.
 */
export interface PnCmp<C extends AnyPnContract = AnyPnContract> {
  readonly contractJson: unknown;
  readonly _contract?: C;
}

/** The `prisma-next` kind: a Contract whose `Cmp` is `PnCmp`. */
export type PnPostgresContract<C extends AnyPnContract = AnyPnContract> = Contract<
  'prisma-next',
  PnCmp<C>
>;

/** Recovers the emitted contract type `C` a `prisma-next` Contract carries. */
export type PnContractOf<Ct> = Ct extends PnPostgresContract<infer C> ? C : never;

/** The typed client a consumer's `pnPostgres(contract)` dependency hydrates to. */
export type Client<Ct> = PostgresClient<PnContractOf<Ct>>;

/**
 * The resource end's config — the framework's own thin wrapper carrying the
 * wrapped `prisma-next` contract this database provides. Deliberately NOT
 * `@prisma-next/postgres/config`'s own `PrismaNextConfig`: that type anchors
 * Prisma Next's OWN CLI (`contract emit` / `migrate`) to a
 * `prisma-next.config.ts` file on disk, which is a separate, parallel
 * artifact this dispatch does not read (the deploy lowering that will read
 * it is slice 2's job). `connection` is accepted only to mirror the shape
 * the design sketched and is always ignored — the framework injects the
 * connection URL at hydrate (no-globals).
 */
export interface PnPostgresConfig<C extends PnPostgresContract = PnPostgresContract> {
  readonly contract: C;
  readonly connection?: unknown;
}

/**
 * Wraps a resolved Prisma Next contract value into the framework's
 * `prisma-next` Contract kind. Both the resource end's `config.contract` and
 * every dependency end reference the SAME wrapped value, the same way
 * `@prisma/app-rpc`'s `contract()` output feeds both a service's `expose`
 * and its consumers' `rpc(contract)` deps.
 *
 * Two overloads, mirroring `@prisma-next/postgres/runtime`'s own
 * `PostgresOptionsWithContract` / `PostgresOptionsWithContractJson` split:
 * - TS-authored, no-emit (`defineContract()`'s own return value): `C` is
 *   inferred from the argument, which already carries the branded types.
 * - Emitted (a deserialized `contract.json`, e.g. via a JSON module import):
 *   the argument's inferred type is plain JSON data, not the branded
 *   `contract.d.ts` type, so `C` cannot be inferred from it — pass it
 *   explicitly: `pnContract<Contract>(contractJson)`.
 */
export function pnContract<const C extends AnyPnContract>(contract: C): PnPostgresContract<C>;
export function pnContract<C extends AnyPnContract>(contractJson: unknown): PnPostgresContract<C>;
export function pnContract(contract: unknown): unknown {
  const value: PnPostgresContract = {
    kind: 'prisma-next',
    __cmp: { contractJson: contract },
    satisfies: (required) => {
      const requiredHash = storageHashOf(required);
      return requiredHash !== undefined && requiredHash === storageHashOf(value);
    },
  };
  return Object.freeze(value);
}

/**
 * `{ name, config }` — the resource identity a system provisions: the ONE
 * place the database exists, providing `config.contract`.
 */
export function pnPostgres<C extends PnPostgresContract>(opts: {
  name: string;
  config: PnPostgresConfig<C>;
}): ResourceNode<C>;
/**
 * `pnPostgres(contract)` — a service's dependency on a Prisma Next-typed
 * Postgres. Its binding is the typed Prisma Next client, constructed by the
 * framework in hydrate from the contract plus the injected connection URL.
 */
export function pnPostgres<C extends PnPostgresContract>(contract: C): DependencyEnd<Client<C>, C>;
export function pnPostgres(
  arg: { name: string; config: PnPostgresConfig } | PnPostgresContract,
): unknown {
  if (!isPnPostgresContract(arg)) {
    return resource({
      name: arg.name,
      extension: '@prisma/app-cloud',
      provides: arg.config.contract,
    });
  }
  const contract = arg;
  return dependency<{ url: { type: 'string'; secret: true } }, unknown, PnPostgresContract>({
    type: 'prisma-next',
    connection: {
      params: { url: { type: 'string', secret: true } },
      hydrate: ({ url }) => buildClient(contract, url),
    },
    required: contract,
  });
}

function isPnPostgresContract(value: unknown): value is PnPostgresContract {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'prisma-next' &&
    '__cmp' in value &&
    'satisfies' in value
  );
}

function buildClient<C extends PnPostgresContract>(contract: C, url: string): Client<C> {
  return pnPostgresRuntime<PnContractOf<C>>({
    contractJson: contract.__cmp.contractJson,
    url,
    verifyMarker: 'onFirstUse',
  });
}

/** Reads `__cmp.contractJson.storage.storageHash` off a `prisma-next` Contract, defensively — `__cmp` is opaque to core, so nothing guarantees its shape without a runtime check. */
function storageHashOf(contract: Contract<'prisma-next', unknown> | undefined): string | undefined {
  if (contract === undefined) return undefined;
  const cmp = contract.__cmp;
  if (typeof cmp !== 'object' || cmp === null || !('contractJson' in cmp)) return undefined;
  const contractJson = cmp.contractJson;
  if (typeof contractJson !== 'object' || contractJson === null || !('storage' in contractJson)) {
    return undefined;
  }
  const storage = contractJson.storage;
  if (typeof storage !== 'object' || storage === null || !('storageHash' in storage))
    return undefined;
  const hash = storage.storageHash;
  return typeof hash === 'string' ? hash : undefined;
}
