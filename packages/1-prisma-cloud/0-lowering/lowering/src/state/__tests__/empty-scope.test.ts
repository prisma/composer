import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import { ManagementClient } from '../../client.ts';
import { PrismaApiError } from '../../http.ts';
import { failOnEmptyScopeWithLiveResources } from '../empty-scope.ts';
import { fakeClient, newFakeState, PROJECT_ID } from './fake-management-api.ts';

describe('failOnEmptyScopeWithLiveResources', () => {
  const branchId = 'br-default';
  const stack = 'demo-stack';

  const check = (state = newFakeState()) =>
    Effect.runPromise(
      failOnEmptyScopeWithLiveResources(PROJECT_ID, branchId, stack).pipe(
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
    expect(message).toContain(`the Branch ${branchId} (stack "${stack}") has no deploy state`);
    expect(message).toContain(branchId);
    expect(message).toContain('app "storefront.web"');
    expect(message).toContain('app "storefront.worker"');
    expect(message).toContain('a deploy would try to recreate them');
  });

  test('a database-only legacy environment fails too — a legacy prisma-composer-state database alone trips the guard', async () => {
    const state = newFakeState({
      databases: [{ id: 'db-1', name: 'prisma-composer-state', projectId: PROJECT_ID, branchId }],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrismaApiError);
    const message = (error as PrismaApiError).message;
    expect(message).toContain('1 resource(s)');
    expect(message).toContain('database "prisma-composer-state"');
    expect(message).toContain('has no deploy state');
  });

  test('a bucket-only branch fails too', async () => {
    const state = newFakeState({
      buckets: [{ id: 'bkt-1', name: 'files', projectId: PROJECT_ID, branchId }],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).message).toContain('bucket "files"');
  });

  test('mixed kinds are all named, each with its kind', async () => {
    const state = newFakeState({
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId }],
      databases: [{ id: 'db-1', name: 'database', projectId: PROJECT_ID, branchId }],
      buckets: [{ id: 'bkt-1', name: 'files', projectId: PROJECT_ID, branchId }],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    const message = (error as PrismaApiError).message;
    expect(message).toContain('3 resource(s)');
    expect(message).toContain('app "storefront.web"');
    expect(message).toContain('database "database"');
    expect(message).toContain('bucket "files"');
  });

  test('the message names both causes and how to recover', async () => {
    const state = newFakeState({
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId }],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    const message = (error as PrismaApiError).message;
    expect(message).toContain('has no deploy state');
    expect(message).toContain('a Composer version that kept deploy state elsewhere');
    expect(message).toContain('something other than this app');
    expect(message).toContain('Delete the environment');
    expect(message).toContain('deploy again');
    expect(message).toContain('remove them or deploy into a different project');
    expect(message).not.toContain('predates');
  });

  test('a multi-page listing is walked to the end — apps beyond the first page still fail the check by name', async () => {
    const state = newFakeState({
      appsPageSize: 1,
      apps: [
        { id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId },
        { id: 'app-2', name: 'storefront.worker', projectId: PROJECT_ID, branchId },
        { id: 'app-3', name: 'storefront.jobs', projectId: PROJECT_ID, branchId },
      ],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrismaApiError);
    const message = (error as PrismaApiError).message;
    expect(message).toContain('3 resource(s)');
    expect(message).toContain('app "storefront.web"');
    expect(message).toContain('app "storefront.worker"');
    expect(message).toContain('app "storefront.jobs"');
    // Each app appears exactly once — pagination never double-counts.
    expect(message.match(/storefront\.web/g)).toHaveLength(1);
  });

  test('a non-advancing cursor fails as broken pagination — never a verdict from a partial listing', async () => {
    const state = newFakeState({
      appsPageSize: 1,
      appsCursorStuck: true,
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId }],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrismaApiError);
    const message = (error as PrismaApiError).message;
    expect(message).toContain('pagination appears broken');
    expect(message).not.toContain('storefront.web');
  });

  test('a stuck EMPTY page (data: [], hasMore: true) also fails — it must not read as "no apps, proceed"', async () => {
    const state = newFakeState({ appsPageSize: 1, appsCursorStuck: true, apps: [] });

    const error: unknown = await check(state).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).message).toContain('pagination appears broken');
  });

  test("resources on a DIFFERENT branch don't count — another environment's resources never block this one", async () => {
    const state = newFakeState({
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId: 'br-other' }],
      databases: [{ id: 'db-1', name: 'database', projectId: PROJECT_ID, branchId: 'br-other' }],
      buckets: [{ id: 'bkt-1', name: 'files', projectId: PROJECT_ID, branchId: 'br-other' }],
    });

    await expect(check(state)).resolves.toBeUndefined();
  });

  test("another project's resources don't count", async () => {
    const state = newFakeState({
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: 'proj-other', branchId }],
      databases: [{ id: 'db-1', name: 'database', projectId: 'proj-other', branchId }],
    });

    await expect(check(state)).resolves.toBeUndefined();
  });
});
