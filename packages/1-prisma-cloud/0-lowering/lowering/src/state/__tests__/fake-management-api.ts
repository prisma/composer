import { blindCast } from '@internal/foundation/casts';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import type { ManagementApiClient } from '../../client.ts';
import type { OwnershipVerdict, OwnershipVerifier } from '../bootstrap.ts';

export interface FakeBranch {
  id: string;
  isDefault: boolean;
}

export interface FakeDatabase {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  branchId: string | null;
  projectId: string;
}

export interface FakeConnection {
  id: string;
  name: string;
  createdAt: string;
}

export interface FakeState {
  branches: Record<string, FakeBranch[]>;
  databases: FakeDatabase[];
  connections: Record<string, FakeConnection[]>;
  createShouldFail: boolean;
  deleteShouldFailWith: number | undefined;
  branchListCalls: number;
  databaseCreateCalls: number;
  connectionCalls: string[];
  deletedDatabaseIds: string[];
  deletedConnectionIds: string[];
}

export const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  branches: {},
  databases: [],
  connections: {},
  createShouldFail: false,
  deleteShouldFailWith: undefined,
  branchListCalls: 0,
  databaseCreateCalls: 0,
  connectionCalls: [],
  deletedDatabaseIds: [],
  deletedConnectionIds: [],
  ...overrides,
});

const okResponse = <T>(data: T, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});

const errorResponse = (status: number) => ({
  data: undefined,
  error: { message: 'stubbed failure' },
  response: new Response(null, { status }),
});

type FakeInit = {
  params?: { path?: Record<string, string>; query?: Record<string, string> };
  body?: Record<string, unknown>;
};

/**
 * A stubbed `ManagementApiClient` — just enough of the Management API to
 * exercise branch resolution, state-database discovery, creation, deletion,
 * and connection handling without touching the cloud.
 *
 * The project-scoped create and any PATCH throw instead of answering, so
 * attaching the database with a second call from our side fails loudly here.
 *
 * The flat create is modelled as a single step that lands the database on the
 * given Branch. The real platform creates the row on the default Branch and
 * attaches it afterwards, so no test here can reach the failed-attach outcome —
 * that risk is accepted, not impossible.
 */
