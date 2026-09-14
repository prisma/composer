/**
 * The Prisma ORM migration step of the deploy lowering (ADR-0022, slice 2) —
 * the safety-critical decision that brings a live database to a target REF
 * using ONLY Prisma ORM's authored migrations.
 *
 * Deploy-time only: this module imports `@prisma/orm-postgres/control` (which
 * transitively pulls PN's control/migration machinery + `pg`). It is imported
 * by the deploy descriptors and this package's tests, NEVER by `index.ts` / the
 * `./orm` authoring entry — so it never lands in an app runtime bundle
 * (the index-isolation invariant holds).
 *
 * The target is a ref `{ hash, invariants }` — not a bare `storageHash`. A
 * ref's `invariants` are named postconditions established by `data`-class
 * migration steps (e.g. a backfill), recorded monotonically on the live
 * marker. Keying on the hash alone would make a pure data-invariant change an
 * A→A self-edge the deploy wrongly skips. The decision, given the live marker
 * and the target ref (see {@link decideMigrationAction}):
 *   - marker at ref.hash AND ref.invariants ⊆ marker.invariants → no-op
 *   - otherwise                                                  → `migrate`
 *
 * Replay-only (ADR-0022 as revised): the pipeline replays what was authored,
 * it never authors. A fresh database (no marker) is not special — its start
 * point is empty and `migrate` walks the AUTHORED graph from empty to the
 * target, so the first deploy applies the committed baseline like any other
 * migration. No synthesis of any kind runs at deploy: never `dbInit` (schema
 * synthesized from the contract) and never `dbUpdate` (synthesized
 * diff-and-apply). A missing authored path (`MIGRATION_PATH_NOT_FOUND`) is a
 * structured refusal whose message names the two exits — `prisma db update`
 * for local iteration, `prisma contract emit && prisma migration plan` to
 * author the path for shipping. A runner failure fails the deploy as a typed
 * `OrmMigrationError` (not swallowed). PN applies each migration in its own
 * transaction, so a failed apply is atomic and resume-safe — the marker and
 * schema are left as the last committed step.
 */

import { createPostgresControlClient } from '@prisma/orm-postgres/control';
import { readRef } from '@prisma/orm-toolchain/migration-tools/refs';
import {
  APP_SPACE_ID,
  readContractSpaceHeadRef,
  spaceMigrationDirectory,
  spaceRefsDirectory,
} from '@prisma/orm-toolchain/migration-tools/spaces';
import type { PnExtensionPack } from './orm-config.ts';
import { normalizeSslMode, withConnectionRetry } from './pg-connection.ts';

/** Which authored path the migration step took. */
export type OrmMigrationAction = 'noop' | 'migrate';

/** A resolved migration target: a contract hash plus its required invariants. */
export interface PnTargetRef {
  readonly hash: string;
  readonly invariants: readonly string[];
}

/** The migration step's decision + outcome — what the lowering records/logs. */
export interface OrmMigrationOutcome {
  readonly action: OrmMigrationAction;
  /** The ref hash the DB was brought to (or already at). */
  readonly targetHash: string;
  /** The live marker's `storageHash` before this step, or `null` for a fresh DB. */
  readonly markerHashBefore: string | null;
}

/**
 * Why a migration failed the deploy. `MIGRATION_PATH_NOT_FOUND` — no authored
 * migration path from the marker's state (or from empty, for a fresh
 * database) to the target ref. `RUNNER_FAILED` — a migration errored while
 * applying. `CONTRACT_INVALID` — the contract carries no
 * `storage.storageHash`, so no target can be resolved.
 * `CONTRACT_ARTIFACT_UNREADABLE` — the emitted `contract.json` identified by
 * `prisma.config.ts` could not be loaded. `CONTRACT_IDENTITY_MISMATCH` — the
 * config-loaded emitted contract's storage hash does not match the database
 * resource's declared current contract. `TARGET_REF_NOT_FOUND` — the resource
 * named a `targetRef` with no readable `migrations/app/refs/<name>.json`.
 */
export type OrmMigrationFailureCode =
  | 'MIGRATION_PATH_NOT_FOUND'
  | 'RUNNER_FAILED'
  | 'CONTRACT_INVALID'
  | 'CONTRACT_ARTIFACT_UNREADABLE'
  | 'CONTRACT_IDENTITY_MISMATCH'
  | 'TARGET_REF_NOT_FOUND';

