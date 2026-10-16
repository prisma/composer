/** Where local dev loads `@prisma/dev` from, for the Postgres emulator. */
import { createRequire } from 'node:module';

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
