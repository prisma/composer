/**
 * The Prisma Next migration step of the deploy lowering (ADR-0022, slice 2) —
 * the safety-critical decision that brings a live database to a target REF
 * using ONLY Prisma Next's authored migrations.
 *
 * Deploy-time only: this module imports `@prisma-next/postgres/control` (which
 * transitively pulls PN's control/migration machinery + `pg`). It is imported
 * by the deploy descriptors and this package's tests, NEVER by `index.ts` / the
 * `./prisma-next` authoring entry — so it never lands in an app runtime bundle
 * (the index-isolation invariant holds).
 *
 * The target is a ref `{ hash, invariants }` — not a bare `storageHash`. A
 * ref's `invariants` are named postconditions established by `data`-class
 * migration steps (e.g. a backfill), recorded monotonically on the live
 * marker. Keying on the hash alone would make a pure data-invariant change an
 * A→A self-edge the deploy wrongly skips. The decision, given the live marker
 * and the target ref (see {@link decideMigrationAction}):
 *   - marker at ref.hash AND ref.invariants ⊆ marker.invariants → no-op
 *   - no marker (fresh DB) AND no required invariants           → `dbInit`
 *   - otherwise                                                  → `migrate`
 *
 * `dbInit` is additive-only synthesis — it NEVER runs app-space data steps —
 * so it is only correct when the ref requires no invariants; a fresh DB whose
 * target carries invariants goes through `migrate`, which walks the AUTHORED
 * graph (including the invariant-bearing data migrations) from empty.
 *
 * Never `dbUpdate`: synthesized diff-and-apply plans are never run against a
 * deployed database. A no-authored-path (`MIGRATION_PATH_NOT_FOUND`) or a
 * runner failure fails the deploy as a typed `PnMigrationError` (not swallowed).
 * PN applies each migration in its own transaction, so a failed apply is atomic
 * and resume-safe — the marker and schema are left as the last committed step.
 */
import { readRef } from '@prisma-next/migration-tools/refs';
import {
  APP_SPACE_ID,
  readContractSpaceHeadRef,
  spaceMigrationDirectory,
  spaceRefsDirectory,
} from '@prisma-next/migration-tools/spaces';
import { createPostgresControlClient } from '@prisma-next/postgres/control';
import { normalizeSslMode, withConnectionRetry } from './exports/pg-connection.ts';

/** Which authored path the migration step took. */
export type PnMigrationAction = 'noop' | 'init' | 'migrate';

/** A resolved migration target: a contract hash plus its required invariants. */
export interface PnTargetRef {
  readonly hash: string;
  readonly invariants: readonly string[];
}

/** The migration step's decision + outcome — what the lowering records/logs. */
export interface PnMigrationOutcome {
  readonly action: PnMigrationAction;
  /** The ref hash the DB was brought to (or already at). */
  readonly targetHash: string;
  /** The live marker's `storageHash` before this step, or `null` for a fresh DB. */
  readonly markerHashBefore: string | null;
}

/**
 * Why a migration failed the deploy. `MIGRATION_PATH_NOT_FOUND` — no authored
 * migration path from the marker's state to the target ref. `RUNNER_FAILED` —
 * a migration errored while applying. `INIT_FAILED` — the first-apply `dbInit`
 * failed (planning or runner). `TARGET_REF_NOT_FOUND` — the resource named a
 * `targetRef` with no readable `migrations/app/refs/<name>.json`.
 */
export type PnMigrationFailureCode =
  | 'MIGRATION_PATH_NOT_FOUND'
  | 'RUNNER_FAILED'
  | 'INIT_FAILED'
  | 'TARGET_REF_NOT_FOUND';

