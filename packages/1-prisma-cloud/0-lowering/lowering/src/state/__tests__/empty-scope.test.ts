import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import { ManagementClient } from '../../client.ts';
import { PrismaApiError } from '../../http.ts';
import { failOnEmptyScopeWithLiveApps } from '../empty-scope.ts';
import { fakeClient, newFakeState, PROJECT_ID } from './fake-management-api.ts';

describe('failOnEmptyScopeWithLiveApps', () => {
  const branchId = 'br-default';
  const stack = 'demo-stack';
  const stage = 'br_test123';

  const check = (state = newFakeState()) =>
    Effect.runPromise(
      failOnEmptyScopeWithLiveApps(PROJECT_ID, branchId, stack, stage).pipe(
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
    expect(message).toContain(`no deploy state for stage "${stage}"`);
    expect(message).toContain(branchId);
    expect(message).toContain('"storefront.web"');
    expect(message).toContain('"storefront.worker"');
    expect(message).toContain('already_exists');
  });

  test('the message says the stage predates the platform state API and how to cut over', async () => {
    const state = newFakeState({
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId }],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    const message = (error as PrismaApiError).message;
    expect(message).toContain('predates the platform state API');
    expect(message).toContain('previous version of composer');
    expect(message).toContain('delete the stage');
    expect(message).toContain('redeploy fresh');
    expect(message).toContain('remove them or deploy into a different project');
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
    expect(message).toContain('3 app(s)');
    expect(message).toContain('"storefront.web"');
    expect(message).toContain('"storefront.worker"');
    expect(message).toContain('"storefront.jobs"');
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
