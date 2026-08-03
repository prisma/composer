import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import postgres from 'postgres';
import { ManagementClient } from '../../client.ts';
import { PrismaApiError } from '../../http.ts';
import { failOnEmptyScopeWithLiveApps, scopeOccupied } from '../empty-scope.ts';
import { migratePrismaState } from '../schema.ts';
import { fakeClient, newFakeState, PROJECT_ID } from './fake-management-api.ts';
import { startTestPostgres, type TestPostgres } from './harness.ts';

const pg: TestPostgres | undefined = startTestPostgres();

if (pg === undefined) {
  console.warn(
    '[alchemy/state] skipping empty-scope occupancy tests: no Postgres available. ' +
      'Set STATE_TEST_DATABASE_URL to point at one, or install initdb/pg_ctl ' +
      '(e.g. `brew install postgresql@15`) on PATH.',
  );
}

describe.skipIf(pg === undefined)('scopeOccupied', () => {
  if (pg === undefined) return;

  const sql = postgres(pg.url, { max: 5, onnotice: () => {} });
  const stack = 'demo-stack';
  const stage = 'br_test123';

  const occupied = () => Effect.runPromise(scopeOccupied(sql, stack, stage));

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

  test('an empty database is unoccupied', async () => {
    expect(await occupied()).toBe(false);
  });

  test('a resource row under the scope makes it occupied', async () => {
    await sql`
      insert into alchemy_resource_state (stack, stage, fqn, value)
      values (${stack}, ${stage}, 'app/db', ${sql.json({ fqn: 'app/db' })})
    `;

    expect(await occupied()).toBe(true);
  });

  test('an output row alone under the scope makes it occupied', async () => {
    await sql`
      insert into alchemy_stack_output (stack, stage, value)
      values (${stack}, ${stage}, ${sql.json({ url: 'https://example.test' })})
    `;

    expect(await occupied()).toBe(true);
  });

  test("other scopes' and other stacks' rows don't count", async () => {
    await sql`
      insert into alchemy_resource_state (stack, stage, fqn, value)
      values (${stack}, 'dev_alice', 'app/db', ${sql.json({ fqn: 'app/db' })})
    `;
    await sql`
      insert into alchemy_resource_state (stack, stage, fqn, value)
      values ('other-stack', ${stage}, 'app/db', ${sql.json({ fqn: 'app/db' })})
    `;

    expect(await occupied()).toBe(false);
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

  test('the message tells a pre-branch-id deployment how to migrate manually, and a foreign one to move aside', async () => {
    const state = newFakeState({
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId }],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    const message = (error as PrismaApiError).message;
    expect(message).toContain('destroy and redeploy');
    expect(message).toContain(
      'UPDATE the stage column of alchemy_resource_state and alchemy_stack_output',
    );
    expect(message).toContain(`to "${stage}"`);
    expect(message).toContain('remove them or deploy into a different project');
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
