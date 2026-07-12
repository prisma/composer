/**
 * The `PnMigration` Alchemy resource wiring (slice 2 D2), proven WITHOUT Prisma
 * Cloud:
 *   - the merge/lookup MECHANISM the descriptor relies on — `Layer.mergeAll` of
 *     `Provider.effect` layers keeps EVERY provider tag reachable by
 *     `tryFindProviderByType` (no shadowing). Exercised with two synthetic
 *     in-file providers ONLY. Deliberately imports NO provider constructor from
 *     another module: `bun test` runs every test file in one process and
 *     `mock.module` is process-global, so a sibling file's module mock (e.g.
 *     control-lowering.test.ts stubbing `../pg-warm-resource.ts`) can replace
 *     an imported constructor with a non-Layer stub — which is exactly how CI
 *     (whose filesystem yields a different test-file order than macOS) hit
 *     `layer.build is not a function` here. In-file values are un-mockable.
 *   - the REAL providers' by-type reachability — asserted through alchemy's own
 *     lookup against a directly-constructed Context (`Layer.succeed` on the
 *     `Provider(type)` tag with the exported SERVICE values, which no sibling
 *     mock touches) — no cross-module Layer constructors involved;
 *   - the provider's `reconcile` routes to `applyPnMigration` — driven directly
 *     against the exported provider service, proven live against a real local
 *     Postgres (empty → init, re-run → no-op, no-path → rejects).
 *
 * Self-isolating: the reconcile suite owns a uniquely-named database, so it
 * never touches tables another suite shares in the CI Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import type { PgWarm } from '../pg-warm-resource.ts';
import { pgWarmProviderService } from '../pg-warm-resource.ts';
import type { PnMigration } from '../pn-migration-resource.ts';
import { pnMigrationProviderService } from '../pn-migration-resource.ts';
import { PnMigrationError, targetStorageHash } from '../prisma-next-migrate.ts';
import gadgetContractJson from './fixtures/gadget-contract/emitted/contract.json' with {
  type: 'json',
};
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};
import {
  createTestDatabase,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from './postgres-harness.ts';

// Two trivial in-file Alchemy resources + providers — clean stand-ins for the
// descriptor's providers, so the merge mechanism is exercised with values no
// sibling test file's `mock.module` can replace (in-file consts are immune;
// imported constructors are not — see the header).
type ProbeA = Resource<'PrismaNext.ProbeA', { readonly n: number }, { readonly n: number }>;
const ProbeA = Resource<ProbeA>('PrismaNext.ProbeA');
type ProbeB = Resource<'PrismaNext.ProbeB', { readonly n: number }, { readonly n: number }>;
const ProbeB = Resource<ProbeB>('PrismaNext.ProbeB');
const probeAService: Provider.ProviderService<ProbeA> = {
  list: () => Effect.succeed([]),
  reconcile: ({ news }) => Effect.succeed({ n: news.n }),
  delete: () => Effect.void,
};
const probeBService: Provider.ProviderService<ProbeB> = {
  list: () => Effect.succeed([]),
  reconcile: ({ news }) => Effect.succeed({ n: news.n }),
  delete: () => Effect.void,
};

// The exact merge shape the extension descriptor uses (`Layer.mergeAll` of
// `Provider.effect` layers). Resolved via a scoped `Layer.build` +
// `provideContext` (stable public Effect API), not `Effect.provide(layer)`.
const merged = Layer.mergeAll(
  Provider.effect(ProbeA, Effect.succeed(probeAService)),
  Provider.effect(ProbeB, Effect.succeed(probeBService)),
);
const resolveIn = <A>(
  layer: Layer.Layer<never>,
  lookup: Effect.Effect<A, never, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(layer).pipe(
        Effect.flatMap((context: Context.Context<never>) => Effect.provideContext(lookup, context)),
      ),
    ),
  );

describe('provider merge mechanism (Layer.mergeAll keeps every tag reachable)', () => {
  test('the merged layer resolves the first provider by type', async () => {
    const resolved = await resolveIn(merged, Provider.tryFindProviderByType('PrismaNext.ProbeA'));
    expect(Option.isSome(resolved)).toBe(true);
  });

  test('merging does not shadow the second provider', async () => {
    const resolved = await resolveIn(merged, Provider.tryFindProviderByType('PrismaNext.ProbeB'));
    expect(Option.isSome(resolved)).toBe(true);
  });
});

describe("the real providers' tags resolve by type (direct context, no cross-module layers)", () => {
  // Rebuild the tag→service pairing in-file: the Resource classes are
  // re-declared HERE from the modules' type-only exports (type imports erase
  // at compile time, so a leaked `mock.module` can't touch them), paired with
  // the exported SERVICE values (which no sibling mock factory lists, so they
  // also survive a leak) — alchemy's own lookup must find both types the
  // descriptor registers.
  const PnMigrationTag = Resource<PnMigration>('PrismaNext.Migration');
  const PgWarmTag = Resource<PgWarm>('PrismaCloud.PgWarm');
  const realTags = Layer.mergeAll(
    Provider.effect(PnMigrationTag, Effect.succeed(pnMigrationProviderService)),
    Provider.effect(PgWarmTag, Effect.succeed(pgWarmProviderService)),
  );

  test("tryFindProviderByType('PrismaNext.Migration') resolves", async () => {
    const resolved = await resolveIn(
      realTags,
      Provider.tryFindProviderByType('PrismaNext.Migration'),
    );
    expect(Option.isSome(resolved)).toBe(true);
  });

  test("tryFindProviderByType('PrismaCloud.PgWarm') resolves", async () => {
    const resolved = await resolveIn(
      realTags,
      Provider.tryFindProviderByType('PrismaCloud.PgWarm'),
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
  let migrationsDir: string;
  let testDb: TestDatabase;
  let url: string;

  // Drive the reconcile through the exported provider service directly — no
  // Effect layer to build, so the routing assertion can't be flaked by
  // environment-specific layer internals.
  const reconcile = (contractJson: unknown) =>
    pnMigrationProviderService.reconcile({
      id: 'db',
      instanceId: 'db',
      news: {
        url,
        contractJson,
        migrationsDir,
        targetHash: targetStorageHash(contractJson),
        invariants: [],
      },
      olds: undefined,
      output: undefined,
      // The plan session / bindings are unused by this provider's reconcile.
      session: undefined as never,
      bindings: undefined as never,
    });

  beforeAll(async () => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-pn-res-'));
    testDb = await createTestDatabase(pg.url);
    url = testDb.url;
  });
  afterAll(async () => {
    await testDb?.drop().catch(() => {});
    pg.stop();
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('reconcile applies the contract then no-ops on the resolved props', async () => {
    const targetHash = targetStorageHash(widgetContractJson);
    const first = await Effect.runPromise(reconcile(widgetContractJson));
    expect(first.storageHash).toBe(targetHash);
    const second = await Effect.runPromise(reconcile(widgetContractJson));
    expect(second.storageHash).toBe(targetHash);
  });

  test('reconcile re-throws a no-path failure: the Effect REJECTS with PnMigrationError', async () => {
    // Ensure the DB is signed at widgetHash (idempotent if already there).
    await Effect.runPromise(reconcile(widgetContractJson));

    // Target a DIFFERENT contract (gadget) with no authored migration path. The
    // provider's `catch: (e) => e` must route the thrown PnMigrationError into
    // the Effect's error channel — so the reconcile FAILS, not succeeds.
    const outcome = await Effect.runPromise(
      reconcile(gadgetContractJson).pipe(
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
