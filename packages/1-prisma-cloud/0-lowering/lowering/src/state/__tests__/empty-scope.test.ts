import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import { ManagementClient } from '../../client.ts';
import { PrismaApiError } from '../../http.ts';
import { failOnEmptyScopeWithLiveResources } from '../empty-scope.ts';
import { fakeClient, newFakeState, PROJECT_ID } from './fake-management-api.ts';

describe('failOnEmptyScopeWithLiveResources', () => {
  const branchId = 'br-default';
  const stack = 'demo-stack';

  const check = (state = newFakeState(), declaredAddresses?: readonly string[]) =>
    Effect.runPromise(
      failOnEmptyScopeWithLiveResources(PROJECT_ID, branchId, stack, declaredAddresses).pipe(
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
    expect(message).toContain('destroyed with that version, or deleted');
    expect(message).toContain('then deployed again');
    expect(message).toContain('belong to something else');
    expect(message).toContain('remove them or deploy into a different project');
    expect(message).not.toContain('predates');
  });

  test('the message for one resource leaves room under the 1000 characters the CLI prints of a failure', async () => {
    const state = newFakeState({
      apps: [{ id: 'app-1', name: 'storefront.web', projectId: PROJECT_ID, branchId }],
    });

    const error: unknown = await check(state).catch((e: unknown) => e);

    expect((error as PrismaApiError).message.length).toBeLessThan(840);
  });

  describe('apps the deploy declares', () => {
    const declared = ['storefront.web', 'storefront.worker'];
    const web = {
      id: 'app-1',
      name: 'web',
      projectId: PROJECT_ID,
      branchId,
      logicalId: 'storefront.web',
    };
    const worker = {
      id: 'app-2',
      name: 'worker',
      projectId: PROJECT_ID,
      branchId,
      logicalId: 'storefront.worker',
    };

    test('apps that each hold a declared service address as logicalId pass', async () => {
      await expect(check(newFakeState({ apps: [web, worker] }), declared)).resolves.toBeUndefined();
    });

    test('an empty branch passes with declared addresses too', async () => {
      await expect(check(newFakeState(), declared)).resolves.toBeUndefined();
    });

    test('one app with a logicalId the deploy does not declare fails, and only it is named', async () => {
      const state = newFakeState({
        apps: [
          web,
          { id: 'app-3', name: 'jobs', projectId: PROJECT_ID, branchId, logicalId: 'other.jobs' },
        ],
      });

      const error: unknown = await check(state, declared).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PrismaApiError);
      const message = (error as PrismaApiError).message;
      expect(message).toContain('1 resource(s) that this deploy cannot take over');
      expect(message).toContain('app "jobs" (logicalId "other.jobs")');
      expect(message).not.toContain('app "web"');
    });

    test('an app with no logicalId fails, even when its name is a declared address', async () => {
      const state = newFakeState({
        apps: [web, { id: 'app-3', name: 'storefront.worker', projectId: PROJECT_ID, branchId }],
      });

      const error: unknown = await check(state, declared).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PrismaApiError);
      const message = (error as PrismaApiError).message;
      expect(message).toContain('1 resource(s)');
      expect(message).toContain('app "storefront.worker" (no logicalId)');
      expect(message).not.toContain('app "web"');
    });

    test('a database or a bucket fails even when its logicalId is a declared address', async () => {
      const state = newFakeState({
        apps: [web],
        databases: [
          { id: 'db-1', name: 'db', projectId: PROJECT_ID, branchId, logicalId: 'storefront.db' },
        ],
        buckets: [
          {
            id: 'bkt-1',
            name: 'files',
            projectId: PROJECT_ID,
            branchId,
            logicalId: 'storefront.files',
          },
        ],
      });

      const error: unknown = await check(state, [
        ...declared,
        'storefront.db',
        'storefront.files',
      ]).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PrismaApiError);
      const message = (error as PrismaApiError).message;
      expect(message).toContain('2 resource(s)');
      expect(message).toContain('database "db" (logicalId "storefront.db")');
      expect(message).toContain('bucket "files" (logicalId "storefront.files")');
      expect(message).toContain('A database or a bucket is never taken over');
      expect(message).not.toContain('app "web"');
    });

    test('with no declared addresses, as on a destroy, an app with a logicalId still fails', async () => {
      const error: unknown = await check(newFakeState({ apps: [web] })).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PrismaApiError);
      expect((error as PrismaApiError).message).toContain('app "web" (logicalId "storefront.web")');
    });

    test('the message says how to make the deploy take an app over, and what that means', async () => {
      const state = newFakeState({
        apps: [{ id: 'app-1', name: 'web', projectId: PROJECT_ID, branchId }],
      });

      const error: unknown = await check(state, declared).catch((e: unknown) => e);

      const message = (error as PrismaApiError).message;
      expect(message).toContain('set its logicalId to the address of the service that declares it');
      expect(message).toContain('PATCH /v1/apps/<id> with {"logicalId":"<app>.<node>"}');
      expect(message).toContain('a deploy without the node deletes it');
    });
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
