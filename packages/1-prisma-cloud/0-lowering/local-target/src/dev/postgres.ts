/**
 * Local postgres-cluster providers (local-dev spec § 4, REVISED — operator
 * review of #162): `Database` and `Connection` become clients of the
 * `postgres-main` emulator daemon, which hosts `@prisma/dev`'s programmatic
 * `startPrismaDevServer` — one named, persistent server per `Database`
 * resource. The CLI shell-out is gone: no bin walk-up, no stdout URL
 * parsing, no `prisma dev stop/rm` glob teardown. `PgWarm` and
 * `PnMigration` are NOT here; the hosted ones run unchanged against
 * whichever URL they are handed.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DevProvidersInput } from '@internal/core/config';
import { postgresClient } from '@internal/dev-emulators';
import { Connection, Database } from '@internal/lowering/postgres';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { appNameOf } from './app-name.ts';

/** Lowercases and collapses every run of non-`[a-z0-9]` chars to a single `-`. */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** `pcdev-<app>-<database-id>`, each piece slugged independently, trimmed to 63 chars — the SAME derivation `postgres-main`'s own `instanceNameFor` uses. */
export function instanceName(app: string, databaseId: string): string {
  return `pcdev-${slug(app)}-${slug(databaseId)}`.slice(0, 63);
}

function noPrismaDevError(): Error {
  return new Error(
    'local dev needs @prisma/dev for its local Postgres emulator — add "prisma" to your app\'s devDependencies.',
  );
}

/**
 * Two-step resolution, pinned (local-dev spec § 4): (1) resolve
 * `@prisma/dev` directly from the app's own `node_modules`; (2) on failure,
 * resolve `prisma` (the CLI apps typically depend on, which itself carries
 * `@prisma/dev`) and resolve `@prisma/dev` from THERE. The daemon imports
 * the returned path dynamically, so the app stays in charge of its own
 * Prisma version. `cwd` is the one place a local provider legitimately
 * reads `process.cwd()` — finding the app's own installed version is
 * inherently cwd-relative.
 */
export function resolvePrismaDevModulePath(cwd: string): string {
  const appRequire = createRequire(path.join(cwd, 'package.json'));
  try {
    return appRequire.resolve('@prisma/dev');
  } catch {
    // fall through to the prisma-CLI-relative resolution
  }
  try {
    const prismaEntry = appRequire.resolve('prisma');
    return createRequire(prismaEntry).resolve('@prisma/dev');
  } catch {
    throw noPrismaDevError();
  }
}

/**
 * `Database` → an ensured `postgres-main` server, one per resource. Stores
 * the daemon's returned `url` on its own attributes.
 */
export function LocalDatabaseProvider(
  input: DevProvidersInput,
): Layer.Layer<Provider.Provider<Database>> {
  const service: Provider.ProviderService<Database> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          const prismaDevModulePath = resolvePrismaDevModulePath(process.cwd());
          const { url } = await postgresClient().ensureDatabase(
            app,
            news.name,
            prismaDevModulePath,
          );
          const attributes = { id: instanceName(app, news.name), name: news.name, url };
          return attributes;
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
  };
  return Provider.effect(Database, Effect.succeed(service));
}

function noRecordedInstanceError(databaseId: string): Error {
  return new Error(
    `no local Postgres instance recorded for databaseId "${databaseId}" — the Database provider ` +
      'did not run; converge is corrupt (try --fresh).',
  );
}

/** `Connection` → the daemon's live listing, matched by instance name (the Database attributes' `id` IS the instance name). */
export function LocalConnectionProvider(
  input: DevProvidersInput,
): Layer.Layer<Provider.Provider<Connection>> {
  const service: Provider.ProviderService<Connection> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          const databases = await postgresClient().listDatabases(app);
          const found = databases.find((entry) => entry.instanceName === news.databaseId);
          if (found === undefined) throw noRecordedInstanceError(news.databaseId);
          return { id: found.instanceName, connectionString: Redacted.make(found.url) };
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
  };
  return Provider.effect(Connection, Effect.succeed(service));
}
