import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import type { ManagementApiClient } from '../client.ts';
import type { ResolvedContainer } from '../container.ts';
import { call, PrismaApiError } from '../http.ts';

/** The framework-owned database a stage's deploy state lives in — a child of that stage's Branch (ADR-0034). */
export const STATE_DATABASE_NAME = 'prisma-composer-state';

/** Every connection created against a state database carries this prefix — see `cleanupAgedConnections`. */
export const CONNECTION_NAME_PREFIX = 'prisma-composer-state-';

interface BranchSummary {
  readonly id: string;
  readonly isDefault: boolean;
}

export interface DatabaseSummary {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
}

const listAllBranches = (
  client: ManagementApiClient,
  projectId: string,
): Effect.Effect<readonly BranchSummary[], PrismaApiError> =>
  Effect.gen(function* () {
    const branches: BranchSummary[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = cursor === undefined ? {} : { cursor };
      const page = yield* call(() =>
        client.GET('/v1/projects/{projectId}/branches', {
          params: { path: { projectId }, query },
        }),
      );
      branches.push(...page.data);
      if (!page.pagination.hasMore || page.pagination.nextCursor === null) break;
      cursor = page.pagination.nextCursor;
    }
    return branches;
  });

/**
 * The project's implicit default Branch — every live Project owns exactly
 * one (a platform invariant). The list endpoint has no `isDefault` filter, so
 * this pages through every Branch and picks it out client-side. Never creates
 * one: its absence means the platform's invariant is broken, which is not
 * something a deploy can repair.
 */
const resolveDefaultBranchId = (
  client: ManagementApiClient,
  projectId: string,
): Effect.Effect<string, PrismaApiError> =>
  Effect.gen(function* () {
    const branches = yield* listAllBranches(client, projectId);
    const found = branches.find((b) => b.isDefault);
    if (found !== undefined) return found.id;
    return yield* Effect.fail(
      new PrismaApiError({
        status: 0,
        message: `project ${projectId} has no default Branch — the platform guarantees every live Project owns one; contact support.`,
      }),
    );
  });

/** A named stage carries its `branchId`; production omits it, and its state lives on the Project's default Branch. */
export const resolveBranchId = (
  client: ManagementApiClient,
  container: ResolvedContainer,
): Effect.Effect<string, PrismaApiError> =>
  container.branchId !== undefined
    ? Effect.succeed(container.branchId)
    : resolveDefaultBranchId(client, container.projectId);

/**
 * Every database on this Branch. Uses the flat `GET /v1/databases`, which
 * accepts `projectId` and `branchId` together — the project-scoped listing
 * has no branch filter at all.
 */
const listAllDatabasesOnBranch = (
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
): Effect.Effect<readonly DatabaseSummary[], PrismaApiError> =>
  Effect.gen(function* () {
    const databases: DatabaseSummary[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query =
        cursor === undefined ? { projectId, branchId } : { projectId, branchId, cursor };
      const page = yield* call(() => client.GET('/v1/databases', { params: { query } }));
      databases.push(...page.data);
      if (!page.pagination.hasMore || page.pagination.nextCursor === null) break;
      cursor = page.pagination.nextCursor;
    }
    return databases;
  });

/**
 * Databases on this Branch named `prisma-composer-state`, oldest first,
 * excluding the Branch's own default database. The default database is always
 * the user's, never ours to adopt or delete. A name match alone proves
 * nothing — the platform allows duplicate names — so every caller must still
 * verify ownership before acting on a candidate.
 */
export const listStateDatabaseCandidates = (
  client: ManagementApiClient,
  projectId: string,
  branchId: string,
): Effect.Effect<readonly DatabaseSummary[], PrismaApiError> =>
  listAllDatabasesOnBranch(client, projectId, branchId).pipe(
    Effect.map((databases) =>
      databases
        .filter((d) => d.name === STATE_DATABASE_NAME && !d.isDefault)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ),
  );

/**
 * Creates a fresh Postgres connection and reads its connection string. Reads
 * `endpoints.direct.connectionString` only — never `endpoints.pooled`, and
 * never the deprecated top-level `connectionString`/`url` (PRO-212), neither
 * of which the platform guarantees.
 *
 * The connection string is returned only when the connection is created and
 * cannot be read back afterwards, which is why every run creates a fresh
 * connection instead of reusing one.
 */
export const createConnection = (
  client: ManagementApiClient,
  databaseId: string,
): Effect.Effect<Redacted.Redacted<string>, PrismaApiError> =>
  call(() =>
    client.POST('/v1/databases/{databaseId}/connections', {
      params: { path: { databaseId } },
      body: { name: `${CONNECTION_NAME_PREFIX}${Date.now()}` },
    }),
  ).pipe(
    Effect.flatMap((r) => {
      const created = r.data;
      const dsn = created.endpoints.direct?.connectionString;
      return dsn === undefined
        ? Effect.fail(
            new PrismaApiError({
              status: 0,
              message: `connection ${created.id} returned no endpoints.direct.connectionString (PRO-212)`,
            }),
          )
        : Effect.succeed(Redacted.make(dsn));
    }),
  );