export const fakeClient = (state: FakeState): ManagementApiClient => {
  const GET = (path: string, init: FakeInit = {}) => {
    if (path === '/v1/projects/{projectId}/branches') {
      const projectId = init.params?.path?.['projectId'] ?? '';
      state.branchListCalls++;
      return Promise.resolve(
        okResponse({
          data: state.branches[projectId] ?? [],
          pagination: { nextCursor: null, hasMore: false },
        }),
      );
    }
    if (path === '/v1/databases') {
      const query = init.params?.query ?? {};
      const filtered = state.databases.filter(
        (d) =>
          d.branchId === (query['branchId'] ?? null) &&
          (query['projectId'] === undefined || d.projectId === query['projectId']),
      );
      return Promise.resolve(
        okResponse({ data: filtered, pagination: { nextCursor: null, hasMore: false } }),
      );
    }
    if (path === '/v1/databases/{databaseId}/connections') {
      const databaseId = init.params?.path?.['databaseId'] ?? '';
      return Promise.resolve(
        okResponse({
          data: state.connections[databaseId] ?? [],
          pagination: { nextCursor: null, hasMore: false },
        }),
      );
    }
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };

  const POST = (path: string, init: FakeInit = {}) => {
    if (path === '/v1/databases') {
      state.databaseCreateCalls++;
      if (state.createShouldFail) return Promise.resolve(errorResponse(409));
      const id = `db-${state.databaseCreateCalls}`;
      const branchId = init.body?.['branchId'];
      if (typeof branchId !== 'string') {
        throw new Error('fakeClient: a state database must be created with a branchId');
      }
      const database: FakeDatabase = {
        id,
        name: String(init.body?.['name']),
        isDefault: false,
        createdAt: new Date(state.databaseCreateCalls).toISOString(),
        branchId,
        projectId: String(init.body?.['projectId']),
      };
      state.databases.push(database);
      return Promise.resolve(okResponse({ data: database }, 201));
    }
    if (path === '/v1/projects/{projectId}/databases') {
      throw new Error(
        'fakeClient: the state database must be created via POST /v1/databases with a branchId — ' +
          'the project-scoped endpoint has no branchId field, so the database would be born on ' +
          "the default Branch (production's) and only move afterwards.",
      );
    }
    if (path === '/v1/databases/{databaseId}/connections') {
      const databaseId = init.params?.path?.['databaseId'] ?? '';
      state.connectionCalls.push(databaseId);
      return Promise.resolve(
        okResponse({
          data: {
            id: `conn-${databaseId}-${state.connectionCalls.length}`,
            endpoints: {
              direct: {
                host: 'fake',
                port: 5432,
                connectionString: `postgres://fake/${databaseId}`,
              },
            },
          },
        }),
      );
    }
    throw new Error(`fakeClient: unexpected POST ${path}`);
  };

  const PATCH = (path: string) => {
    if (path === '/v1/databases/{databaseId}') {
      throw new Error(
        'fakeClient: a state database must be attached to its Branch at creation, never moved ' +
          'onto it by a follow-up PATCH.',
      );
    }
    throw new Error(`fakeClient: unexpected PATCH ${path}`);
  };

  const DELETE = (path: string, init: FakeInit = {}) => {
    if (path === '/v1/databases/{databaseId}') {
      const databaseId = init.params?.path?.['databaseId'] ?? '';
      if (state.deleteShouldFailWith !== undefined) {
        return Promise.resolve(errorResponse(state.deleteShouldFailWith));
      }
      state.deletedDatabaseIds.push(databaseId);
      state.databases = state.databases.filter((d) => d.id !== databaseId);
      return Promise.resolve(okResponse(undefined, 204));
    }
    if (path === '/v1/connections/{id}') {
      const id = init.params?.path?.['id'] ?? '';
      state.deletedConnectionIds.push(id);
      for (const databaseId of Object.keys(state.connections)) {
        const list = state.connections[databaseId];
        if (list === undefined) continue;
        state.connections[databaseId] = list.filter((c) => c.id !== id);
      }
      return Promise.resolve(okResponse(undefined, 204));
    }
    throw new Error(`fakeClient: unexpected DELETE ${path}`);
  };

  return blindCast<
    ManagementApiClient,
    'a hand-written fake of openapi-fetch’s generated client: its four methods answer only the paths these suites exercise, and reproducing the real generic signature would add no safety the per-path handlers above do not already give'
  >({ GET, POST, PATCH, DELETE });
};

/** A verifier stub that maps each fake database id to a canned verdict, and fails the test if asked about one it wasn't told to expect. */
export const verifierFor = (
  verdicts: Record<string, OwnershipVerdict>,
  calls: string[] = [],
): OwnershipVerifier => {
  return (connectionString) => {
    const dsn = Redacted.value(connectionString);
    calls.push(dsn);
    const databaseId = dsn.replace('postgres://fake/', '');
    const verdict = verdicts[databaseId];
    if (verdict === undefined) throw new Error(`verifierFor: no verdict stubbed for ${databaseId}`);
    return Effect.succeed(verdict);
  };
};

export const PROJECT_ID = 'proj-1';
export const DEFAULT_BRANCH_ID = 'br-default';

/** Registers the default Branch every live Project is guaranteed to own. Its absence is its own test scenario. */
export const withDefaultBranch = (state: FakeState): void => {
  state.branches[PROJECT_ID] = [{ id: DEFAULT_BRANCH_ID, isDefault: true }];
};

/** A state database on the given branch, named ours and non-default — a candidate for adoption or deletion. */
export const stateDatabase = (
  id: string,
  branchId: string = DEFAULT_BRANCH_ID,
  createdAtMs = 1,
): FakeDatabase => ({
  id,
  name: 'prisma-composer-state',
  isDefault: false,
  createdAt: new Date(createdAtMs).toISOString(),
  branchId,
  projectId: PROJECT_ID,
});
