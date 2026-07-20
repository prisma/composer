import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { ManagementApiClient } from '@internal/lowering';
import type { OwnershipVerifier } from '@internal/lowering/state';
import * as Effect from 'effect/Effect';
import { PrismaCloudContainer } from '../container.ts';
import { runTeardown } from '../teardown.ts';

/** Every candidate verifies as ours — the real verifier would open a Postgres connection. */
const ours: OwnershipVerifier = () => Effect.succeed({ kind: 'ours' });

/** A resolved container matching `input.container` after the boundary move — teardown narrows it with `prismaCloudContainerOf`. */
const fakeContainer = (projectId: string, branchId: string | undefined) =>
  new PrismaCloudContainer({ appName: 'app', stage: undefined }, projectId, branchId);

interface FakeDatabase {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  branchId: string | null;
}

interface FakeState {
  branches: { id: string; isDefault: boolean }[];
  databases: FakeDatabase[];
  deletedDatabaseIds: string[];
  /** Overrides the database DELETE status — defaults to a 204 success. */
  deleteStatus: number;
}

const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  branches: [{ id: 'br-default', isDefault: true }],
  databases: [],
  deletedDatabaseIds: [],
  deleteStatus: 204,
  ...overrides,
});

const ok = <T>(data: T, status = 200) => ({
  data,
  error: undefined,
  response: new Response(null, { status }),
});

/**
 * A stubbed Management API client — test file, exempt from the no-bare-cast
 * rule. Answers only the paths teardown's discovery walks: the project's
 * branches, the flat database listing, connection creation, and the database
 * delete.
 */
const fakeClient = (state: FakeState): ManagementApiClient =>
  ({
    GET: async (path: string, init: { params?: { query?: Record<string, string> } }) => {
      if (path === '/v1/projects/{projectId}/branches') {
        return ok({ data: state.branches, pagination: { nextCursor: null, hasMore: false } });
      }
      if (path === '/v1/databases') {
        const branchId = init.params?.query?.['branchId'];
        return ok({
          data: state.databases.filter((d) => d.branchId === branchId),
          pagination: { nextCursor: null, hasMore: false },
        });
      }
      throw new Error(`fakeClient: unexpected GET ${path}`);
    },
    POST: async (path: string, init: { params?: { path?: Record<string, string> } }) => {
      if (path === '/v1/databases/{databaseId}/connections') {
        const databaseId = init.params?.path?.['databaseId'] ?? '';
        return ok({
          data: {
            id: `conn-${databaseId}`,
            endpoints: { direct: { connectionString: `postgres://fake/${databaseId}` } },
          },
        });
      }
      throw new Error(`fakeClient: unexpected POST ${path}`);
    },
    DELETE: async (path: string, init: { params?: { path?: Record<string, string> } }) => {
      if (path === '/v1/databases/{databaseId}') {
        const databaseId = init.params?.path?.['databaseId'] ?? '';
        if (state.deleteStatus !== 204) {
          return {
            data: undefined,
            error: { code: 'conflict', message: 'refused' },
            response: new Response(null, { status: state.deleteStatus }),
          };
        }
        state.deletedDatabaseIds.push(databaseId);
        return ok(undefined, 204);
      }
      throw new Error(`fakeClient: unexpected DELETE ${path}`);
    },
  }) as unknown as ManagementApiClient;

const stateDatabase = (id: string, branchId: string): FakeDatabase => ({
  id,
  name: 'prisma-composer-state',
  isDefault: false,
  createdAt: new Date(1).toISOString(),
  branchId,
});

describe('runTeardown', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  test('a named stage removes the state database on its own branch', async () => {
    state.databases.push(stateDatabase('db-stage', 'br-stage'));

    await runTeardown(
      { container: fakeContainer('proj-1', 'br-stage'), stage: 'staging' },
      { client: fakeClient(state), verify: ours },
    );

    expect(state.deletedDatabaseIds).toEqual(['db-stage']);
  });

  test('production removes the state database on the default branch', async () => {
    state.databases.push(stateDatabase('db-prod', 'br-default'));

    await runTeardown(
      { container: fakeContainer('proj-1', undefined), stage: undefined },
      { client: fakeClient(state), verify: ours },
    );

    expect(state.deletedDatabaseIds).toEqual(['db-prod']);
  });

  test('a named stage whose state database cannot be removed fails, naming the cause', async () => {
    state.databases.push(stateDatabase('db-stage', 'br-stage'));
    state.deleteStatus = 409;

    await expect(
      runTeardown(
        { container: fakeContainer('proj-1', 'br-stage'), stage: 'staging' },
        { client: fakeClient(state), verify: ours },
      ),
    ).rejects.toThrow(/deploy-state database/);
  });

  test('production whose state database cannot be removed warns and does not fail the command', async () => {
    state.databases.push(stateDatabase('db-prod', 'br-default'));
    state.deleteStatus = 409;
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        runTeardown(
          { container: fakeContainer('proj-1', undefined), stage: undefined },
          { client: fakeClient(state), verify: ours },
        ),
      ).resolves.toBeUndefined();

      expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/deploy-state database/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('finding no state database succeeds, so a repeated destroy is a no-op', async () => {
    await runTeardown(
      { container: fakeContainer('proj-1', 'br-stage'), stage: 'staging' },
      { client: fakeClient(state), verify: ours },
    );

    expect(state.deletedDatabaseIds).toEqual([]);
  });
});
