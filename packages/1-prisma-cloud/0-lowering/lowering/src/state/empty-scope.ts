import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import { call, PrismaApiError } from '../http.ts';
import { collectPages } from '../pagination.ts';
import type { DeployLease, LeaseScope } from './lease.ts';

/**
 * Whether the platform state API holds any resources for (stack, stage).
 * Requires the live deploy lease — the listing runs under it, like every
 * state operation.
 */
export const scopeOccupied = (
  client: ManagementApiClient,
  scope: LeaseScope,
  lease: DeployLease,
): Effect.Effect<boolean, PrismaApiError> =>
  call(() =>
    client.GET(
      '/v1/projects/{projectId}/branches/{branchId}/alchemy-state/state/stacks/{stack}/stages/{stage}/resources',
      {
        params: {
          path: {
            projectId: scope.projectId,
            branchId: scope.branchId,
            stack: scope.stack,
            stage: scope.stage,
          },
          header: { 'alchemy-state-lease-id': Redacted.value(lease.leaseId) },
        },
      },
    ),
  ).pipe(Effect.map((fqns) => fqns.length > 0));

interface AppSummary {
  readonly id: string;
  readonly name: string;
}

// Bounded (collectPages): this check runs under the deploy lease, so broken
// pagination must fail loudly, never hang or pass on a partial listing.
const listAppsOnBranch = (
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
): Effect.Effect<readonly AppSummary[], PrismaApiError> =>
  collectPages(`apps on branch ${branchId}`, (cursor) =>
    call(() =>
      client.GET('/v1/apps', {
        params: {
          query: cursor === undefined ? { projectId, branchId } : { projectId, branchId, cursor },
        },
      }),
    ),
  );

/**
 * The empty-scope-with-live-apps case: the platform state API holds no
 * resources for (stack, stage) while the platform already runs Compute apps
 * on the target Branch — this stage predates the platform state API (its
 * state lives in a legacy `prisma-composer-state` database, which is never
 * read; there is no automatic migration), or the deploy targets a project
 * that already runs apps. Deploying would recreate every resource and die in
 * per-resource `already_exists` failures — so fail once, up front. A
 * genuinely fresh deploy sees an empty Branch and passes. Local dev never
 * reaches this — the dev stack pins `state: localState()`
 * (generate-dev-stack.ts).
 */
export const failOnEmptyScopeWithLiveApps = (
  projectId: string,
  branchId: string,
  stack: string,
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
          `the platform state API holds no deploy state for stage "${stage}" (stack "${stack}"), but the ` +
          `platform already runs ${String(apps.length)} app(s) on the target branch ${branchId}: ${names}. ` +
          'This stage predates the platform state API. With no state, a deploy would recreate every ' +
          'resource and fail with already_exists, and a destroy would remove nothing. Destroy the stage ' +
          'with the previous version of composer, or delete the stage (its branch — or the project, for ' +
          'production) in the Prisma Console or via the Management API — then redeploy fresh. If those ' +
          "apps are another deployment's, remove them or deploy into a different project. Then retry.",
      }),
    );
  });
