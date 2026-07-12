import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CreatedResourceState, ReplacedResourceState } from 'alchemy/State';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import postgres from 'postgres';
import { makePrismaStateService, migratePrismaState } from '../index.ts';
import { startTestPostgres, type TestPostgres } from './harness.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[alchemy/state] skipping state store tests: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL to point at one, or install initdb/pg_ctl ' +
      '(e.g. `brew install postgresql@15`) on PATH.',
  );
}

const createdResource = (overrides: Partial<CreatedResourceState> = {}): CreatedResourceState => ({
  resourceType: 'Test.Resource',
  namespace: undefined,
  fqn: 'test/resource',
  logicalId: 'resource',
  instanceId: 'instance-1',
  providerVersion: 1,
  status: 'created',
  downstream: [],
  bindings: [],
  props: {},
  attr: {},
  ...overrides,
});

const replacedResource = (
  overrides: Partial<ReplacedResourceState> = {},
): ReplacedResourceState => ({
  resourceType: 'Test.Resource',
  namespace: undefined,
  fqn: 'test/replaced',
  logicalId: 'replaced',
  instanceId: 'instance-2',
  providerVersion: 1,
  status: 'replaced',
  downstream: [],
  bindings: [],
  props: {},
  attr: {},
  old: createdResource({ fqn: 'test/replaced-old' }),
  deleteFirst: false,
  ...overrides,
});

