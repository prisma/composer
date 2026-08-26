/**
 * `postgres()` is the `postgres` kind's single entry, overloaded: a
 * resource end takes `{ name, contract }`; a dependency end hydrates to a
 * `{ url, client }` binding whose typed client is built lazily (ADR-0022,
 * ADR-0040). No runtime schema check.
 */

import type { Contract, DependencyEnd, ResourceNode, ServiceNode } from '@internal/core';
import { dependency, freezeNode, ResourceNodeBase, string } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { SqlStorage } from '@prisma/orm-postgres/family-contract/types';
import ormPostgresRuntime, { type PostgresClient } from '@prisma/orm-postgres/runtime';
import pg from 'pg';
import { normalizeSslMode, retryTransientConnect } from './pg-connection.ts';
import { type RequiredPackHead, requiredPackHeadOf } from './required-pack-head.ts';

export type { RequiredPackHead } from './required-pack-head.ts';
export { requiredPackHead, requiredPackHeadOf } from './required-pack-head.ts';

/**
 * Any Prisma ORM contract this primitive can carry — the bound both
 * authoring modes (TS no-emit `defineContract()`, or PSL/emitted
 * `contract.d.ts`) satisfy.
 */
export type AnyOrmContract = import('@prisma/orm-postgres/contract/types').Contract<SqlStorage>;

/**
 * The comparison payload behind a `postgres` Contract. `_contract` is a
 * type-only anchor so plain assignability between two `OrmCmp`s means the
 * branded `storageHash` literals match. `requiredPackHead` is the pack-head
 * claim a `requiredPackHead()` contract carries instead of a contract value.
 */
export interface OrmCmp<C extends AnyOrmContract = AnyOrmContract> {
  readonly contractJson: unknown;
  readonly requiredPackHead?: RequiredPackHead;
  readonly _contract?: C;
}

/** The `postgres` kind: a Contract whose `Cmp` is `OrmCmp`. */
export type PostgresContract<C extends AnyOrmContract = AnyOrmContract> = Contract<
  'postgres',
  OrmCmp<C>
>;

/** Recovers the emitted contract type `C` a `postgres` Contract carries. */
export type OrmContractOf<Ct> = Ct extends PostgresContract<infer C> ? C : never;

/** The typed Prisma ORM client, reachable as `binding.client` on a `postgres(contract)` dependency. */
export type Client<Ct> = PostgresClient<OrmContractOf<Ct>>;

/**
 * The binding a consumer's `postgres(contract)` dependency hydrates to
 * (ADR-0040): the raw connection URL, plus the typed client — constructed on
 * first access, memoized thereafter.
 */
export interface PostgresBinding<Ct> {
  readonly url: string;
  readonly client: Client<Ct>;
}

/**
 * The `postgres` resource node: a core Resource node plus `config`, the
 * `prisma.config.ts` path the deploy-only migration lowering loads to
 * find the migrations directory — the app build never imports it.
 */
export class PostgresResourceNode<
  C extends PostgresContract = PostgresContract,
> extends ResourceNodeBase<C> {
  readonly config: string;
  /** Optional target ref NAME (`migrations/app/refs/<name>.json`) — see `postgres`. */
  declare readonly targetRef?: string;

  constructor(def: { name: string; contract: C; config: string; targetRef?: string }) {
    super({ name: def.name, extension: '@prisma/composer-prisma-cloud', provides: def.contract });
    this.config = def.config;
    if (def.targetRef !== undefined) this.targetRef = def.targetRef;
    freezeNode(this);
  }
}

/** Narrows `ctx.node` to a `postgres` resource node so the deploy lowering reads `config` without a bare cast. Structural, never `instanceof`. */
export function isPostgresResourceNode(
  node: ServiceNode | ResourceNode,
): node is PostgresResourceNode {
  return (
    node.kind === 'resource' &&
    node.type === 'postgres' &&
    'config' in node &&
    typeof node.config === 'string'
  );
}

/**
 * Wraps a resolved Prisma ORM contract value into the framework's
 * `postgres` Contract kind. Two overloads: TS-authored (`C` inferred) vs.
 * emitted JSON (`C` passed explicitly, e.g. `dataContract<Contract>(contractJson)`).
 */
export function dataContract<const C extends AnyOrmContract>(contract: C): PostgresContract<C>;
export function dataContract<C extends AnyOrmContract>(contractJson: unknown): PostgresContract<C>;
export function dataContract(contract: unknown): unknown {
  const value: PostgresContract = {
    kind: 'postgres',
    __cmp: { contractJson: contract },
    satisfies: (required) => {
      // A required pack head is wireable to ANY pn database: whether the
      // wired resource's config actually lists the pack at the required head
      // is enforced by the deploy preflight, not here — the authoring-side
      // contract value cannot see the resource's prisma.config.ts.
      if (requiredPackHeadOf(required) !== undefined) return true;
      const requiredHash = storageHashOf(required);
      return requiredHash !== undefined && requiredHash === storageHashOf(value);
    },
  };
  return Object.freeze(value);
}

