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

interface NamedResource {
  readonly id: string;
  readonly name: string;
}

// Bounded (collectPages): these checks run under the deploy lease, so broken
// pagination must fail loudly, never hang or pass on a partial listing.
// Connections are deliberately not listed — they are children of databases,
// so the database listing already covers every stage that has one.
const listBranchResources = (
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
): Effect.Effect<
  readonly { kind: 'app' | 'database' | 'bucket'; name: string }[],
  PrismaApiError
> =>
  Effect.gen(function* () {
    const query = (cursor: string | undefined) =>
      cursor === undefined ? { projectId, branchId } : { projectId, branchId, cursor };
    const apps: readonly NamedResource[] = yield* collectPages(
      `apps on branch ${branchId}`,
      (cursor) => call(() => client.GET('/v1/apps', { params: { query: query(cursor) } })),
    );
    const databases: readonly NamedResource[] = yield* collectPages(
      `databases on branch ${branchId}`,
      (cursor) => call(() => client.GET('/v1/databases', { params: { query: query(cursor) } })),
    );
    const buckets: readonly NamedResource[] = yield* collectPages(
      `buckets on branch ${branchId}`,
      (cursor) => call(() => client.GET('/v1/buckets', { params: { query: query(cursor) } })),
    );
    return [
      ...apps.map((r) => ({ kind: 'app' as const, name: r.name })),
      ...databases.map((r) => ({ kind: 'database' as const, name: r.name })),
      ...buckets.map((r) => ({ kind: 'bucket' as const, name: r.name })),
    ];
  });

/**
 * The empty-scope-with-live-resources case: the platform state API holds no
 * resources for (stack, stage) while the platform already has Compute apps,
 * databases, or buckets on the target Branch — this stage predates the
 * platform state API (its state lives in a legacy `prisma-composer-state`
 * database, which is never read; there is no automatic migration), or the
 * deploy targets a project that already runs something. Deploying would
 * recreate every resource and die in per-resource `already_exists` failures —
 * so fail once, up front. A genuinely fresh deploy sees an empty Branch and
 * passes. Connections are not counted: they are children of databases, which
 * are. Local dev never reaches this — the dev stack pins
 * `state: localState()` (generate-dev-stack.ts).
 */
export const failOnEmptyScopeWithLiveResources = (
  projectId: string,
  branchId: string,
  stack: string,
  stage: string,
): Effect.Effect<void, PrismaApiError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    const resources = yield* listBranchResources(client, projectId, branchId);
    if (resources.length === 0) return;
    const names = resources.map((r) => `${r.kind} "${r.name}"`).join(', ');
    return yield* Effect.fail(
      new PrismaApiError({
        status: 0,
        message:
          `the platform state API holds no deploy state for stage "${stage}" (stack "${stack}"), but the ` +
          `platform already has ${String(resources.length)} resource(s) on the target branch ${branchId}: ${names}. ` +
          'This stage predates the platform state API. With no state, a deploy would recreate every ' +
          'resource and fail with already_exists, and a destroy would remove nothing. Destroy the stage ' +
          'with the previous version of composer, or delete the stage (its branch — or the project, for ' +
          'production) in the Prisma Console or via the Management API — then redeploy fresh. If those ' +
          "resources are another deployment's, remove them or deploy into a different project. Then retry.",
      }),
    );
  });
