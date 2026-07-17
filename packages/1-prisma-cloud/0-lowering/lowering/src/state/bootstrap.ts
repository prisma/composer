import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import postgres from 'postgres';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import { call, callVoid, PrismaApiError } from '../http.ts';
import {
  CONNECTION_NAME_PREFIX,
  type DatabaseSummary,
  listStateDatabaseCandidates,
  mintConnection,
  resolveBranchId,
  STATE_DATABASE_NAME,
  type StateTarget,
} from './discovery.ts';
import { STATE_META_MARKER } from './schema.ts';

const CONNECTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface ConnectionSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface StateConnection {
  readonly projectId: string;
  readonly databaseId: string;
  readonly connectionString: Redacted.Redacted<string>;
}

// ——— Databases ———

/**
 * Creates the state database on the stage's Branch, using the flat endpoint
 * because it is the only one that accepts a `branchId`. The platform still
 * creates the row on the project's default Branch and attaches it afterwards,
 * so a failed attach can leave a database behind on the default Branch. It
 * checks the Branch exists before creating, and this is one request instead of
 * two, so that window is much narrower than attaching from here — but it is
 * narrowed, not closed.
 *
 * `isDefault` is left at the API's `false` default: the state database must
 * never be the stage's default database, which belongs to the user.
 */
const createStateDatabase = (
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
): Effect.Effect<DatabaseSummary, PrismaApiError> =>
  call(() =>
    client.POST('/v1/databases', {
      body: { projectId, name: STATE_DATABASE_NAME, region: 'inherit', branchId },
    }),
  ).pipe(
    Effect.map((created) => ({
      id: created.data.id,
      name: created.data.name,
      isDefault: created.data.isDefault,
      createdAt: created.data.createdAt,
    })),
  );

// ——— Connections ———

const listAllConnections = (
  client: ManagementApiClient,
  databaseId: string,
): Effect.Effect<readonly ConnectionSummary[], PrismaApiError> =>
  Effect.gen(function* () {
    const connections: ConnectionSummary[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = cursor === undefined ? {} : { cursor };
      const page = yield* call(() =>
        client.GET('/v1/databases/{databaseId}/connections', {
          params: { path: { databaseId }, query },
        }),
      );
      connections.push(...page.data);
      if (!page.pagination.hasMore || page.pagination.nextCursor === null) break;
      cursor = page.pagination.nextCursor;
    }
    return connections;
  });

const deleteConnection = (
  client: ManagementApiClient,
  connectionId: string,
): Effect.Effect<void, PrismaApiError> =>
  callVoid(() => client.DELETE('/v1/connections/{id}', { params: { path: { id: connectionId } } }));

/**
 * Every deploy mints a fresh connection (`mintConnection`) and nothing ever
 * closes it, so the state database otherwise accumulates one connection
 * resource per run without bound. Best-effort, never blocks bootstrap: lists
 * this database's connections, deletes the ones matching our naming pattern
 * older than the age threshold, and swallows any failure (a transient API
 * error here must never fail the deploy it's cleaning up after).
 */
const cleanupAgedConnections = (
  client: ManagementApiClient,
  databaseId: string,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const connections = yield* listAllConnections(client, databaseId);
    const cutoff = Date.now() - CONNECTION_MAX_AGE_MS;
    const aged = connections.filter(
      (c) => c.name.startsWith(CONNECTION_NAME_PREFIX) && Date.parse(c.createdAt) < cutoff,
    );
    yield* Effect.forEach(aged, (c) => deleteConnection(client, c.id), { discard: true });
  }).pipe(Effect.ignore);

// ——— Ownership verification ———

export type OwnershipVerdict =
  | { readonly kind: 'ours' }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'squatter'; readonly tables: readonly string[] };

/** Decides whether a candidate database is ours. {@link verifyOwnership} is the real implementation; the tests pass a stub instead. */
export type OwnershipVerifier = (
  connectionString: Redacted.Redacted<string>,
) => Effect.Effect<OwnershipVerdict, PrismaApiError>;

/**
 * PDP allows duplicate database names, so a database named `prisma-composer-state`
 * found by listing is not proof it's ours — it could be an unrelated
 * database that happens to share the name (a squatter, deliberate or not).
 * Connects to the candidate and inspects its tables:
 *
 * - our marker table with our marker row present → `ours`, adopt outright.
 * - our state tables (`alchemy_resource_state`/`alchemy_stack_output`) but no
 *   marker → `legacy`: a database from before this ownership check existed.
 *   The real, currently-in-use workspace state is in this shape today, so it
 *   must keep working — adopt it, and `migratePrismaState` (idempotent)
 *   writes the marker on the way in.
 * - no tables at all → `empty`, a freshly-created database — adopt.
 * - anything else → `squatter`: foreign data occupies the name; refuse it.
 */