/** A deploy-failing migration error — surfaced, never swallowed. */
export class PnMigrationError extends Error {
  readonly code: PnMigrationFailureCode;
  /** PN's structured explanation, when present. */
  readonly why: string | undefined;
  constructor(code: PnMigrationFailureCode, summary: string, why?: string) {
    super(`prisma-next migrate (${code}): ${summary}`);
    this.name = 'PnMigrationError';
    this.code = code;
    this.why = why;
  }
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
  throw new PnMigrationError(
    'INIT_FAILED',
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
      throw new PnMigrationError(
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
 * invariant is on the marker (marker invariants are monotonic). `dbInit` is
 * additive-only synthesis, so it is chosen only for a fresh DB whose
 * effective required invariants (`ref.invariants − marker.invariants`) are
 * empty; anything else — different hash, missing invariant (the A→A
 * data-only self-edge), or a fresh DB with required invariants — walks the
 * authored graph via `migrate`.
 */
export function decideMigrationAction(
  marker: { readonly storageHash: string; readonly invariants: readonly string[] } | null,
  ref: PnTargetRef,
): PnMigrationAction {
  const markerInvariants = new Set(marker?.invariants ?? []);
  const missing = ref.invariants.filter((id) => !markerInvariants.has(id));
  if (marker !== null && marker.storageHash === ref.hash && missing.length === 0) return 'noop';
  if (marker === null && missing.length === 0) return 'init';
  return 'migrate';
}

/**
 * Bring the database at `url` to the target ref via PN's authored migrations.
 * Reads the live marker, decides no-op / init / migrate
 * ({@link decideMigrationAction}), applies, and throws a typed
 * {@link PnMigrationError} on a no-path or runner failure. `migrationsDir` is
 * the on-disk migrations root and `ref` the resolved target
 * ({@link resolveTargetRef} — both resolved by the lowering, which also keys
 * the PnMigration resource on them). `refName` (the resource's `targetRef`,
 * when set) is threaded into `migrate` so PN targets the named ref's hash and
 * plans an invariant-bearing path.
 */
export async function applyPnMigration(opts: {
  readonly url: string;
  readonly contractJson: unknown;
  readonly migrationsDir: string;
  readonly ref: PnTargetRef;
  readonly refName?: string;
}): Promise<PnMigrationOutcome> {
  const connection = normalizeSslMode(opts.url);
  // Retry the connect+operation past PPG's cold-start (see withConnectionRetry).
  // A real migration failure (no-path / runner) is a PnMigrationError — never a
  // connection transient — so it surfaces immediately, never retried.
  return withConnectionRetry(
    () => runMigration(connection, opts.contractJson, opts.migrationsDir, opts.ref, opts.refName),
    { shouldRetry: (error) => !(error instanceof PnMigrationError) },
  );
}

async function runMigration(
  connection: string,
  contractJson: unknown,
  migrationsDir: string,
  ref: PnTargetRef,
  refName: string | undefined,
): Promise<PnMigrationOutcome> {
  const client = createPostgresControlClient({ connection });
  await client.connect();
  try {
    const marker = await client.readMarker();
    const markerHashBefore = marker?.storageHash ?? null;
    const action = decideMigrationAction(marker, ref);

    // At the target ref (hash + invariants) — idempotent redeploy.
    if (action === 'noop') {
      return { action, targetHash: ref.hash, markerHashBefore };
    }

    // Fresh/empty DB, no required invariants — first apply. `dbInit` is
    // additive-only and signs the marker; it never runs a destructive or
    // data step (which is exactly why it's ruled out when invariants are
    // required — it would leave `marker.invariants` empty).
    if (action === 'init') {
      const result = await client.dbInit({
        contract: contractJson,
        mode: 'apply',
        migrationsDir,
      });
      if (!result.ok) {
        throw new PnMigrationError('INIT_FAILED', result.failure.summary, result.failure.why);
      }
      return { action, targetHash: ref.hash, markerHashBefore };
    }

    // Walk the AUTHORED migration graph toward the ref. With a named ref, PN
    // targets its hash and threads its invariants into path planning (the
    // same refHash/refInvariants/refName the CLI's `migrate --to` passes);
    // with the default head, PN's own head-ref semantics apply. Fails on no
    // path / runner error; never synthesizes.
    const result = await client.migrate({
      contract: contractJson,
      migrationsDir,
      ...(refName !== undefined
        ? { refHash: ref.hash, refInvariants: ref.invariants, refName }
        : {}),
    });
    if (!result.ok) {
      const code: PnMigrationFailureCode =
        result.failure.code === 'MIGRATION_PATH_NOT_FOUND'
          ? 'MIGRATION_PATH_NOT_FOUND'
          : 'RUNNER_FAILED';
      throw new PnMigrationError(code, result.failure.summary, result.failure.why);
    }
    return { action, targetHash: ref.hash, markerHashBefore };
  } finally {
    await client.close();
  }
}
