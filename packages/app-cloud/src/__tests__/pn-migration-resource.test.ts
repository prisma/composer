/**
 * The `PnMigration` Alchemy resource wiring (slice 2 D2), proven WITHOUT Prisma
 * Cloud:
 *   - the descriptor-level provider merge resolves the resource — the open
 *     question: `Layer.merge(Prisma.providers(), PnMigrationProvider())` makes
 *     Alchemy find the `PnMigration` provider (direct provider-tag lookup, no
 *     `@prisma/alchemy` change), and merging does not shadow the Prisma
 *     providers;
 *   - the provider's `reconcile` routes to `applyPnMigration` — proven live
 *     against a real local Postgres (empty → init, re-run → no-op), routed
 *     through the resource's provider rather than the helper directly;
 *   - the provider's `reconcile` re-throws: a no-path contract makes the
 *     returned Effect REJECT with the typed `PnMigrationError` (so the deploy
 *     fails) — locking the `catch: (e) => e` re-throw against a regression to
 *     `catch: () => someSuccess`.
 *
 * The full Alchemy stack apply / live Prisma-Cloud deploy is D3.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as Prisma from '@prisma/alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import { PnMigration, PnMigrationProvider } from '../pn-migration-resource.ts';
import { PnMigrationError, targetStorageHash } from '../prisma-next-migrate.ts';
import gadgetContractJson from './fixtures/gadget-contract/emitted/contract.json' with {
  type: 'json',
};
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};
import { startTestPostgres, type TestPostgres } from './postgres-harness.ts';

// Prisma.providers() reads PRISMA_SERVICE_TOKEN at layer-build (Layer.orDie).
// Resolving a provider TAG makes no API call — a placeholder token is enough to
// build the layer and prove the merge; nothing here contacts Prisma Cloud.
process.env['PRISMA_SERVICE_TOKEN'] ??= 'test-token-not-used';

const descriptorMerged = Layer.merge(Prisma.providers(), PnMigrationProvider());

describe('PnMigration provider merge (descriptor-level, no @prisma/alchemy change)', () => {
  test('the merged layer resolves the PnMigration provider by type', async () => {
    const resolved = await Effect.runPromise(
      Provider.tryFindProviderByType('PrismaNext.Migration').pipe(Effect.provide(descriptorMerged)),
    );
    expect(Option.isSome(resolved)).toBe(true);
  });

  test('merging does not shadow the Prisma providers (Database still resolves)', async () => {
    const resolved = await Effect.runPromise(
      Provider.tryFindProviderByType('Prisma.Database').pipe(Effect.provide(descriptorMerged)),
    );
    expect(Option.isSome(resolved)).toBe(true);
  });
});

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[app-cloud] skipping PnMigration reconcile test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

describe.skipIf(pg === undefined)('PnMigration reconcile routes through applyPnMigration', () => {
  if (pg === undefined) return;
  const url = pg.url;
  // An empty migrations dir: dbInit synthesizes the first-apply plan; `migrate`
  // (no authored packages) finds no path between unrelated contract hashes.
  let migrationsDir: string;

  const reconcileInputFor = (contractJson: unknown) => ({
    id: 'db',
    instanceId: 'db',
    news: { url, contractJson, migrationsDir, targetHash: targetStorageHash(contractJson) },
    olds: undefined,
    output: undefined,
    // The plan session / bindings are unused by this provider's reconcile.
    session: undefined as never,
    bindings: undefined as never,
  });

  const providerService = () =>
    Effect.runPromise(Provider.findProvider(PnMigration).pipe(Effect.provide(descriptorMerged)));

  beforeAll(() => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-app-pn-res-'));
  });
  afterAll(() => {
    pg.stop();
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('reconcile applies the contract then no-ops on the resolved props', async () => {
    const targetHash = targetStorageHash(widgetContractJson);
    const service = await providerService();
    const input = reconcileInputFor(widgetContractJson);

    // First reconcile: applies + signs the marker at the target hash.
    const first = await Effect.runPromise(service.reconcile(input));
    expect(first.storageHash).toBe(targetHash);

    // Second reconcile with the same props: the marker read makes it a no-op,
    // still reporting the target hash.
    const second = await Effect.runPromise(
      service.reconcile({ ...input, olds: input.news, output: first }),
    );
    expect(second.storageHash).toBe(targetHash);
  });

  test('reconcile re-throws a no-path failure: the Effect REJECTS with PnMigrationError', async () => {
    const service = await providerService();
    // Ensure the DB is signed at widgetHash (idempotent if already there).
    await Effect.runPromise(service.reconcile(reconcileInputFor(widgetContractJson)));

    // Now target a DIFFERENT contract (gadget) with no authored migration path.
    // The provider's `catch: (e) => e` must route the thrown PnMigrationError
    // into the Effect's error channel — so the reconcile FAILS, not succeeds.
    // A regression to `catch: () => someSuccess` would take onSuccess and fail
    // this assertion.
    const outcome = await Effect.runPromise(
      service.reconcile(reconcileInputFor(gadgetContractJson)).pipe(
        Effect.match({
          onSuccess: () => ({ failed: false as const, error: undefined }),
          onFailure: (error: unknown) => ({ failed: true as const, error }),
        }),
      ),
    );

    expect(outcome.failed).toBe(true);
    expect(outcome.error).toBeInstanceOf(PnMigrationError);
    expect((outcome.error as PnMigrationError).code).toBe('MIGRATION_PATH_NOT_FOUND');
  });
});
