/**
 * Local postgres-cluster providers (local-dev spec § 4, REVISED — operator
 * review of #162): `Database` and `Connection` become clients of the
 * `postgres-main` emulator daemon, which hosts `@prisma/dev`'s programmatic
 * `startPrismaDevServer` — one named, persistent server per `Database`
 * resource. The CLI shell-out is gone: no bin walk-up, no stdout URL
 * parsing, no `prisma dev stop/rm` glob teardown. `PgWarm` and
 * `PnMigration` are NOT here; the hosted ones run unchanged against
 * whichever URL they are handed.
 *
 * Instance-name derivation is NOT duplicated here (delta review finding A,
 * #160): a locally re-derived slug drifted from the daemon's own
 * `instanceNameFor` (no leading/trailing-dash trim), so a database id or
 * app name with a leading/trailing non-alphanumeric character (e.g.
 * `_orders`) produced a DIFFERENT name here than the one the daemon
 * actually created the server under — `Connection`'s lookup by that
 * drifted name then threw `noRecordedInstanceError` even though the
 * server existed. `instanceNameFor` is imported directly from
 * `@internal/dev-emulators` instead, so there is exactly one
 * implementation.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { LocalTargetProvidersInput } from '@internal/core/config';
import { instanceNameFor, postgresClient, slug } from '@internal/dev-emulators';
import { Connection, Database } from '@internal/lowering/postgres';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { appNameOf } from './app-name.ts';

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
  input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<Database>> {
  const service: Provider.ProviderService<Database> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          const prismaDevModulePath = resolvePrismaDevModulePath(process.cwd());
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
            slug(news.name),
            prismaDevModulePath,
          );
          const attributes = { id: instanceNameFor(app, news.name), name: news.name, url };
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
  input: LocalTargetProvidersInput,
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
