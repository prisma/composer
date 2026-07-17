import * as Effect from 'effect/Effect';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import { callVoid, type PrismaApiError } from '../http.ts';
import { type OwnershipVerifier, verifyOwnership } from './bootstrap.ts';
import {
  listStateDatabaseCandidates,
  mintConnection,
  resolveBranchId,
  STATE_DATABASE_NAME,
  type StateTarget,
} from './discovery.ts';

const deleteDatabase = (
  client: ManagementApiClient,
  databaseId: string,
): Effect.Effect<void, PrismaApiError> =>
  callVoid(() => client.DELETE('/v1/databases/{databaseId}', { params: { path: { databaseId } } }));

/**
 * Removes the stage's state database, so the CLI's destroy leaves nothing
 * behind: for a named stage the Branch cannot be deleted while this database
 * is still a live member, and for production it would otherwise outlive the
 * stage and hold a quota slot.
 *
 * Every candidate is checked for our ownership marker before deletion —
 * deleting by name alone would destroy a user's database that happens to
 * share the name. All owned candidates are removed, not just the first: a
 * crashed earlier run can leave duplicates, and they are all ours. Finding
 * none succeeds, which is what makes a retried destroy a no-op.
 */
export const deleteStateDatabase = (
  target: StateTarget,
): Effect.Effect<void, PrismaApiError, ManagementClient> =>
  deleteStateDatabaseWith(target, verifyOwnership);

/**
 * Test seam: identical to {@link deleteStateDatabase} but with the ownership
 * verifier injectable, so the tests can stub ownership decisions against fake
 * DSNs without opening a real Postgres connection to them.
 */
export const deleteStateDatabaseWith = (
  target: StateTarget,
  verify: OwnershipVerifier,
): Effect.Effect<void, PrismaApiError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    const branchId = yield* resolveBranchId(client, target);
    const candidates = yield* listStateDatabaseCandidates(client, target.projectId, branchId);

    for (const candidate of candidates) {
      const connectionString = yield* mintConnection(client, candidate.id);
      const verdict = yield* verify(connectionString);
      if (verdict.kind === 'squatter') {
        console.warn(
          `hosted state: left database ${candidate.id} on branch ${branchId} alone — it is named ` +
            `${STATE_DATABASE_NAME} but holds unrelated data (tables: ${verdict.tables.join(', ')}).`,
        );
        continue;
      }
      yield* deleteDatabase(client, candidate.id);
      console.error(`hosted state: removed state database ${candidate.id} from branch ${branchId}`);
    }
  });
