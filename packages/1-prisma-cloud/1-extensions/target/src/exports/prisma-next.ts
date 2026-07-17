/**
 * `pnPostgres()` is the `prisma-next` kind's single entry, overloaded: a
 * resource end takes `{ name, contract }`; a dependency end hydrates the
 * contract into a typed Prisma Next client (ADR-0022). No runtime schema check.
 */

import type { Contract, DependencyEnd, ResourceNode, ServiceNode } from '@internal/core';
import { dependency, freezeNode, ResourceNodeBase, string } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import pnPostgresRuntime, { type PostgresClient } from '@prisma-next/postgres/runtime';
import type { SqlStorage } from '@prisma-next/sql-contract/types';
import pg from 'pg';
import { normalizeSslMode, retryTransientConnect } from './pg-connection.ts';

/**
 * Any Prisma Next contract this primitive can carry — the bound both
 * authoring modes (TS no-emit `defineContract()`, or PSL/emitted
 * `contract.d.ts`) satisfy.
 */
export type AnyPnContract = import('@prisma-next/contract/types').Contract<SqlStorage>;

/**
 * The comparison payload behind a `prisma-next` Contract. `_contract` is a
 * type-only anchor so plain assignability between two `PnCmp`s means the
 * branded `storageHash` literals match.
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
 * The `prisma-next` resource node: a core Resource node plus `config`, the
 * `prisma-next.config.ts` path the deploy-only migration lowering loads to
 * find the migrations directory — the app build never imports it.
 */
export class PnPostgresResourceNode<
  C extends PnPostgresContract = PnPostgresContract,
> extends ResourceNodeBase<C> {
  readonly config: string;
  /** Optional target ref NAME (`migrations/app/refs/<name>.json`) — see `pnPostgres`. */
  declare readonly targetRef?: string;

  constructor(def: { name: string; contract: C; config: string; targetRef?: string }) {
    super({ name: def.name, extension: '@prisma/composer-prisma-cloud', provides: def.contract });
    this.config = def.config;
    if (def.targetRef !== undefined) this.targetRef = def.targetRef;
    freezeNode(this);
  }
}

/** Narrows `ctx.node` to a `pnPostgres` resource node so the deploy lowering reads `config` without a bare cast. Structural, never `instanceof`. */
export function isPnPostgresResourceNode(
  node: ServiceNode | ResourceNode,
): node is PnPostgresResourceNode {
  return (
    node.kind === 'resource' &&
    node.type === 'prisma-next' &&
    'config' in node &&
    typeof node.config === 'string'
  );
}

/**
 * Wraps a resolved Prisma Next contract value into the framework's
 * `prisma-next` Contract kind. Two overloads: TS-authored (`C` inferred) vs.
 * emitted JSON (`C` passed explicitly, e.g. `pnContract<Contract>(contractJson)`).
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
 * `{ name, contract, config, targetRef? }` — the resource identity a module
 * provisions. `config` is the deploy-only `prisma-next.config.ts` path;
 * `targetRef` optionally names a ref as the migration target.
 */
export function pnPostgres<C extends PnPostgresContract>(opts: {
  name: string;
  contract: C;
  config: string;
  targetRef?: string;
}): PnPostgresResourceNode<C>;
/**
 * `pnPostgres(contract)` — a service's dependency on a Prisma Next-typed
 * Postgres. Its binding is the typed Prisma Next client, constructed by the
 * framework in hydrate from the contract plus the injected connection URL.
 */
export function pnPostgres<C extends PnPostgresContract>(contract: C): DependencyEnd<Client<C>, C>;
export function pnPostgres(
  arg:
    | { name: string; contract: PnPostgresContract; config: string; targetRef?: string }
    | PnPostgresContract,
): unknown {
  if (!isPnPostgresContract(arg)) {
    return new PnPostgresResourceNode(arg);
  }
  const contract = arg;
  return dependency({
    type: 'prisma-next',
    connection: {
      params: { url: string() },
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

/**
 * Builds the typed Prisma Next client over a connection pool that rides out
 * a transient cold-start (FT-5226). We pass our own `pg.Pool` rather than a
 * bare `url`: the runtime's bare-`url` connect is a one-shot that fails
 * permanently, but a pool connects lazily on first query, so a bounded retry there suffices.
 */
function buildClient<C extends PnPostgresContract>(contract: C, url: string): Client<C> {
  return pnPostgresRuntime<PnContractOf<C>>({
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
