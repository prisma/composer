/**
 * The `OrmMigration` Alchemy resource wiring, proven WITHOUT Prisma
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
 *   - the provider's `reconcile` routes to `applyOrmMigration` — driven directly
 *     against the exported provider service, proven live against a real local
 *     Postgres (empty DB + authored baseline → replay, re-run → no-op,
 *     no-path → rejects).
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
import { OrmMigrationError, targetStorageHash } from '../orm-migrate.ts';
import type { OrmMigration } from '../orm-migration-resource.ts';
import { ormMigrationProviderService } from '../orm-migration-resource.ts';
import type { PgWarm } from '../pg-warm-resource.ts';
import { pgWarmProviderService } from '../pg-warm-resource.ts';
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
import { authorWidgetInit } from './widget-migrations-fixture.ts';

// Two trivial in-file Alchemy resources + providers — clean stand-ins for the
// descriptor's providers, so the merge mechanism is exercised with values no
// sibling test file's `mock.module` can replace (in-file consts are immune;
// imported constructors are not — see the header).
type ProbeA = Resource<'PrismaOrm.ProbeA', { readonly n: number }, { readonly n: number }>;
const ProbeA = Resource<ProbeA>('PrismaOrm.ProbeA');
type ProbeB = Resource<'PrismaOrm.ProbeB', { readonly n: number }, { readonly n: number }>;
const ProbeB = Resource<ProbeB>('PrismaOrm.ProbeB');
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
    const resolved = await resolveIn(merged, Provider.tryFindProviderByType('PrismaOrm.ProbeA'));
    expect(Option.isSome(resolved)).toBe(true);
  });

  test('merging does not shadow the second provider', async () => {
    const resolved = await resolveIn(merged, Provider.tryFindProviderByType('PrismaOrm.ProbeB'));
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
  const OrmMigrationTag = Resource<OrmMigration>('PrismaOrm.Migration');
  const PgWarmTag = Resource<PgWarm>('PrismaCloud.PgWarm');
  const realTags = Layer.mergeAll(
    Provider.effect(OrmMigrationTag, Effect.succeed(ormMigrationProviderService)),
    Provider.effect(PgWarmTag, Effect.succeed(pgWarmProviderService)),
  );

  test("tryFindProviderByType('PrismaOrm.Migration') resolves", async () => {
    const resolved = await resolveIn(
      realTags,
      Provider.tryFindProviderByType('PrismaOrm.Migration'),
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

const widgetConfig = path.join(
  import.meta.dir,
  'fixtures',
  'widget-contract',
  'source',
  'prisma.config.ts',
);
const gadgetConfig = path.join(
  import.meta.dir,
  'fixtures',
  'gadget-contract',
  'source',
  'prisma.config.ts',
);
const widgetHash = targetStorageHash(widgetContractJson);
const gadgetHash = targetStorageHash(gadgetContractJson);

const reconcile = (input: {
  readonly url: string;
  readonly migrationsDir: string;
  readonly configPath: string;
  readonly currentContractHash: string;
  readonly targetHash: string;
  readonly invariants?: readonly string[];
  readonly packHeadRefHashes?: readonly string[];
  readonly refName?: string;
}) =>
  ormMigrationProviderService.reconcile({
    id: 'db',
    fqn: 'db',
    instanceId: 'db',
    news: {
      url: input.url,
      migrationsDir: input.migrationsDir,
      configPath: input.configPath,
      currentContractHash: input.currentContractHash,
      targetHash: input.targetHash,
      invariants: input.invariants ?? [],
      packHeadRefHashes: input.packHeadRefHashes ?? [],
      ...(input.refName !== undefined ? { refName: input.refName } : {}),
    },
    olds: undefined,
    output: undefined,
    // The plan session / bindings are unused by this provider's reconcile.
    session: undefined as never,
    bindings: undefined as never,
  });

const matchFailure = <A>(effect: Effect.Effect<A, unknown, never>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onSuccess: () => ({ failed: false as const, error: undefined }),
        onFailure: (error: unknown) => ({ failed: true as const, error }),
      }),
    ),
  );

describe('OrmMigration contract loading and attestation', () => {
  const impossibleUrl = 'postgres://127.0.0.1:1/never-opened';

  test('a mismatched config-loaded contract fails before any database access', async () => {
    const outcome = await matchFailure(
      reconcile({
        url: impossibleUrl,
        migrationsDir: path.join(path.dirname(widgetConfig), 'migrations'),
        configPath: widgetConfig,
        currentContractHash: gadgetHash,
        targetHash: widgetHash,
      }),
    );

    expect(outcome.failed).toBe(true);
    expect(outcome.error).toBeInstanceOf(OrmMigrationError);
    expect((outcome.error as OrmMigrationError).code).toBe('CONTRACT_IDENTITY_MISMATCH');
  });

  test('a missing emitted contract artifact fails before any database access', async () => {
    const dir = fs.mkdtempSync(path.join(import.meta.dir, 'tmp-missing-contract-'));
    try {
      const configPath = path.join(dir, 'prisma.config.ts');
      const contractPath = path.relative(
        dir,
        path.join(import.meta.dir, 'fixtures', 'widget-contract', 'source', 'contract.ts'),
      );
      fs.writeFileSync(
        configPath,
        `import { definePrismaConfig } from '@prisma/cli-engine';\n` +
          "import { defineConfig } from '@prisma/orm-postgres/config';\n\n" +
          'export default definePrismaConfig({\n' +
          '  orm: defineConfig({\n' +
          `    contract: ${JSON.stringify(contractPath)},\n` +
          "    output: './missing',\n" +
          "    db: { connection: 'postgres://localhost:5432/placeholder' },\n" +
          '  }),\n' +
          '});\n',
      );

      const outcome = await matchFailure(
        reconcile({
          url: impossibleUrl,
          migrationsDir: path.join(dir, 'migrations'),
          configPath,
          currentContractHash: widgetHash,
          targetHash: widgetHash,
        }),
      );

      expect(outcome.failed).toBe(true);
      expect(outcome.error).toBeInstanceOf(OrmMigrationError);
      expect((outcome.error as OrmMigrationError).code).toBe('CONTRACT_ARTIFACT_UNREADABLE');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[app-cloud] skipping OrmMigration reconcile test: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL or install initdb/pg_ctl on PATH.',
  );
}

describe.skipIf(pg === undefined)('OrmMigration reconcile routes through applyOrmMigration', () => {
  if (pg === undefined) return;
  let migrationsDir: string;
  let testDb: TestDatabase;
  let url: string;

  beforeAll(async () => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-pn-res-'));
    // Replay-only: the deploy pipeline applies only authored migrations, so
    // the widget baseline must be on disk for the first reconcile to succeed.
    await authorWidgetInit(migrationsDir);
    testDb = await createTestDatabase(pg.url);
    url = testDb.url;
  });
  afterAll(async () => {
    await testDb?.drop().catch(() => {});
    pg.stop();
    if (migrationsDir !== undefined) fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  test('reconcile loads the config-declared contract, applies it, then no-ops on the resolved props', async () => {
    const first = await Effect.runPromise(
      reconcile({
        url,
        migrationsDir,
        configPath: widgetConfig,
        currentContractHash: widgetHash,
        targetHash: widgetHash,
      }),
    );
    expect(first.storageHash).toBe(widgetHash);
    const second = await Effect.runPromise(
      reconcile({
        url,
        migrationsDir,
        configPath: widgetConfig,
        currentContractHash: widgetHash,
        targetHash: widgetHash,
      }),
    );
    expect(second.storageHash).toBe(widgetHash);
  });

  test('reconcile re-throws a no-path failure: the Effect REJECTS with OrmMigrationError', async () => {
    // Ensure the DB is signed at widgetHash (idempotent if already there).
    await Effect.runPromise(
      reconcile({
        url,
        migrationsDir,
        configPath: widgetConfig,
        currentContractHash: widgetHash,
        targetHash: widgetHash,
      }),
    );

    // Target a DIFFERENT contract (gadget) with no authored migration path. The
    // provider's `catch: (e) => e` must route the thrown OrmMigrationError into
    // the Effect's error channel — so the reconcile FAILS, not succeeds.
    const outcome = await matchFailure(
      reconcile({
        url,
        migrationsDir,
        configPath: gadgetConfig,
        currentContractHash: gadgetHash,
        targetHash: gadgetHash,
      }),
    );

    expect(outcome.failed).toBe(true);
    expect(outcome.error).toBeInstanceOf(OrmMigrationError);
    expect((outcome.error as OrmMigrationError).code).toBe('MIGRATION_PATH_NOT_FOUND');
  });
});
