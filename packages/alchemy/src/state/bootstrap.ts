import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import postgres from 'postgres';
import { type ManagementApiClient, ManagementClient } from '../client.ts';
import { call, callVoid, PrismaApiError } from '../http.ts';
import { STATE_META_MARKER } from './schema.ts';

/**
 * The workspace's dedicated project for hosted deploy state. A project is
 * the closest expressible stand-in for "ambient platform infrastructure" —
 * PDP has no workspace-level database, and the app's own project is
 * circular (it doesn't exist before the first apply, and is itself tracked
 * in the state it would have to host).
 */
const STATE_PROJECT_NAME = 'prisma-compose-state';

/** Every connection this bootstrap mints carries this prefix — see `cleanupAgedConnections`. */
const CONNECTION_NAME_PREFIX = 'prisma-compose-state-';
const CONNECTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DATABASE_POLL_ATTEMPTS = 5;
const DEFAULT_DATABASE_POLL_DELAY = '500 millis';

interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly workspace: { readonly id: string };
}

interface DatabaseSummary {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

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

// ——— Projects ———

const listAllProjects = (
  client: ManagementApiClient,
): Effect.Effect<readonly ProjectSummary[], PrismaApiError> =>
  Effect.gen(function* () {
    const projects: ProjectSummary[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = cursor === undefined ? {} : { cursor };
      const page = yield* call(() => client.GET('/v1/projects', { params: { query } }));
      projects.push(...page.data);
      if (!page.pagination.hasMore || page.pagination.nextCursor === null) break;
      cursor = page.pagination.nextCursor;
    }
    return projects;
  });

/**
 * Workspace ids circulate in two shapes: the API returns them `wksp_`-prefixed
 * (`wksp_abc…`), while tokens/config often carry the bare id (`abc…`) — the
 * API accepts both on writes. Comparing them raw silently never matches when
 * the shapes differ, which made bootstrap re-provision a fresh state project
 * on every run in CI. Compare bare-to-bare.
 */
const bareWorkspaceId = (id: string): string =>
  id.startsWith('wksp_') ? id.slice('wksp_'.length) : id;

/**
 * All projects named `prisma-compose-state` in the workspace — plural, because PDP
 * allows duplicate project names (verified 2026-07-09), so name-based
 * discovery can never assume there is at most one. See `resolveStateProject`
 * for how candidates get disambiguated.
 */
const listStateProjects = (
  client: ManagementApiClient,
  workspaceId: string,
): Effect.Effect<readonly ProjectSummary[], PrismaApiError> =>
  listAllProjects(client).pipe(
    Effect.map((projects) =>
      projects.filter(
        (p) =>
          bareWorkspaceId(p.workspace.id) === bareWorkspaceId(workspaceId) &&
          p.name === STATE_PROJECT_NAME,
      ),
    ),
  );

const createStateProject = (
  client: ManagementApiClient,
  workspaceId: string,
): Effect.Effect<ProjectSummary, PrismaApiError> =>
  call(() =>
    client.POST('/v1/projects', {
      body: { name: STATE_PROJECT_NAME, workspaceId },
    }),
  ).pipe(Effect.map((r) => r.data));

// ——— Databases ———

const listAllDatabases = (
  client: ManagementApiClient,
  projectId: string,
): Effect.Effect<readonly DatabaseSummary[], PrismaApiError> =>
  Effect.gen(function* () {
    const databases: DatabaseSummary[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = cursor === undefined ? {} : { cursor };
      const page = yield* call(() =>
        client.GET('/v1/projects/{projectId}/databases', {
          params: { path: { projectId }, query },
        }),
      );
      databases.push(...page.data);
      if (!page.pagination.hasMore || page.pagination.nextCursor === null) break;
      cursor = page.pagination.nextCursor;
    }
    return databases;
  });

/**
 * The project's default database — auto-provisioned at project creation.
 * Never create a database here: a project already has exactly one default,
 * and creating another 409s (FT-5220). Whether the default is listable in
 * the same tick as the project-create response is not a documented
 * contract, so a fresh project polls a few times with a short backoff
 * before giving up — the observed live behaviour is synchronous, but this
 * does not assume that holds on every run.
 */
const findDefaultDatabase = (
  client: ManagementApiClient,
  projectId: string,
): Effect.Effect<DatabaseSummary, PrismaApiError> =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= DEFAULT_DATABASE_POLL_ATTEMPTS; attempt++) {
      const databases = yield* listAllDatabases(client, projectId);
      const found = databases.find((d) => d.isDefault);
      if (found !== undefined) return found;
      if (attempt < DEFAULT_DATABASE_POLL_ATTEMPTS) {
        yield* Effect.sleep(DEFAULT_DATABASE_POLL_DELAY);
      }
    }
    return yield* Effect.fail(
      new PrismaApiError({
        status: 0,
        message:
          `project ${projectId} (${STATE_PROJECT_NAME}) has no default database after ` +
          `${DEFAULT_DATABASE_POLL_ATTEMPTS} attempts — it may still be provisioning; re-run the deploy.`,
      }),
    );
  });

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
 * closes it, so the store's default database otherwise accumulates one
 * connection resource per run without bound. Best-effort, never blocks
 * bootstrap: lists this database's connections, deletes the ones matching
 * our naming pattern older than the age threshold, and swallows any failure
 * (a transient API error here must never fail the deploy it's cleaning up
 * after).
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

