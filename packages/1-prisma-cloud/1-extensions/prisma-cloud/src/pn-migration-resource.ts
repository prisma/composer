/**
 * The `PnMigration` Alchemy resource (ADR-0022, slice 2 D2) — the migration
 * step modeled as a tracked resource so it participates in deploy state: keyed
 * on the target REF identity (`targetHash` + sorted `invariants`), an
 * unchanged redeploy is an Alchemy-level no-op (on top of the marker read),
 * and a contract change — or a DATA-ONLY change that adds a ref invariant at
 * the same hash — re-runs the migration.
 *
 * Its provider's `reconcile` receives the RESOLVED props at apply-time — in
 * particular the concrete DB `url` (a lazy `Output` until the Connection
 * provisions) — and delegates to the proven `applyPnMigration` decision. The
 * provider is a standalone `Provider<PnMigration>` layer; the extension
 * descriptor merges it into its `providers()` (`Layer.merge(Prisma.providers(),
 * PnMigrationProvider())`), and Alchemy resolves it at apply via a direct
 * provider-tag lookup (`tryFindProviderByType`) — no change to `@internal/lowering`.
 *
 * Deploy-time only: imports `@prisma-next/postgres/control` (via the helper) +
 * `alchemy`. Imported by `control.ts` and tests, never by `index.ts` / the
 * `./prisma-next` authoring entry — index isolation holds.
 */
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import { applyPnMigration } from './prisma-next-migrate.ts';

export interface PnMigrationProps {
  /** The live DB connection string (an Alchemy Output at wiring time, resolved at apply). */
  readonly url: string;
  /** The deserialized contract (`node.provides.__cmp.contractJson`) — what migrate applies. */
  readonly contractJson: unknown;
  /** On-disk migrations root, resolved from the resource's `prisma-next.config.ts`. */
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
}

export interface PnMigrationAttributes {
  /** The ref hash the database was brought to. */
  readonly storageHash: string;
  /** The ref invariants the target required (sorted, from props). */
  readonly invariants: readonly string[];
}

export type PnMigration = Resource<'PrismaNext.Migration', PnMigrationProps, PnMigrationAttributes>;

/** The `PnMigration` resource constructor — `yield* PnMigration(id, props)` in the lowering. */
export const PnMigration = Resource<PnMigration>('PrismaNext.Migration');

/**
 * The `PnMigration` provider service. `reconcile` runs for both create and
 * update (Alchemy's unified lifecycle); `applyPnMigration` is idempotent via
 * the live marker read, so it is safe to run for either — the marker decides
 * no-op / init / migrate. A migration has nothing to enumerate (`list` → `[]`)
 * and nothing to tear down on its own (`delete` → no-op; the DB's own deletion
 * handles teardown). Exported so tests can drive `reconcile` directly, without
 * building an Effect layer.
 */
export const pnMigrationProviderService: Provider.ProviderService<PnMigration> = {
  list: () => Effect.succeed([]),
  reconcile: ({ news }) =>
    Effect.tryPromise({
      try: () =>
        applyPnMigration({
          url: news.url,
          contractJson: news.contractJson,
          migrationsDir: news.migrationsDir,
          ref: { hash: news.targetHash, invariants: news.invariants },
          ...(news.refName !== undefined ? { refName: news.refName } : {}),
        }),
      // Surface PnMigrationError (no-path / runner / init) as-is — it fails the
      // deploy with its clear message; nothing is swallowed.
      catch: (error) => error,
    }).pipe(
      Effect.map((outcome) => ({ storageHash: outcome.targetHash, invariants: news.invariants })),
    ),
  delete: () => Effect.void,
};

/** The `PnMigration` provider layer — merged into the extension descriptor's `providers()`. */
export const PnMigrationProvider = () =>
  Provider.effect(PnMigration, Effect.succeed(pnMigrationProviderService));
