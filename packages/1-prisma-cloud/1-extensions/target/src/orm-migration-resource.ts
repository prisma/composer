/**
 * The `OrmMigration` Alchemy resource (ADR-0022) — the migration
 * step modeled as a tracked resource so it participates in deploy state: keyed
 * on the target REF identity (`targetHash` + sorted `invariants`), an
 * unchanged redeploy is an Alchemy-level no-op (on top of the marker read),
 * and a contract change — or a DATA-ONLY change that adds a ref invariant at
 * the same hash — re-runs the migration.
 *
 * Its provider's `reconcile` receives the RESOLVED props at apply-time — in
 * particular the concrete DB `url` (a lazy `Output` until the Connection
 * provisions) — and delegates to the proven `applyOrmMigration` decision. The
 * provider is a standalone `Provider<OrmMigration>` layer; the extension
 * descriptor merges it into its `providers()` (`Layer.merge(Prisma.providers(),
 * OrmMigrationProvider())`), and Alchemy resolves it at apply via a direct
 * provider-tag lookup (`tryFindProviderByType`) — no change to `@internal/lowering`.
 *
 * Deploy-time only: imports `@prisma/orm-postgres/control` (via the helper) +
 * `alchemy`. Imported by `control.ts` and tests, never by `index.ts` / the
 * `./orm` authoring entry — index isolation holds.
 */
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import { resolveOrmConfig } from './orm-config.ts';
import { applyOrmMigration } from './orm-migrate.ts';

export interface OrmMigrationProps {
  /** The live DB connection string (an Alchemy Output at wiring time, resolved at apply). */
  readonly url: string;
  /** The deserialized contract (`node.provides.__cmp.contractJson`) — what migrate applies. */
  readonly contractJson: unknown;
  /** On-disk migrations root, resolved from the resource's `prisma.config.ts`. */
  readonly migrationsDir: string;
  /** The target ref's hash — half the diff/identity key. */
  readonly targetHash: string;
  /**
   * The target ref's required invariants, SORTED — the other half of the
   * diff key. A pure data-invariant change is an A→A self-edge (same
   * `targetHash`), so the invariants must participate in the resource's
   * identity or the deploy would wrongly no-op it.
   */
  readonly invariants: readonly string[];
  /** The named ref (`targetRef`) this deploy pinned, when set — threaded to PN's migrate. */
  readonly refName?: string;
  /**
   * `"<packId>:<headRefHash>"` per declared extension pack, SORTED by pack id
   * (`packHeadRefHashes`, orm-config.ts) — folded into the diff key so a pack
   * upgrade at an unchanged app contract still produces a distinct deploy
   * step. Only the identity rides in props: pack DESCRIPTORS carry functions,
   * which cannot live in persisted Alchemy state — reconcile reloads them
   * from `configPath`.
   */
  readonly packHeadRefHashes: readonly string[];
  /**
   * The resource's `prisma.config.ts` path — where reconcile reloads the
   * declared extension-pack descriptors from when `packHeadRefHashes` is
   * non-empty.
   */
  readonly configPath: string;
}

export interface OrmMigrationAttributes {
  /** The ref hash the database was brought to. */
  readonly storageHash: string;
  /** The ref invariants the target required (sorted, from props). */
  readonly invariants: readonly string[];
}

export type OrmMigration = Resource<
  'PrismaOrm.Migration',
  OrmMigrationProps,
  OrmMigrationAttributes
>;

/** The `OrmMigration` resource constructor — `yield* OrmMigration(id, props)` in the lowering. */
export const OrmMigration = Resource<OrmMigration>('PrismaOrm.Migration');

/**
 * The `OrmMigration` provider service. `reconcile` runs for both create and
 * update (Alchemy's unified lifecycle); `applyOrmMigration` is idempotent via
 * the live marker read, so it is safe to run for either — the marker decides
 * no-op / migrate. A migration has nothing to enumerate (`list` → `[]`)
 * and nothing to tear down on its own (`delete` → no-op; the DB's own deletion
 * handles teardown). Exported so tests can drive `reconcile` directly, without
 * building an Effect layer.
 */
export const ormMigrationProviderService: Provider.ProviderService<OrmMigration> = {
  list: () => Effect.succeed([]),
  reconcile: ({ news }) =>
    Effect.tryPromise({
      try: async () => {
        // Descriptors are reloaded here, not carried in props: props persist
        // in Alchemy state and a descriptor is live code. Loaded only when
        // the key says packs are declared, so a pack-free project never pays
        // (or depends on) the config load at apply time.
        const extensionPacks =
          news.packHeadRefHashes.length > 0
            ? (await resolveOrmConfig(news.configPath)).extensionPacks
            : [];
        return applyOrmMigration({
          url: news.url,
          contractJson: news.contractJson,
          migrationsDir: news.migrationsDir,
          ref: { hash: news.targetHash, invariants: news.invariants },
          extensionPacks,
          ...(news.refName !== undefined ? { refName: news.refName } : {}),
        });
      },
      // Surface OrmMigrationError (no-path / runner) as-is — it fails the
      // deploy with its clear message; nothing is swallowed.
      catch: (error) => error,
    }).pipe(
      Effect.map((outcome) => ({ storageHash: outcome.targetHash, invariants: news.invariants })),
    ),
  delete: () => Effect.void,
};

/** The `OrmMigration` provider layer — merged into the extension descriptor's `providers()`. */
export const OrmMigrationProvider = () =>
  Provider.effect(OrmMigration, Effect.succeed(ormMigrationProviderService));
