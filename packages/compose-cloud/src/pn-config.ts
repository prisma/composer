/**
 * Resolves a `pnPostgres` resource's `prisma-next.config.ts` path to the
 * on-disk migrations directory the control client's `migrate`/`dbInit` needs
 * (ADR-0022, slice 2). Deploy-time only: loads PN's config (via c12) and
 * applies PN's own convention — `migrations.dir`, or the default `migrations/`,
 * relative to the config file's directory (mirrors the CLI's
 * `resolveMigrationPaths`). Imported by `control.ts` + tests, never by
 * `index.ts` / the `./prisma-next` authoring entry.
 *
 * `pathe` (not `node:path`) does the path work so the shipped source carries no
 * `node:` import — the same discipline `control.ts` already follows by
 * delegating fs/tar to `@prisma/alchemy` (invariant 5).
 */
import { loadConfig } from '@prisma-next/cli/config-loader';
import { resolve } from 'pathe';

/** The absolute migrations directory PN reads authored migration packages from. */
export async function resolveMigrationsDir(configPath: string): Promise<string> {
  const config = await loadConfig(configPath);
  // `resolve(configPath, '..')` is the config file's directory; the migrations
  // root is `migrations.dir` (or the default) relative to it.
  return resolve(configPath, '..', config.migrations?.dir ?? 'migrations');
}