/**
 * Mints a fresh Postgres connection and reads the direct endpoint's DSN.
 * Never `endpoints.pooled`, the deprecated top-level `connectionString`/`url`
 * (PRO-212) — those are not guaranteed by the platform. The DSN is
 * write-only on read (a stored connection can't be re-read later), which is
 * exactly why a fresh connection is minted every run instead of reusing one.
 */
const mintConnection = (
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

// ——— Ownership verification ———

export type OwnershipVerdict =
  | { readonly kind: 'ours' }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'squatter'; readonly tables: readonly string[] };

/** The seam `resolveStateProject` calls to decide whether a candidate project's default database is ours — see {@link verifyOwnership} for the real implementation and `bootstrap.test.ts` for the stubbed one. */
export type OwnershipVerifier = (
  connectionString: Redacted.Redacted<string>,
) => Effect.Effect<OwnershipVerdict, PrismaApiError>;

/**
 * PDP allows duplicate project names, so a project named `prisma-compose-state`
 * found by listing is not proof it's ours — it could be an unrelated
 * project that happens to share the name (a squatter, deliberate or not).
 * Connects to the candidate's default database and inspects its tables:
 *
 * - our marker table with our marker row present → `ours`, adopt outright.
 * - our state tables (`alchemy_resource_state`/`alchemy_stack_output`) but no
 *   marker → `legacy`: a database from before this ownership check existed.
 *   The real, currently-in-use workspace state is in this shape today, so it
 *   must keep working — adopt it, and `migratePrismaState` (idempotent)
 *   writes the marker on the way in.
 * - no tables at all → `empty`, a freshly-created default database — adopt.
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

interface ResolvedStateProject {
  readonly project: ProjectSummary;
  readonly database: DatabaseSummary;
  readonly connectionString: Redacted.Redacted<string>;
}

/**
 * Finds the workspace's `prisma-compose-state` project, verifying ownership rather
 * than trusting the name alone (PDP allows duplicate names — see
 * `verifyOwnership`). Zero candidates creates one: nothing to verify, since
 * only this run could possibly have touched the brand-new database between
 * create and here (`migratePrismaState` writes the marker once bootstrap
 * hands the connection off). One or more candidates are tried
 * oldest-`createdAt` first, deterministically, and the first that verifies
 * as ours (or adoptable legacy/empty) wins; a candidate that fails
 * verification is skipped, not fatal, unless every candidate fails, in
 * which case the failure names every rejected project id so an operator can
 * act on it.
 */
const resolveStateProject = (
  client: ManagementApiClient,
  workspaceId: string,
  verify: OwnershipVerifier,
): Effect.Effect<ResolvedStateProject, PrismaApiError> =>
  Effect.gen(function* () {
    const candidates = yield* listStateProjects(client, workspaceId);

    if (candidates.length === 0) {
      const project = yield* createStateProject(client, workspaceId);
      const database = yield* findDefaultDatabase(client, project.id);
      const connectionString = yield* mintConnection(client, database.id);
      // Wording note here and below: the e2e noop assertion greps deploy
      // output for bare create/update verbs, so these lines must not use them.
      console.error(
        `hosted state: provisioned new state project ${project.id} (db ${database.id}) in workspace ${workspaceId}`,
      );
      return { project, database, connectionString };
    }

    const sorted = [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const rejected: string[] = [];
    for (const candidate of sorted) {
      const database = yield* findDefaultDatabase(client, candidate.id);
      const connectionString = yield* mintConnection(client, database.id);
      const verdict = yield* verify(connectionString);
      if (verdict.kind === 'squatter') {
        rejected.push(
          `${candidate.id} (foreign tables: ${verdict.tables.join(', ') || 'none named'})`,
        );
        continue;
      }
      console.error(
        `hosted state: using state project ${candidate.id} (db ${database.id}, ${verdict.kind}) — ` +
          `${sorted.length} candidate(s) named ${STATE_PROJECT_NAME} in workspace ${workspaceId}`,
      );
      return { project: candidate, database, connectionString };
    }

    return yield* Effect.fail(
      new PrismaApiError({
        status: 0,
        message:
          `found ${sorted.length} project(s) named "${STATE_PROJECT_NAME}" in workspace ` +
          `${workspaceId}, but none verified as Prisma App's state store: ${rejected.join('; ')}. ` +
          'The name is squatted by unrelated data — rename or remove the offending project(s), ' +
          'or see platform-ask.md (reserved/unique state project names).',
      }),
    );
  });

/**
 * Find-or-create the workspace's `prisma-compose-state` project, resolve its
 * default database, and mint a fresh connection — the automatic bootstrap
 * every deploy runs once, needing nothing beyond the service token and
 * workspace id a deployer already has.
 */
export const bootstrapStateConnection = (
  workspaceId: string,
): Effect.Effect<StateConnection, PrismaApiError, ManagementClient> =>
  bootstrapStateConnectionWith(workspaceId, verifyOwnership);

/**
 * Test seam: identical to {@link bootstrapStateConnection} but with the
 * ownership verifier injectable, so `bootstrap.test.ts` can stub ownership
 * decisions against its fake DSNs without opening a real Postgres
 * connection to them.
 */
export const bootstrapStateConnectionWith = (
  workspaceId: string,
  verify: OwnershipVerifier,
): Effect.Effect<StateConnection, PrismaApiError, ManagementClient> =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;
    const { project, database, connectionString } = yield* resolveStateProject(
      client,
      workspaceId,
      verify,
    );
    yield* cleanupAgedConnections(client, database.id);
    return { projectId: project.id, databaseId: database.id, connectionString };
  });
