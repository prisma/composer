/**
 * The `PgWarm` Alchemy resource (slice 3, FT-5226) — warm a freshly-provisioned
 * Prisma Postgres database at apply-time so it is ready by deploy-end, and the
 * first real connection (a service's runtime client, or the migration) doesn't
 * eat the cold-start reject.
 *
 * The DB `url` is a lazy `Output` at lowering time, so warming must be an
 * apply-time tracked resource (same pattern as `PnMigration`): its `reconcile`
 * receives the RESOLVED url and connects with `withConnectionRetry` + `select 1`,
 * riding out the cold-start. Shared by BOTH the bare-`postgres` and the
 * `prisma-next` lowerings; keyed on the connection `url`, so an unchanged
 * redeploy is a no-op (warming is idempotent anyway).
 *
 * Deploy-time only: imports `pg` directly + `alchemy`. Imported by `control.ts`
 * and tests, never by `index.ts` / the `./prisma-next` authoring entry — the
 * isolation invariants hold.
 */
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import pg from 'pg';
import { normalizeSslMode, withConnectionRetry } from './pg-connection.ts';

export interface PgWarmProps {
  /** The live DB connection string (an Alchemy Output at wiring time, resolved at apply). */
  readonly url: string;
}

export interface PgWarmAttributes {
  /** The same `url` echoed back — so downstream resources can depend on "warmed". */
  readonly url: string;
}

export type PgWarm = Resource<'PrismaCloud.PgWarm', PgWarmProps, PgWarmAttributes>;

/** The `PgWarm` resource constructor — `yield* PgWarm(id, { url })` in a lowering. */
export const PgWarm = Resource<PgWarm>('PrismaCloud.PgWarm');

/**
 * Connect (retrying the cold-start) and run `select 1`, then release the
 * connection. Exported so tests can drive it directly; `retry` overrides the
 * bounded retry's defaults.
 */
export async function warmDatabase(
  url: string,
  retry: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<void> {
  await withConnectionRetry(async () => {
    const client = new pg.Client({ connectionString: normalizeSslMode(url) });
    // A cold upstream can accept the connect and then drop the socket (FT-5226's
    // second shape). pg reports that by emitting 'error' on the client, which is
    // an uncaught exception with no listener — raised outside this promise, so
    // the retry above never sees it and it would kill the deploy instead. The
    // query/end rejection is what the retry acts on.
    client.on('error', (error) => console.error('pg warm client socket error', error));
    await client.connect();
    try {
      await client.query('select 1');
    } finally {
      await client.end();
    }
  }, retry);
}

/**
 * The `PgWarm` provider service. `reconcile` warms the DB (retrying the
 * cold-start) and echoes the `url` so a downstream resource that reads
 * `warm.url` runs only after the DB is warm. Idempotent — safe on redeploy;
 * nothing to enumerate (`list` → `[]`) or tear down (`delete` → no-op; the DB's
 * own deletion handles teardown). Exported so tests can drive it directly.
 */
export const pgWarmProviderService: Provider.ProviderService<PgWarm> = {
  list: () => Effect.succeed([]),
  reconcile: ({ news }) =>
    Effect.tryPromise({
      try: () => warmDatabase(news.url),
      // Exhausted retries mean the DB is unreachable at deploy-end — fail the
      // deploy loudly rather than ship a service that can't reach its database.
      catch: (error) => error,
    }).pipe(Effect.map(() => ({ url: news.url }))),
  delete: () => Effect.void,
};

/** The `PgWarm` provider layer — merged into the extension descriptor's `providers()`. */
export const PgWarmProvider = () => Provider.effect(PgWarm, Effect.succeed(pgWarmProviderService));