describe.skipIf(pg === undefined)('makePrismaStateService', () => {
  if (pg === undefined) return;

  // The migration idempotence test intentionally re-runs `create table if not
  // exists`, which Postgres reports via NOTICE — silence those so test output
  // isn't dominated by expected, harmless noise.
  const sql = postgres(pg.url, { max: 5, onnotice: () => {} });
  const service = makePrismaStateService(sql);
  const stack = 'test-stack';
  const stage = 'test-stage';

  beforeAll(async () => {
    await Effect.runPromise(migratePrismaState(sql));
  });

  afterAll(async () => {
    await sql.end({ timeout: 1 });
    pg.stop();
  });

  beforeEach(async () => {
    await sql`truncate table alchemy_resource_state, alchemy_stack_output`;
  });

  test('id identifies this store', () => {
    expect(service.id).toBe('prisma-postgres');
  });

  test('getVersion returns the alchemy STATE_STORE_VERSION', async () => {
    const version = await Effect.runPromise(service.getVersion());
    expect(version).toBe(5);
  });

  test('all 12 methods round-trip a resource and a stack output', async () => {
    expect(await Effect.runPromise(service.listStacks())).toEqual([]);

    const value = createdResource({ fqn: 'app/db' });
    const setResult = await Effect.runPromise(service.set({ stack, stage, fqn: value.fqn, value }));
    expect(setResult).toEqual(value);

    expect(await Effect.runPromise(service.listStacks())).toEqual([stack]);
    expect(await Effect.runPromise(service.listStages(stack))).toEqual([stage]);
    expect(await Effect.runPromise(service.list({ stack, stage }))).toEqual([value.fqn]);

    const fetched = await Effect.runPromise(service.get({ stack, stage, fqn: value.fqn }));
    expect(fetched).toEqual(value);

    expect(
      await Effect.runPromise(service.get({ stack, stage, fqn: 'does/not-exist' })),
    ).toBeUndefined();

    const outputValue = { url: 'https://example.test' };
    const setOutputResult = await Effect.runPromise(
      service.setOutput({ stack, stage, value: outputValue }),
    );
    expect(setOutputResult).toEqual(outputValue);
    expect(await Effect.runPromise(service.getOutput({ stack, stage }))).toEqual(outputValue);

    await Effect.runPromise(service.delete({ stack, stage, fqn: value.fqn }));
    expect(await Effect.runPromise(service.get({ stack, stage, fqn: value.fqn }))).toBeUndefined();
  });

  test('list excludes stack outputs — resources and outputs live in separate tables', async () => {
    const value = createdResource({ fqn: 'app/queue' });
    await Effect.runPromise(service.set({ stack, stage, fqn: value.fqn, value }));
    await Effect.runPromise(service.setOutput({ stack, stage, value: { ok: true } }));

    expect(await Effect.runPromise(service.list({ stack, stage }))).toEqual([value.fqn]);
  });

  test('getReplacedResources filters to status = replaced', async () => {
    const created = createdResource({ fqn: 'app/created' });
    const replaced = replacedResource({ fqn: 'app/replaced' });
    await Effect.runPromise(service.set({ stack, stage, fqn: created.fqn, value: created }));
    await Effect.runPromise(service.set({ stack, stage, fqn: replaced.fqn, value: replaced }));

    const result = await Effect.runPromise(service.getReplacedResources({ stack, stage }));
    expect(result).toEqual([replaced]);
  });

  test('deleteStack with a stage removes only that stage', async () => {
    const other = 'other-stage';
    await Effect.runPromise(
      service.set({
        stack,
        stage,
        fqn: 'app/a',
        value: createdResource({ fqn: 'app/a' }),
      }),
    );
    await Effect.runPromise(
      service.set({
        stack,
        stage: other,
        fqn: 'app/b',
        value: createdResource({ fqn: 'app/b' }),
      }),
    );
    await Effect.runPromise(service.setOutput({ stack, stage, value: { a: true } }));
    await Effect.runPromise(service.setOutput({ stack, stage: other, value: { b: true } }));

    await Effect.runPromise(service.deleteStack({ stack, stage }));

    expect(await Effect.runPromise(service.list({ stack, stage }))).toEqual([]);
    expect(await Effect.runPromise(service.getOutput({ stack, stage }))).toBeUndefined();
    expect(await Effect.runPromise(service.list({ stack, stage: other }))).toEqual(['app/b']);
    expect(await Effect.runPromise(service.getOutput({ stack, stage: other }))).toEqual({
      b: true,
    });
  });

  test('deleteStack without a stage removes every stage of the stack', async () => {
    await Effect.runPromise(
      service.set({
        stack,
        stage,
        fqn: 'app/a',
        value: createdResource({ fqn: 'app/a' }),
      }),
    );
    await Effect.runPromise(
      service.set({
        stack,
        stage: 'other-stage',
        fqn: 'app/b',
        value: createdResource({ fqn: 'app/b' }),
      }),
    );

    await Effect.runPromise(service.deleteStack({ stack }));

    expect(await Effect.runPromise(service.listStages(stack))).toEqual([]);
  });

  test('Redacted values round-trip byte-identically', async () => {
    const value = createdResource({
      fqn: 'app/secret',
      props: { token: Redacted.make('sk-live-abc123') },
    });
    await Effect.runPromise(service.set({ stack, stage, fqn: value.fqn, value }));

    const revived = await Effect.runPromise(service.get({ stack, stage, fqn: value.fqn }));
    const props = (revived as CreatedResourceState | undefined)?.props;
    expect(Redacted.isRedacted(props?.['token'])).toBe(true);
    expect(Redacted.value<string>(props?.['token'])).toBe('sk-live-abc123');
  });

  test('Duration values round-trip', async () => {
    const value = createdResource({
      fqn: 'app/ttl',
      props: { ttl: Duration.seconds(30) },
    });
    await Effect.runPromise(service.set({ stack, stage, fqn: value.fqn, value }));

    const revived = await Effect.runPromise(service.get({ stack, stage, fqn: value.fqn }));
    const props = (revived as CreatedResourceState | undefined)?.props;
    expect(Duration.isDuration(props?.['ttl'])).toBe(true);
    expect(Duration.toSeconds(props?.['ttl'])).toBe(30);
  });

  test('migratePrismaState is idempotent — running it twice does not throw', async () => {
    await Effect.runPromise(migratePrismaState(sql));
    await Effect.runPromise(migratePrismaState(sql));

    const value = createdResource({ fqn: 'app/post-remigrate' });
    await Effect.runPromise(service.set({ stack, stage, fqn: value.fqn, value }));
    expect(await Effect.runPromise(service.get({ stack, stage, fqn: value.fqn }))).toEqual(value);
  });
});
