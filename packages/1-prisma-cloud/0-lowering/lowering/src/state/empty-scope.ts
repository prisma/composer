import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import { call, PrismaApiError } from '../http.ts';
import { collectPages } from '../pagination.ts';
import type { DeployLease, LeaseScope } from './lease.ts';

/**
 * Whether the platform state API holds any resources for (stack, Alchemy stage).
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

interface BranchResource {
  readonly kind: 'app' | 'database' | 'bucket';
  readonly name: string;
  readonly logicalId: string | null;
}

interface ListedResource {
  readonly name: string;
  readonly logicalId: string | null;
}

// Bounded (collectPages): these checks run under the deploy lease, so broken
// pagination must fail loudly, never hang or pass on a partial listing.
// Connections are deliberately not listed — they are children of databases,
// so the database listing already covers every Branch that has one.
const listBranchResources = (
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
): Effect.Effect<readonly BranchResource[], PrismaApiError> =>
  Effect.gen(function* () {
    const query = (cursor: string | undefined) =>
      cursor === undefined ? { projectId, branchId } : { projectId, branchId, cursor };
    const apps: readonly ListedResource[] = yield* collectPages(
      `apps on branch ${branchId}`,
      (cursor) => call(() => client.GET('/v1/apps', { params: { query: query(cursor) } })),
    );
    const databases: readonly ListedResource[] = yield* collectPages(
      `databases on branch ${branchId}`,
      (cursor) => call(() => client.GET('/v1/databases', { params: { query: query(cursor) } })),
    );
    const buckets: readonly ListedResource[] = yield* collectPages(
      `buckets on branch ${branchId}`,
      (cursor) => call(() => client.GET('/v1/buckets', { params: { query: query(cursor) } })),
    );
    const of = (kind: BranchResource['kind']) => (r: ListedResource) => ({
      kind,
      name: r.name,
      logicalId: r.logicalId,
    });
    return [...apps.map(of('app')), ...databases.map(of('database')), ...buckets.map(of('bucket'))];
  });

const describeResource = (r: BranchResource): string =>
  `${r.kind} "${r.name}" (${r.logicalId === null ? 'no logicalId' : `logicalId "${r.logicalId}"`})`;

/**
 * The empty-scope-with-live-resources case: the platform state API holds no
 * resources for (stack, Alchemy stage) while the platform already has Compute apps,
 * databases, or buckets on the target Branch.
 *
 * An app whose `logicalId` is one of `declaredAppAddresses` is the row of a
 * service this deploy declares, and the deploy takes it over (ADR-0057). Any
 * other resource fails the check, once, up front: it was deployed by an older
 * Composer version whose state store is never read, or it belongs to
 * something other than this app. A database or a bucket always fails it: a
 * later deploy without its node deletes the row and its data, so taking one
 * over is not offered here. A destroy passes no addresses, so it is refused
 * whenever the Branch holds a resource. A genuinely fresh deploy sees an
 * empty Branch and passes. Connections are not counted: they are children of
 * databases, which are. Local dev never reaches this: it lowers with
 * `state: devState()`, Alchemy's local file store (execute-dev.ts).
 */
export const failOnEmptyScopeWithLiveResources = (
  projectId: string,
  branchId: string,
  stack: string,
  declaredAppAddresses: readonly string[] = [],
): Effect.Effect<void, PrismaApiError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    const resources = yield* listBranchResources(client, projectId, branchId);
    const declared = new Set(declaredAppAddresses);
    const refused = resources.filter(
      (r) => r.kind !== 'app' || r.logicalId === null || !declared.has(r.logicalId),
    );
    if (refused.length === 0) return;
    return yield* Effect.fail(
      new PrismaApiError({
        status: 0,
        message:
          `the Branch ${branchId} (stack "${stack}") has no deploy state, but already holds ` +
          `${String(refused.length)} resource(s) that this deploy cannot take over: ` +
          `${refused.map(describeResource).join(', ')}. Without state, a deploy would try to ` +
          'recreate them and a destroy would remove nothing. To take over an app created outside ' +
          'Composer, set its logicalId to the address of the service that declares it (PATCH ' +
          '/v1/apps/<id> with {"logicalId":"<app>.<node>"}), then deploy again. Composer then owns ' +
          'it: a deploy without the node deletes it. A database or a bucket is never taken over. ' +
          'An environment from a Composer version that kept deploy state elsewhere must be ' +
          'destroyed with that version, or deleted (its branch, or the project for production), ' +
          'then deployed again. If the resources belong to something else, remove them or deploy ' +
          'into a different project.',
      }),
    );
  });
