/**
 * The Prisma Next migration step of the deploy lowering (ADR-0022, slice 2) —
 * the safety-critical decision that brings a live database to a contract's
 * `storageHash` using ONLY Prisma Next's authored migrations.
 *
 * Deploy-time only: this module imports `@prisma-next/postgres/control` (which
 * transitively pulls PN's control/migration machinery + `pg`). It is imported
 * by `control.ts` and this package's tests, NEVER by `index.ts` / the
 * `./prisma-next` authoring entry — so it never lands in an app runtime bundle
 * (the index-isolation invariant holds).
 *
 * The decision, given the live marker and the target hash:
 *   - marker already at target      → no-op (idempotent redeploy)
 *   - no marker (fresh/empty DB)     → `dbInit({ mode: 'apply' })`
 *   - marker at a different hash      → `migrate` (walk the AUTHORED graph)
 *
 * Never `dbUpdate`: synthesized diff-and-apply plans are never run against a
 * deployed database. A no-authored-path (`MIGRATION_PATH_NOT_FOUND`) or a
 * runner failure fails the deploy as a typed `PnMigrationError` (not swallowed).
 * PN applies each migration in its own transaction, so a failed apply is atomic
 * and resume-safe — the marker and schema are left as the last committed step.
 */
import { createPostgresControlClient } from '@prisma-next/postgres/control';

/** Which authored path the migration step took. */
export type PnMigrationAction = 'noop' | 'init' | 'migrate';

/** The migration step's decision + outcome — what the lowering records/logs. */
export interface PnMigrationOutcome {
  readonly action: PnMigrationAction;
  /** The contract's `storageHash` the DB was brought to (or already at). */
  readonly targetHash: string;
  /** The live marker's `storageHash` before this step, or `null` for a fresh DB. */
  readonly markerHashBefore: string | null;
}

/**
 * Why a migration failed the deploy. `MIGRATION_PATH_NOT_FOUND` — no authored
 * migration path from the marker's hash to the target. `RUNNER_FAILED` — a
 * migration errored while applying. `INIT_FAILED` — the first-apply `dbInit`
 * failed (planning or runner).
 */
export type PnMigrationFailureCode = 'MIGRATION_PATH_NOT_FOUND' | 'RUNNER_FAILED' | 'INIT_FAILED';

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
 * Bring the database at `url` to the contract's `storageHash` via PN's authored
 * migrations. Reads the live marker, decides no-op / init / migrate, applies,
 * and throws a typed {@link PnMigrationError} on a no-path or runner failure.
 * `migrationsDir` is the on-disk migrations root (resolved from the resource's
 * `prisma-next.config.ts` by the caller).
 */
/**
 * Relax a TLS-requiring `sslmode` to `no-verify` so node-postgres connects to
 * Prisma Postgres at deploy time.
 *
 * PPG's DSN carries `sslmode=require`. node-postgres's `pg-connection-string`
 * (8.21) treats `require`/`prefer`/`verify-ca` as aliases for `verify-full` —
 * strict certificate + hostname verification — and does NOT set
 * `rejectUnauthorized: false`, so the TLS handshake fails against PPG's cert
 * chain (which isn't in node's default trust store). The app's *runtime* path
 * uses Bun's `SQL`, which connects to the same DB fine, so this only bites the
 * deploy-time migration through `pg`. The control driver builds its client as
 * `new Client({ connectionString: url })` — no way to pass a `ssl` config
 * object — so the fix is URL-level: rewrite the strict `sslmode` to
 * `no-verify` (TLS on, certificate not verified — the same posture the runtime
 * connection uses, and the connection is to a Prisma-managed endpoint at deploy
 * time). A DSN with no `sslmode` (a plain local Postgres) is left untouched, so
 * it still connects without TLS.
 */
export function relaxSslModeForPg(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable URL — leave it; the driver surfaces its own error.
    return url;
  }
  const sslmode = parsed.searchParams.get('sslmode');
  // No TLS requested (local Postgres), or already non-verifying — nothing to do.
  if (sslmode === null || sslmode === 'disable' || sslmode === 'no-verify') return url;
  parsed.searchParams.set('sslmode', 'no-verify');
  return parsed.toString();
}

export async function applyPnMigration(opts: {
  readonly url: string;
  readonly contractJson: unknown;
  readonly migrationsDir: string;
}): Promise<PnMigrationOutcome> {
  const target = targetStorageHash(opts.contractJson);
  const client = createPostgresControlClient({ connection: relaxSslModeForPg(opts.url) });
  await client.connect();
  try {
    const marker = await client.readMarker();
    const markerHashBefore = marker?.storageHash ?? null;

    // Already at the target — idempotent redeploy, nothing to apply.
    if (markerHashBefore === target) {
      return { action: 'noop', targetHash: target, markerHashBefore };
    }

    // Fresh/empty DB (no marker) — first apply. `dbInit` is additive-only and
    // signs the marker; it never runs a destructive step.
    if (marker === null) {
      const result = await client.dbInit({
        contract: opts.contractJson,
        mode: 'apply',
        migrationsDir: opts.migrationsDir,
      });
      if (!result.ok) {
        throw new PnMigrationError('INIT_FAILED', result.failure.summary, result.failure.why);
      }
      return { action: 'init', targetHash: target, markerHashBefore };
    }

    // Existing marker at a different hash — walk the AUTHORED migration graph
    // toward the target. Fails on no path / runner error; never synthesizes.
    const result = await client.migrate({
      contract: opts.contractJson,
      migrationsDir: opts.migrationsDir,
    });
    if (!result.ok) {
      const code: PnMigrationFailureCode =
        result.failure.code === 'MIGRATION_PATH_NOT_FOUND'
          ? 'MIGRATION_PATH_NOT_FOUND'
          : 'RUNNER_FAILED';
      throw new PnMigrationError(code, result.failure.summary, result.failure.why);
    }
    return { action: 'migrate', targetHash: target, markerHashBefore };
  } finally {
    await client.close();
  }
}
