/**
 * Resolves a `postgres` resource's `prisma.config.ts` path to the
 * project facts the deploy needs (ADR-0022, slice 2): the emitted
 * `contract.json` artifact path, the on-disk migrations directory the control
 * client's `migrate` reads, and the declared extension packs. Deploy-time
 * only: loads PN's config (via c12) and applies
 * PN's own convention — `migrations.dir`, or the default `migrations/`,
 * relative to the config file's directory (mirrors the CLI's
 * `resolveMigrationPaths`). Imported by `control.ts` + tests, never by
 * `index.ts` / the `./orm` authoring entry.
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
 *  Derived from the client's own options (since orm-toolchain 8.0.0-rc.7 the
 *  config's descriptor generics are narrower than the client's, so deriving
 *  from the config no longer satisfies the client's parameter type). */
export type PnExtensionPack = NonNullable<
  NonNullable<Parameters<typeof createPostgresControlClient>[0]>['extensions']
>[number];

/**
 * What the deploy reads out of one `prisma.config.ts`.
 *
 * The packs are `extensionPacks` here, not `extensions`: Prisma ORM calls the
 * key the user types `extensions`, but `extensions` is already Composer's word
 * for the things listed in `prisma-composer.config.ts` (`prismaCloud()`,
 * `nodeBuild()`), and `1-extensions/` is a layer name. This type is Composer's
 * side of the boundary, so it uses Composer's word.
 */
export interface ResolvedOrmConfig {
  /** The absolute migrations directory PN reads authored migration packages from. */
  readonly migrationsDir: string;
  /** The absolute emitted contract artifact path the config identifies. */
  readonly contractArtifactPath: string;
  /** The config's declared extension packs (`[]` when it declares none). */
  readonly extensionPacks: readonly PnExtensionPack[];
}

/** Loads the config at `configPath` and resolves the facts the deploy consumes. */
export async function resolveOrmConfig(configPath: string): Promise<ResolvedOrmConfig> {
  // Since orm-toolchain 8.0.0-rc.7, loadConfig answers a Result carrying
  // the config plus per-section diagnostics instead of throwing.
  const loaded = await loadConfig(configPath);
  if (!loaded.ok) throw loaded.failure;
  const config = loaded.value.config;
  if (config.contract === undefined) {
    throw new Error(`Prisma ORM config at "${configPath}" did not declare orm.contract.`);
  }
  if (config.contract.output === undefined) {
    throw new Error(`Prisma ORM config at "${configPath}" did not resolve orm.contract.output.`);
  }
  return {
    // `resolve(configPath, '..')` is the config file's directory; the
    // migrations root is `migrations.dir` (or the default) relative to it.
    migrationsDir: resolve(configPath, '..', config.migrations?.dir ?? 'migrations'),
    // Prisma ORM's normalized contract config carries the emitted
    // `contract.json` path directly on `contract.output`, relative to the
    // config file. That is the supported, config-declared artifact path.
    contractArtifactPath: resolve(configPath, '..', config.contract.output),
    // Since orm-toolchain 8.0.0-rc.7 the config's descriptors are typed
    // narrower than the control client accepts, and the descriptor generics
    // are invariant, so the two types reject each other in both directions.
    // The values are the same objects the client consumes.
    extensionPacks: blindCast<
      readonly PnExtensionPack[],
      'orm config descriptors and control-client descriptors are invariant-incompatible'
    >(config.extensions ?? []),
  };
}

/** The absolute migrations directory PN reads authored migration packages from. */
export async function resolveMigrationsDir(configPath: string): Promise<string> {
  return (await resolveOrmConfig(configPath)).migrationsDir;
}

/** Loads the emitted `contract.json` at the resolved artifact path. */
export async function loadContractJson(contractArtifactPath: string): Promise<unknown> {
  // Freshen the specifier so repeated dev-loop reconciles re-read the file
  // after `prisma contract emit` updates it in place.
  const loaded = await import(`${contractArtifactPath}?t=${Date.now()}`, {
    with: { type: 'json' },
  });
  return loaded.default;
}

/**
 * The pack-head identity entries the `OrmMigration` resource folds into its
 * diff key: `"<packId>:<headRefHash>"` — each pack's contract-space head ref,
 * identified by its storage hash — sorted by pack id, so a pack upgrade (or a
 * pack added/removed) produces a distinct deploy step. A pack without a
 * `contractSpace` contributes `"-"` for its head — it declares no migratable
 * space, but its presence still belongs in the key.
 */
export function packHeadRefHashes(packs: readonly PnExtensionPack[]): readonly string[] {
  return packs.map((pack) => `${pack.id}:${pack.contractSpace?.headRef.hash ?? '-'}`).sort();
}
