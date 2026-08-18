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
import { blindCast } from '@internal/foundation/casts';
import type { createPostgresControlClient } from '@prisma/orm-postgres/control';
import { loadConfig } from '@prisma/orm-toolchain/config-loader';
import { resolve } from 'pathe';

/** One declared extension pack, in the shape the control client accepts.
 *  Derived from the client's own options (orm-toolchain 8.0.0-rc.4 made the
 *  config's descriptor generics narrower than the client's, so deriving from
 *  the config no longer satisfies the client's parameter type). */
export type PnExtensionPack = NonNullable<
  NonNullable<Parameters<typeof createPostgresControlClient>[0]>['extensions']
>[number];

/**
 * What the deploy reads out of one `prisma-next.config.ts`.
 *
 * The packs are `extensionPacks` here, not `extensions`: Prisma Next calls the
 * key the user types `extensions`, but `extensions` is already Composer's word
 * for the things listed in `prisma-composer.config.ts` (`prismaCloud()`,
 * `nodeBuild()`), and `1-extensions/` is a layer name. This type is Composer's
 * side of the boundary, so it uses Composer's word.
 */
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
  // orm-toolchain 8.0.0-rc.4: loadConfig answers a Result carrying the
  // config plus per-section diagnostics instead of throwing.
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) throw loaded.failure;
  const config = loaded.value.config;
  return {
    // `resolve(configPath, '..')` is the config file's directory; the
    // migrations root is `migrations.dir` (or the default) relative to it.
    migrationsDir: resolve(configPath, '..', config.migrations?.dir ?? 'migrations'),
    // orm-toolchain 8.0.0-rc.4 types the config's descriptors narrower than
    // the control client accepts, and the descriptor generics are invariant,
    // so the two types reject each other in both directions. The values are
    // the same objects the client consumes.
    extensionPacks: blindCast<
      readonly PnExtensionPack[],
      'orm rc.4 config descriptors and control-client descriptors are invariant-incompatible'
    >(config.extensions ?? []),
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
export function packHeadRefHashes(packs: readonly PnExtensionPack[]): readonly string[] {
  return packs.map((pack) => `${pack.id}:${pack.contractSpace?.headRef.hash ?? '-'}`).sort();
}
