/**
 * Resolves a `pnPostgres` resource's `prisma-next.config.ts` path to the
 * project facts the deploy needs (ADR-0022, slice 2): the on-disk migrations
 * directory the control client's `migrate`/`dbInit` read, and the declared
 * extension packs. Deploy-time only: loads PN's config (via c12) and applies
 * PN's own convention — `migrations.dir`, or the default `migrations/`,
 * relative to the config file's directory (mirrors the CLI's
 * `resolveMigrationPaths`). Imported by `control.ts` + tests, never by
 * `index.ts` / the `./prisma-next` authoring entry.
 *
 * `pathe` (not `node:path`) does the path work so the shipped source carries no
 * `node:` import — the same discipline `control.ts` already follows by
 * delegating fs/tar to `@internal/lowering` (invariant 5).
 */
import { loadConfig, type PrismaNextConfig } from '@prisma-next/config-loader';
import { resolve } from 'pathe';

/** One declared extension pack, as PN's validated config carries it. */
export type PnExtensionPack = NonNullable<PrismaNextConfig['extensionPacks']>[number];

/** What the deploy reads out of one `prisma-next.config.ts`. */
export interface ResolvedPrismaNextConfig {
  /** The absolute migrations directory PN reads authored migration packages from. */
  readonly migrationsDir: string;
  /** The config's declared extension packs (`[]` when it declares none). */
  readonly extensionPacks: readonly PnExtensionPack[];
}

/** Loads the config at `configPath` and resolves the facts the deploy consumes. */
export async function resolvePrismaNextConfig(
  configPath: string,
): Promise<ResolvedPrismaNextConfig> {
  const config = await loadConfig(configPath);
  return {
    // `resolve(configPath, '..')` is the config file's directory; the
    // migrations root is `migrations.dir` (or the default) relative to it.
    migrationsDir: resolve(configPath, '..', config.migrations?.dir ?? 'migrations'),
    extensionPacks: config.extensionPacks ?? [],
  };
}

/** The absolute migrations directory PN reads authored migration packages from. */
export async function resolveMigrationsDir(configPath: string): Promise<string> {
  return (await resolvePrismaNextConfig(configPath)).migrationsDir;
}

/**
 * The pack-head identity entries the `PnMigration` resource folds into its
 * diff key: `"<packId>:<headRefHash>"` — each pack's contract-space head ref,
 * identified by its storage hash — sorted by pack id, so a pack upgrade (or a
 * pack added/removed) produces a distinct deploy step. A pack without a
 * `contractSpace` contributes `"-"` for its head — it declares no migratable
 * space, but its presence still belongs in the key.
 */
export function packHeadRefHashes(extensionPacks: readonly PnExtensionPack[]): readonly string[] {
  return extensionPacks
    .map((pack) => `${pack.id}:${pack.contractSpace?.headRef.hash ?? '-'}`)
    .sort();
}
