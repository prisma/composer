import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { StateStoreError } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import postgres from 'postgres';
import { ManagementClient } from '../../client.ts';
import { PrismaApiError } from '../../http.ts';
import { adoptLegacyState, failOnEmptyScopeWithLiveApps } from '../adoption.ts';
import { migratePrismaState } from '../schema.ts';
import { makePrismaStateService } from '../service.ts';
import { fakeClient, newFakeState, PROJECT_ID } from './fake-management-api.ts';
import { startTestPostgres, type TestPostgres } from './harness.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[alchemy/state] skipping adoption tests: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL to point at one, or install initdb/pg_ctl ' +
      '(e.g. `brew install postgresql@15`) on PATH.',
  );
}

describe.skipIf(pg === undefined)('adoptLegacyState', () => {
  if (pg === undefined) return;

  const sql = postgres(pg.url, { max: 5, onnotice: () => {} });
  const stack = 'demo-stack';
  const newStage = 'br_test123';

  const seedResource = (seedStack: string, stage: string, fqn: string) =>
    sql`
      insert into alchemy_resource_state (stack, stage, fqn, value)
      values (${seedStack}, ${stage}, ${fqn}, ${sql.json({ fqn })})
    `;
  const seedOutput = (seedStack: string, stage: string, value: Record<string, unknown>) =>
    sql`
      insert into alchemy_stack_output (stack, stage, value)
      values (${seedStack}, ${stage}, ${sql.json(value)})
    `;
  const stagesIn = async (table: 'alchemy_resource_state' | 'alchemy_stack_output') => {
    const rows =
      table === 'alchemy_resource_state'
        ? await sql<{ stage: string }[]>`
            select distinct stage from alchemy_resource_state where stack = ${stack} order by stage
          `
        : await sql<{ stage: string }[]>`
            select distinct stage from alchemy_stack_output where stack = ${stack} order by stage
          `;
    return rows.map((row) => row.stage);
  };
  const adopt = () => Effect.runPromise(adoptLegacyState(sql, stack, newStage));

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

  test('an empty database is a no-op reporting the scope as unoccupied', async () => {
    const result = await adopt();

    expect(result.occupied).toBe(false);
    expect(await stagesIn('alchemy_resource_state')).toEqual([]);
    expect(await stagesIn('alchemy_stack_output')).toEqual([]);
  });

  test('exactly one legacy scope: both tables re-stage transactionally and a one-line notice names old and new', async () => {
    await seedResource(stack, 'dev_alice', 'app/db');
    await seedResource(stack, 'dev_alice', 'app/service');
    await seedOutput(stack, 'dev_alice', { url: 'https://example.test' });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await adopt();

      expect(result.occupied).toBe(true);
      expect(await stagesIn('alchemy_resource_state')).toEqual([newStage]);
      expect(await stagesIn('alchemy_stack_output')).toEqual([newStage]);
      const printed = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(printed).toContain('dev_alice');
      expect(printed).toContain(newStage);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('after adoption the service reads the migrated rows and outputs under the new scope — the next deploy diffs against them', async () => {
    await seedResource(stack, 'dev_alice', 'app/db');
    await seedOutput(stack, 'dev_alice', { url: 'https://example.test' });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await adopt();
    } finally {
      errorSpy.mockRestore();
    }

    const service = makePrismaStateService(sql);
    expect(await Effect.runPromise(service.list({ stack, stage: newStage }))).toEqual(['app/db']);
    expect(await Effect.runPromise(service.getOutput({ stack, stage: newStage }))).toEqual({
      url: 'https://example.test',
    });
    expect(await Effect.runPromise(service.list({ stack, stage: 'dev_alice' }))).toEqual([]);
  });

  test('adoption is idempotent — a second run under the now-populated scope changes nothing', async () => {
    await seedResource(stack, 'dev_alice', 'app/db');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await adopt();
      await adopt();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(await stagesIn('alchemy_resource_state')).toEqual([newStage]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('more than one legacy scope fails with ONE error naming every scope and the fix, and moves nothing', async () => {
    await seedResource(stack, 'dev_alice', 'app/db');
    await seedResource(stack, 'dev_runner', 'app/db');
    await seedOutput(stack, 'unknown', { url: 'https://example.test' });

    const error: unknown = await adopt().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StateStoreError);
    const message = (error as StateStoreError).message;
    expect(message).toContain('"dev_alice"');
    expect(message).toContain('"dev_runner"');
    expect(message).toContain('"unknown"');
    expect(message).toContain(`"${newStage}" is empty`);
    expect(message).toContain('delete the other');
    expect(await stagesIn('alchemy_resource_state')).toEqual(['dev_alice', 'dev_runner']);
    expect(await stagesIn('alchemy_stack_output')).toEqual(['unknown']);
  });

  test('a populated new scope is left alone — legacy rows are not scanned or moved', async () => {
    await seedResource(stack, newStage, 'app/db');
    await seedResource(stack, 'dev_alice', 'app/db');
    await seedResource(stack, 'dev_runner', 'app/db');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await adopt();

      expect(result.occupied).toBe(true);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(await stagesIn('alchemy_resource_state')).toEqual([
        newStage,
        'dev_alice',
        'dev_runner',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('rows under the new scope in only ONE table still count as occupied', async () => {
    await seedOutput(stack, newStage, { url: 'https://example.test' });
    await seedResource(stack, 'dev_alice', 'app/db');

    await adopt();

    expect(await stagesIn('alchemy_resource_state')).toEqual(['dev_alice']);
  });

  test("other stacks' rows are invisible — neither adopted nor counted as a conflict", async () => {
    await seedResource('other-stack', 'dev_alice', 'app/db');
    await seedResource('other-stack', 'dev_runner', 'app/db');
    await seedResource(stack, 'dev_carol', 'app/db');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await adopt();
    } finally {
      errorSpy.mockRestore();
    }

    expect(await stagesIn('alchemy_resource_state')).toEqual([newStage]);
    const otherRows = await sql<{ stage: string }[]>`
      select distinct stage from alchemy_resource_state where stack = ${'other-stack'} order by stage
    `;
    expect(otherRows.map((row) => row.stage)).toEqual(['dev_alice', 'dev_runner']);
  });

  test('an adopted legacy scope may collide with existing new-scope rows in the other table only when the new scope is empty — a re-staged output joins migrated resources', async () => {
    // Resources under dev_alice, output under the OLD stage-name scope would be
    // the >1 case; this pins the single-scope case where the one legacy scope
    // holds rows in both tables at once.
    await seedResource(stack, 'staging', 'app/db');
    await seedOutput(stack, 'staging', { url: 'https://old.test' });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await adopt();
    } finally {
      errorSpy.mockRestore();
    }

    expect(await stagesIn('alchemy_resource_state')).toEqual([newStage]);
    expect(await stagesIn('alchemy_stack_output')).toEqual([newStage]);
  });
});

describe('failOnEmptyScopeWithLiveApps', () => {
  const branchId = 'br-default';
  const stage = 'br_test123';

  const check = (state = newFakeState()) =>
    Effect.runPromise(
      failOnEmptyScopeWithLiveApps(PROJECT_ID, branchId, stage).pipe(
        Effect.provideService(ManagementClient, fakeClient(state)),
      ),
    );

  test('an empty target branch passes — a genuinely fresh deploy proceeds', async () => {
    await expect(check()).resolves.toBeUndefined();
  });

  test('live apps on the target branch fail with ONE error naming the empty scope, the branch, and every app', async () => {
    const state = newFakeState({
      apps: [
        { id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId },
        { id: 'app-2', name: 'storefront.worker', projectId: PROJECT_ID, branchId },
      ],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrismaApiError);
    const message = (error as PrismaApiError).message;
    expect(message).toContain(`deploy state scope "${stage}" is empty`);
    expect(message).toContain(branchId);
    expect(message).toContain('"storefront.web"');
    expect(message).toContain('"storefront.worker"');
    expect(message).toContain('already_exists');
  });

  test("apps on a DIFFERENT branch don't count — another stage's apps never block this one", async () => {
    const state = newFakeState({
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId: 'br-other' }],
    });

    await expect(check(state)).resolves.toBeUndefined();
  });

  test("another project's apps don't count", async () => {
    const state = newFakeState({
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: 'proj-other', branchId }],
    });

    await expect(check(state)).resolves.toBeUndefined();
  });
});
