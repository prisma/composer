import type { StateStoreError } from 'alchemy/State';
import * as Effect from 'effect/Effect';
import type postgres from 'postgres';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import { call, PrismaApiError } from '../http.ts';
import { toStateStoreError } from './errors.ts';

/** Whether the (stack, stage) scope holds any rows in either state table. */
export const scopeOccupied = (
  sql: postgres.Sql,
  stack: string,
  stage: string,
): Effect.Effect<boolean, StateStoreError, never> =>
  Effect.tryPromise({
    try: async () => {
      const rows = await sql<{ occupied: boolean }[]>`
        select
          exists (select 1 from alchemy_resource_state where stack = ${stack} and stage = ${stage})
          or exists (select 1 from alchemy_stack_output where stack = ${stack} and stage = ${stage})
          as occupied
      `;
      return rows[0]?.occupied === true;
    },
    catch: toStateStoreError,
  });

interface AppSummary {
  readonly id: string;
  readonly name: string;
}

const listAppsOnBranch = (
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
): Effect.Effect<readonly AppSummary[], PrismaApiError> =>
  Effect.gen(function* () {
    const apps: AppSummary[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query =
        cursor === undefined ? { projectId, branchId } : { projectId, branchId, cursor };
      const page = yield* call(() => client.GET('/v1/apps', { params: { query } }));
      apps.push(...page.data);
      if (!page.pagination.hasMore || page.pagination.nextCursor === null) break;
      cursor = page.pagination.nextCursor;
    }
    return apps;
  });

/**
 * The empty-scope-with-live-apps case: the branch-id scope holds no rows
 * while the platform already runs Compute apps on the target Branch. Either
 * this is a pre-branch-id deployment whose rows still sit under a legacy
 * scope (`dev_$USER`, `unknown`, or the old stage name — there is no
 * automatic migration; operator decision TML-3157), or the deploy targets a
 * project that already runs apps. Deploying would recreate every resource
 * and die in per-resource `already_exists` failures — so fail once, up
 * front, naming the empty scope and what exists. Any app on the Branch is
 * this deploy's concern: the Project is app-scoped and the Branch is the
 * deploy's own target. A genuinely fresh deploy sees an empty Branch and
 * passes. Local dev never reaches this — the dev stack pins
 * `state: localState()` (generate-dev-stack.ts).
 */
export const failOnEmptyScopeWithLiveApps = (
  projectId: string,
  branchId: string,
  stage: string,
): Effect.Effect<void, PrismaApiError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    const apps = yield* listAppsOnBranch(client, projectId, branchId);
    if (apps.length === 0) return;
    const names = apps.map((app) => `"${app.name}"`).join(', ');
    return yield* Effect.fail(
      new PrismaApiError({
        status: 0,
        message:
          `the deploy state scope "${stage}" is empty, but the platform already runs ` +
          `${String(apps.length)} app(s) on the target branch ${branchId}: ${names}. With no ` +
          'state, a deploy would recreate every resource and fail with already_exists, and a ' +
          'destroy would remove nothing. If those apps are a deployment from before the ' +
          'branch-id state scope, UPDATE the stage column of alchemy_resource_state and ' +
          `alchemy_stack_output to "${stage}" in this branch's prisma-composer-state database ` +
          '— or delete the apps in the Prisma Console (or via the Management API) and ' +
          "redeploy fresh. If they are another deployment's, remove them or deploy into a " +
          'different project. Then retry.',
      }),
    );
  });
