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
 *     through the resource's provider rather than the helper directly.
 *
 * The full Alchemy stack apply / live Prisma-Cloud deploy is D3.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as Prisma from '@prisma/alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import { PnMigration, PnMigrationProvider } from '../pn-migration-resource.ts';
import { targetStorageHash } from '../prisma-next-migrate.ts';
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
  let migrationsDir: string;

  afterAll(() => {
    pg.stop();
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('reconcile applies the contract then no-ops on the resolved props', async () => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-app-pn-res-'));
    const targetHash = targetStorageHash(widgetContractJson);
    const service = await Effect.runPromise(
      Provider.findProvider(PnMigration).pipe(Effect.provide(descriptorMerged)),
    );
    const news = { url, contractJson: widgetContractJson, migrationsDir, targetHash };
    const reconcileInput = {
      id: 'db',
      instanceId: 'db',
      news,
      olds: undefined,
      output: undefined,
      // The plan session / bindings are unused by this provider's reconcile.
      session: undefined as never,
      bindings: undefined as never,
    };

    // First reconcile: applies + signs the marker at the target hash.
    const first = await Effect.runPromise(service.reconcile(reconcileInput));
    expect(first.storageHash).toBe(targetHash);

    // Second reconcile with the same props: the marker read makes it a no-op,
    // still reporting the target hash.
    const second = await Effect.runPromise(
      service.reconcile({ ...reconcileInput, olds: news, output: first }),
    );
    expect(second.storageHash).toBe(targetHash);
  });
});
