/**
 * Local postgres-cluster providers: upstream alchemy's `Prisma.Database` and
 * `Prisma.Connection` become clients of the `postgres-main` emulator daemon
 * (one `@prisma/dev` server per database instance).
 * `PgWarm`/`OrmMigration` are not here — the hosted ones run against whatever
 * URL they are handed. Attributes match upstream's shapes; the daemon's
 * DIRECT connection string maps to `directConnectionString` and
 * `databaseUrl`, everything else is left absent. A Database's `databaseId`
 * is its emulator instance's id.
 */
import { createRequire } from 'node:module';
import type { LocalTargetProvidersInput } from '@internal/core/config';
import { postgresClient } from '@internal/dev-emulators';
import * as Prisma from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import * as Redacted from 'effect/Redacted';
import { appNameOf } from './app-name.ts';
import { type AppScope, ensureDatabaseInstance, recordedInstanceId } from './emulator-instances.ts';
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
 * `Prisma.Database` → the database instance the directory's record names for
 * the resource, started if it is stopped and created when there is none.
 * Stores its url as the `directConnectionString` attribute. A Database whose
 * recorded instance changed (re-created after the emulator lost it) is
 * updated, so its Connection and dependents get the new instance's URL.
 */
export function LocalDatabaseProvider(
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Prisma.Database>> {
  const service: Provider.ProviderService<Prisma.Database> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news }) =>
      Effect.tryPromise({
        try: async () => {
          // Hosted branch-stage deploys omit the display name (see
          // descriptors/postgres.ts); local dev never has a branch, so
          // `news.name` is normally present — the resource's logical id is
          // only a defensive fallback.
          const name = news.name ?? id;
          const { instance } = await ensureDatabaseInstance(
            appScopeOf(input),
            name,
            resolvePrismaDevModulePath(),
          );
          const direct = Redacted.make(instance.url);
          return {
            databaseId: instance.id,
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
    diff: ({ output }) =>
      Effect.tryPromise({
        try: async () => {
          if (output === undefined || output.databaseName === undefined) return undefined;
          const recorded = await recordedInstanceId(appScopeOf(input), output.databaseName);
          return recorded === output.databaseId ? undefined : { action: 'update' as const };
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
  };
  return Provider.effect(Prisma.Database, Effect.succeed(service));
}

function appScopeOf(input: LocalTargetProvidersInput): AppScope {
  return { devDir: input.devDir, app: appNameOf(input.container) };
}

function noRecordedInstanceError(databaseId: string): Error {
  return new Error(
    `no local Postgres instance recorded for databaseId "${databaseId}" — the Database provider ` +
      'did not run; converge is corrupt (try --fresh).',
  );
}

/** `Prisma.Connection` → the database instance the Database attributes' `databaseId` names. */
export function LocalConnectionProvider(
  _input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Prisma.Connection>> {
  const service: Provider.ProviderService<Prisma.Connection> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news }) =>
      Effect.tryPromise({
        try: async () => {
          const databaseId = databaseIdOfInput(news.database);
          if (databaseId === undefined) throw noRecordedInstanceError(String(news.database));
          const found = await postgresClient().getInstance(databaseId);
          if (found === undefined) throw noRecordedInstanceError(databaseId);
          const direct = Redacted.make(found.url);
          return {
            connectionId: found.id,
            connectionName: news.name ?? id,
            databaseId: found.id,
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