export const verifyOwnership: OwnershipVerifier = (connectionString) =>
  Effect.tryPromise({
    try: async () => {
      const sql = postgres(Redacted.value(connectionString), { max: 1, onnotice: () => {} });
      try {
        const rows = await sql<{ tablename: string }[]>`
          select tablename from pg_tables where schemaname = 'public'
        `;
        const tables = new Set(rows.map((row) => row.tablename));

        if (tables.has('prisma_app_state_meta')) {
          const marker = await sql<{ marker: string }[]>`
            select marker from prisma_app_state_meta where marker = ${STATE_META_MARKER}
          `;
          return marker.length > 0
            ? ({ kind: 'ours' } as const)
            : ({ kind: 'squatter', tables: [...tables] } as const);
        }
        if (tables.has('alchemy_resource_state') || tables.has('alchemy_stack_output')) {
          return { kind: 'legacy' } as const;
        }
        return tables.size === 0
          ? ({ kind: 'empty' } as const)
          : ({ kind: 'squatter', tables: [...tables] } as const);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
    catch: (cause) =>
      new PrismaApiError({
        status: 0,
        message: `ownership verification failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

// ——— Orchestration ———

interface ResolvedStateDatabase {
  readonly database: DatabaseSummary;
  readonly connectionString: Redacted.Redacted<string>;
}

/**
 * Finds the Branch's `prisma-composer-state` database, verifying ownership
 * rather than trusting the name alone (PDP allows duplicate names — see
 * `verifyOwnership`). Finding none creates one, with nothing to verify: only
 * this run can have touched a database it just created.
 *
 * Candidates are tried oldest first, so repeated runs pick the same one. The
 * first that verifies as ours is used. A candidate that fails verification is
 * skipped. If every candidate fails, bootstrap fails and names each rejected
 * database id, so an operator knows which to rename or remove.
 */
const resolveStateDatabase = (
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
  verify: OwnershipVerifier,
): Effect.Effect<ResolvedStateDatabase, PrismaApiError> =>
  Effect.gen(function* () {
    const candidates = yield* listStateDatabaseCandidates(client, projectId, branchId);

    if (candidates.length === 0) {
      const database = yield* createStateDatabase(client, projectId, branchId);
      const connectionString = yield* mintConnection(client, database.id);
      console.error(
        `hosted state: provisioned state database ${database.id} on branch ${branchId} (project ${projectId})`,
      );
      return { database, connectionString };
    }

    const rejected: string[] = [];
    for (const candidate of candidates) {
      const connectionString = yield* mintConnection(client, candidate.id);
      const verdict = yield* verify(connectionString);
      if (verdict.kind === 'squatter') {
        rejected.push(`${candidate.id} (foreign tables: ${verdict.tables.join(', ')})`);
        continue;
      }
      console.error(
        `hosted state: using state database ${candidate.id} on branch ${branchId} (${verdict.kind}) — ` +
          `${candidates.length} candidate(s) named ${STATE_DATABASE_NAME}`,
      );
      return { database: candidate, connectionString };
    }

    return yield* Effect.fail(
      new PrismaApiError({
        status: 0,
        message:
          `found ${candidates.length} database(s) named "${STATE_DATABASE_NAME}" on branch ${branchId}, ` +
          `but none verified as Composer's state store: ${rejected.join('; ')}. ` +
          'Rename or remove the offending database(s).',
      }),
    );
  });

/**
 * Resolves the stage's Branch, find-or-creates its `prisma-composer-state`
 * database, and mints a fresh connection — the automatic bootstrap every
 * deploy runs once, needing nothing beyond the service token and the
 * Project/Branch ids the CLI already resolved.
 */
export const bootstrapStateConnection = (
  target: StateTarget,
): Effect.Effect<StateConnection, PrismaApiError, ManagementClient> =>
  bootstrapStateConnectionWith(target, verifyOwnership);

/**
 * Test seam: identical to {@link bootstrapStateConnection} but with the
 * ownership verifier injectable, so `bootstrap.test.ts` can stub ownership
 * decisions against its fake DSNs without opening a real Postgres
 * connection to them.
 */
export const bootstrapStateConnectionWith = (
  target: StateTarget,
  verify: OwnershipVerifier,
): Effect.Effect<StateConnection, PrismaApiError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    const branchId = yield* resolveBranchId(client, target);
    const { database, connectionString } = yield* resolveStateDatabase(
      client,
      target.projectId,
      branchId,
      verify,
    );
    yield* cleanupAgedConnections(client, database.id);
    return { projectId: target.projectId, databaseId: database.id, connectionString };
  });
