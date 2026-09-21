/**
 * Local postgres-cluster providers: upstream alchemy's `Prisma.Database` and
 * `Prisma.Connection` become clients of the `postgres-main` emulator daemon
 * (one named, persistent `@prisma/dev` server per `Database` resource).
 * `PgWarm`/`OrmMigration` are not here — the hosted ones run against whatever
 * URL they are handed. Attributes match upstream's shapes; the daemon's
 * DIRECT connection string maps to `directConnectionString` and
 * `databaseUrl`, everything else is left absent. Instance names come from
 * `@internal/dev-emulators`' own `instanceNameFor` — a locally re-derived
 * slug drifted from the daemon's and broke `Connection`'s lookup.
 */
import { createRequire } from 'node:module';
import type { LocalTargetProvidersInput } from '@internal/core/config';
import { instanceNameFor, postgresClient, slug } from '@internal/dev-emulators';
import * as Prisma from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import { appNameOf } from './app-name.ts';
import { DEV_TIMESTAMP, projectIdOfInput } from './upstream-attributes.ts';

/** Reads a database id from upstream's `database` input: a plain string or a resolved `Prisma.Database` attributes record. */
function databaseIdOfInput(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Predicate.isObject(value) && typeof value['databaseId'] === 'string')
    return value['databaseId'];
  return undefined;
}

function noPrismaDevError(cause: unknown): Error {
  return new Error(
    `local dev needs @prisma/dev for its local Postgres emulator — @prisma/composer-prisma-cloud declares it as a dependency, but it did not resolve from Composer's own installation; reinstall your dependencies. (${cause instanceof Error ? cause.message : String(cause)})`,
  );
}

/**
 * Composer owns the local Postgres emulator's version: `@prisma/dev` is a
 * dependency of `@prisma/composer-prisma-cloud` and is resolved from
 * Composer's own package, never from the app. The app's copy (if any) is
 * ignored on purpose — an old `@prisma/dev` pulled in transitively (alchemy
 * pins `^0.20.0`, whose pglite-socket crashes on any message over 64 KiB)
 * would otherwise silently replace the version Composer tested against.
 * The daemon imports the returned path dynamically.
 */
export function resolvePrismaDevModulePath(): string {
  try {
    return createRequire(import.meta.url).resolve('@prisma/dev');
  } catch (cause) {
    throw noPrismaDevError(cause);
  }
}

/**
 * `Prisma.Database` → an ensured `postgres-main` server, one per resource.
 * Stores the daemon's returned url as the `directConnectionString` attribute.
 */
export function LocalDatabaseProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Prisma.Database>> {
  const service: Provider.ProviderService<Prisma.Database> = {
    list: () => Effect.succeed([]),
    /**
     * Never noop: the reconcile's PUT is the only thing that (re)starts a
     * database server, and a restarted daemon drops them all — a noop warm
     * `dev` reported ready over dead ports (FRICTION #15; Compute's twin is
     * `startServices`, ADR-0041). Attributes are declared stable while the
     * daemon still records the URL Alchemy has (the port is pinned), so
     * consumers keep noop-ing; a moved URL reconverges them via Alchemy's diff.
     */
    diff: ({ olds, news, output }) =>
      Effect.tryPromise({
        try: async () => {
          const recorded = output?.directConnectionString;
          // `news` may still hold Outputs at plan time; an unresolved name is never "same".
          const sameName = Predicate.hasProperty(news, 'name') && news.name === olds.name;
          if (output === undefined || recorded === undefined || !sameName) {
            return { action: 'update' as const };
          }
          const listed = await postgresClient().listDatabases(appNameOf(input.container));
          const pinned = listed.some(
            (db) => db.instanceName === output.databaseId && db.url === Redacted.value(recorded),
          );
          return pinned
            ? { action: 'update' as const, stables: Object.keys(output) }
            : { action: 'update' as const };
        },
        catch: (cause) => cause,
      }),
    reconcile: ({ id, news }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          // Hosted branch-stage deploys omit the display name (see
          // descriptors/postgres.ts); local dev never has a branch, so
          // `news.name` is normally present — the resource's logical id is
          // only a defensive fallback.
          const name = news.name ?? id;
          const prismaDevModulePath = resolvePrismaDevModulePath();
          // The daemon's `<id>` path segment must match
          // /^[a-z0-9][a-z0-9-]*$/ (spec § 2's API hygiene rule) — but a
          // Database resource's name is hierarchical and dot-separated for
          // a nested module (e.g. "catalog.database"). Same seam as
          // compute.ts's `slugServiceId`: the daemon-facing id is the slug;
          // `slug` is idempotent, so the daemon's own
          // `instanceNameFor(app, slug(name))` equals
          // `instanceNameFor(app, name)` — the very name the attributes
          // below record and `Connection` looks up.
          const { url } = await postgresClient().ensureDatabase(
            app,
            slug(name),
            prismaDevModulePath,
          );
          const direct = Redacted.make(url);
          return {
            databaseId: instanceNameFor(app, name),
            databaseName: name,
            projectId: projectIdOfInput(news.project),
            status: 'ready',
            region: news.region ?? 'us-east-1',
            isDefault: false,
            branchId: null,
            defaultConnectionId: null,
            createdAt: DEV_TIMESTAMP,
            directConnectionString: direct,
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: undefined,
            user: undefined,
            password: undefined,
          } satisfies Prisma.Database['Attributes'];
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
  };
  return Provider.effect(Prisma.Database, Effect.succeed(service));
}

function noRecordedInstanceError(databaseId: string): Error {
  return new Error(
    `no local Postgres instance recorded for databaseId "${databaseId}" — the Database provider ` +
      'did not run; converge is corrupt (try --fresh).',
  );
}

/** `Prisma.Connection` → the daemon's live listing, matched by instance name (the Database attributes' `databaseId` IS the instance name). */
export function LocalConnectionProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Prisma.Connection>> {
  const service: Provider.ProviderService<Prisma.Connection> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          const databaseId = databaseIdOfInput(news.database);
          if (databaseId === undefined) throw noRecordedInstanceError(String(news.database));
          const databases = await postgresClient().listDatabases(app);
          const found = databases.find((entry) => entry.instanceName === databaseId);
          if (found === undefined) throw noRecordedInstanceError(databaseId);
          const direct = Redacted.make(found.url);
          return {
            connectionId: found.instanceName,
            connectionName: news.name ?? id,
            databaseId: found.instanceName,
            kind: 'postgres',
            createdAt: DEV_TIMESTAMP,
            directConnectionString: direct,
            pooledConnectionString: undefined,
            accelerateConnectionString: undefined,
            host: undefined,
            user: undefined,
            password: undefined,
            // Local dev has only the direct endpoint, so it is also the
            // conventional application URL. The parsed origins stay unset;
            // nothing local consumes them.
            databaseUrl: direct,
            origin: undefined,
            pooledOrigin: undefined,
          } satisfies Prisma.Connection['Attributes'];
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
  };
  return Provider.effect(Prisma.Connection, Effect.succeed(service));
}