/** A deploy-failing migration error — surfaced, never swallowed. */
export class OrmMigrationError extends Error {
  readonly code: OrmMigrationFailureCode;
  /** PN's structured explanation, when present. */
  readonly why: string | undefined;
  constructor(code: OrmMigrationFailureCode, summary: string, why?: string) {
    super(`Prisma ORM migrate (${code}): ${summary}`);
    this.name = 'OrmMigrationError';
    this.code = code;
    this.why = why;
  }
}

/**
 * The replay-only refusal for a missing authored path. The pipeline never
 * authors schema, so the only fix is to bring one of the two sides along:
 * update the database directly (local iteration) or author and commit the
 * missing migrations (shipping). The same message serves a deploy against a
 * cloud database and a `dev` run against the local emulator database.
 */
function noPathRefusal(
  summary: string,
  markerHashBefore: string | null,
  aggregate: boolean,
): string {
  // The marker speaks for the APP space only; with extension packs declared
  // the failed space's own start state is unknown here, so no source-state
  // claim is made for aggregate migrations.
  const from = aggregate
    ? 'The committed migrations/ directory has no authored path to the target in every declared migration space'
    : markerHashBefore === null
      ? 'The database carries no schema marker and the committed migrations/ directory has no authored path from empty to the target'
      : `The committed migrations/ directory has no authored path from the database's current schema (${markerHashBefore}) to the target`;
  return (
    `${from} — the deploy pipeline only replays authored migrations, it never creates schema itself. ` +
    'Iterating locally? Bring the database along with `prisma db update`. ' +
    'Shipping? Author the migration path — `prisma contract emit && prisma migration plan --name <slug>` ' +
    '(baseline first if the migration graph is empty) — and commit migrations/. ' +
    `(${summary})`
  );
}

/**
 * The target `storageHash` a contract heads to — `contractJson.storage.storageHash`.
 * Read defensively: `contractJson` crosses the boundary as `unknown`.
 */
export function targetStorageHash(contractJson: unknown): string {
  if (typeof contractJson === 'object' && contractJson !== null && 'storage' in contractJson) {
    // `'storage' in contractJson` narrows so `.storage` reads as `unknown` — no cast.
    const storage = contractJson.storage;
    if (typeof storage === 'object' && storage !== null && 'storageHash' in storage) {
      const hash = storage.storageHash;
      if (typeof hash === 'string' && hash.length > 0) return hash;
    }
  }
  throw new OrmMigrationError(
    'CONTRACT_INVALID',
    'the contract has no storage.storageHash — cannot determine the target schema version',
  );
}

/**
 * Resolve the deploy's target ref from the migrations dir.
 *
 * - `targetRef` named: read `migrations/app/refs/<name>.json` — fail loudly
 *   (`TARGET_REF_NOT_FOUND`) when the ref doesn't exist or can't be parsed.
 * - Default: the app space's head. PN synthesizes the app head from the
 *   emitted contract — `{ hash: contract.storage.storageHash, invariants: [] }`
 *   (`contract emit` writes no app-space `refs/head.json` today; extension
 *   spaces have one on disk). When a future PN version does emit one, the
 *   on-disk `head.json` wins — read via `readContractSpaceHeadRef`, exactly
 *   the loader PN's own migrate uses.
 */