/**
 * `{ name, contract, config, targetRef? }` — the resource identity a module
 * provisions. `config` is the deploy-only `prisma.config.ts` path;
 * `targetRef` optionally names a ref as the migration target.
 */
export function postgres<C extends PostgresContract>(opts: {
  name: string;
  contract: C;
  config: string;
  targetRef?: string;
}): PostgresResourceNode<C>;
/**
 * `postgres(contract)` — a service's dependency on a Prisma-ORM-typed
 * Postgres. Its binding carries the raw connection URL and the typed Prisma
 * Next client, built lazily on first `client` access (ADR-0040).
 */
export function postgres<C extends PostgresContract>(
  contract: C,
): DependencyEnd<PostgresBinding<C>, C>;
export function postgres(
  arg:
    | { name: string; contract: PostgresContract; config: string; targetRef?: string }
    | PostgresContract,
): unknown {
  if (!isPostgresContract(arg)) {
    return new PostgresResourceNode(arg);
  }
  const contract = arg;
  return dependency({
    type: 'postgres',
    connection: {
      params: { url: string() },
      hydrate: ({ url }) => bindLazyClient(contract, url),
    },
    required: contract,
  });
}

function isPostgresContract(value: unknown): value is PostgresContract {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'postgres' &&
    '__cmp' in value &&
    'satisfies' in value
  );
}

/**
 * The hydrated binding: `url` as delivered, `client` built by `buildClient`
 * on first access. Construction stays out of hydrate because the runtime
 * validates `contractJson` eagerly — deferring it keeps a bad contract from
 * poisoning `load()` and spares URL-only consumers the cost (ADR-0040).
 */
function bindLazyClient<C extends PostgresContract>(contract: C, url: string): PostgresBinding<C> {
  let client: Client<C> | undefined;
  return Object.freeze({
    url,
    get client(): Client<C> {
      client ??= buildClient(contract, url);
      return client;
    },
  });
}

/**
 * Builds the typed Prisma ORM client over a connection pool that rides out
 * a transient cold-start (FT-5226). We pass our own `pg.Pool` rather than a
 * bare `url`: the runtime's bare-`url` connect is a one-shot that fails
 * permanently, but a pool connects lazily on first query, so a bounded retry there suffices.
 */
function buildClient<C extends PostgresContract>(contract: C, url: string): Client<C> {
  return ormPostgresRuntime<OrmContractOf<C>>({
    contractJson: contract.__cmp.contractJson,
    // Explicit binding, NOT `pg: pool`: the bare form sniffs the pool with
    // `instanceof`, which breaks whenever a bundle carries two copies of pg
    // (the pool from one, the runtime's Pool class from the other).
    binding: { kind: 'pgPool', pool: resilientPool(url) },
  });
}

/**
 * A `pg.Pool` whose connection acquisition retries a transient cold-start
 * (bounded ~1 min). Only `pool.connect()` is wrapped — a real query error
 * still surfaces at once from `client.query()`.
 */
function resilientPool(url: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: normalizeSslMode(url),
    connectionTimeoutMillis: 20_000,
    // Prisma Postgres closes idle direct connections well under 30s
    // (FT-5219). Discard idle clients first, or the first query after an
    // idle spell grabs a dead socket and fails with "Connection terminated
    // unexpectedly" — a 500, since it surfaces at query() time where
    // retryTransientConnect (which wraps only connect()) can't help.
    idleTimeoutMillis: 5_000,
  });
  // The server closing an idle pooled client emits an async 'error' on the
  // pool; unhandled, that crashes the process. Log it — the pool already
  // discards the dead client and reconnects on the next acquire.
  pool.on('error', (err) => console.error('pg pool idle client error', err));
  const acquire = pool.connect.bind(pool);
  pool.connect = blindCast<
    typeof pool.connect,
    'the pn postgres pool driver only calls pool.connect() (the no-arg promise form)'
  >(() => retryTransientConnect(() => acquire()));
  return pool;
}

/** Reads `__cmp.contractJson.storage.storageHash` off a `postgres` Contract, defensively — `__cmp` is opaque to core, so nothing guarantees its shape without a runtime check. */
function storageHashOf(contract: Contract<'postgres', unknown> | undefined): string | undefined {
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