export async function resolveTargetRef(
  migrationsDir: string,
  contractJson: unknown,
  targetRef?: string,
): Promise<PnTargetRef> {
  if (targetRef !== undefined) {
    const refsDir = spaceRefsDirectory(spaceMigrationDirectory(migrationsDir, APP_SPACE_ID));
    try {
      const ref = await readRef(refsDir, targetRef);
      return { hash: ref.hash, invariants: ref.invariants };
    } catch (error) {
      throw new OrmMigrationError(
        'TARGET_REF_NOT_FOUND',
        `targetRef "${targetRef}" could not be read from ${refsDir}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const head = await readContractSpaceHeadRef(migrationsDir, APP_SPACE_ID);
  if (head !== null) return { hash: head.hash, invariants: head.invariants };
  return { hash: targetStorageHash(contractJson), invariants: [] };
}

/**
 * The pure migration decision, mirroring PN's own verifier: the database is
 * AT the target when the marker's hash equals the ref's hash AND every ref
 * invariant is on the marker (marker invariants are monotonic). Anything
 * else — different hash, missing invariant (the A→A data-only self-edge),
 * or a fresh DB (whose start point is empty) — walks the authored graph via
 * `migrate`. The pipeline never synthesizes.
 */
export function decideMigrationAction(
  marker: { readonly storageHash: string; readonly invariants: readonly string[] } | null,
  ref: PnTargetRef,
): OrmMigrationAction {
  const markerInvariants = new Set(marker?.invariants ?? []);
  const missing = ref.invariants.filter((id) => !markerInvariants.has(id));
  if (marker !== null && marker.storageHash === ref.hash && missing.length === 0) return 'noop';
  return 'migrate';
}

/**
 * Bring the database at `url` to the target ref via PN's authored migrations.
 * Reads the live marker, decides no-op / migrate
 * ({@link decideMigrationAction}), applies, and throws a typed
 * {@link OrmMigrationError} on a no-path or runner failure. `migrationsDir` is
 * the on-disk migrations root and `ref` the resolved target
 * ({@link resolveTargetRef} — both resolved by the lowering, which also keys
 * the OrmMigration resource on them). `refName` (the resource's `targetRef`,
 * when set) is threaded into `migrate` so PN targets the named ref's hash and
 * plans an invariant-bearing path.
 */
export async function applyOrmMigration(opts: {
  readonly url: string;
  readonly contractJson: unknown;
  readonly migrationsDir: string;
  readonly ref: PnTargetRef;
  readonly refName?: string;
  /** The project's declared extension packs — threaded into PN's aggregate (multi-space) pipeline. */
  readonly extensionPacks?: readonly PnExtensionPack[];
}): Promise<OrmMigrationOutcome> {
  const connection = normalizeSslMode(opts.url);
  // Retry the connect+operation past PPG's cold-start (see withConnectionRetry).
  // A real migration failure (no-path / runner) is a OrmMigrationError — never a
  // connection transient — so it surfaces immediately, never retried.
  return withConnectionRetry(
    () =>
      runMigration(
        connection,
        opts.contractJson,
        opts.migrationsDir,
        opts.ref,
        opts.refName,
        opts.extensionPacks ?? [],
      ),
    { shouldRetry: (error) => !(error instanceof OrmMigrationError) },
  );
}

async function runMigration(
  connection: string,
  contractJson: unknown,
  migrationsDir: string,
  ref: PnTargetRef,
  refName: string | undefined,
  extensionPacks: readonly PnExtensionPack[],
): Promise<OrmMigrationOutcome> {
  const client = createPostgresControlClient({ connection, extensions: extensionPacks });
  await client.connect();
  try {
    const marker = await client.readMarker();
    const markerHashBefore = marker?.storageHash ?? null;
    let action = decideMigrationAction(marker, ref);

    // At the target ref (hash + invariants) — idempotent redeploy. The marker
    // only speaks for the APP space, so this short-circuit is honest only when
    // no extension packs are declared; with packs, fall through to `migrate`,
    // whose per-space path resolution no-ops each space already at its head.
    if (action === 'noop') {
      if (extensionPacks.length === 0) {
        return { action, targetHash: ref.hash, markerHashBefore };
      }
      action = 'migrate';
    }

    // Walk the AUTHORED migration graph toward the ref — a fresh DB starts
    // from empty and replays the committed baseline like any other migrate.
    // With a named ref, PN targets its hash and threads its invariants into
    // path planning (the same refHash/refInvariants/refName the CLI's
    // `migrate --to` passes); with the default head, PN's own head-ref
    // semantics apply. Fails on no path / runner error; never synthesizes.
    const result = await client.migrate({
      contract: contractJson,
      migrationsDir,
      ...(refName !== undefined
        ? { refHash: ref.hash, refInvariants: ref.invariants, refName }
        : {}),
    });
    if (!result.ok) {
      if (result.failure.code === 'MIGRATION_PATH_NOT_FOUND') {
        throw new OrmMigrationError(
          'MIGRATION_PATH_NOT_FOUND',
          noPathRefusal(result.failure.summary, markerHashBefore, extensionPacks.length > 0),
          result.failure.why,
        );
      }
      throw new OrmMigrationError('RUNNER_FAILED', result.failure.summary, result.failure.why);
    }
    return { action, targetHash: ref.hash, markerHashBefore };
  } finally {
    await client.close();
  }
}
