import { beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { ManagementClient } from '../../client.ts';
import type { ResolvedContainer } from '../../container.ts';
import {
  bootstrapStateConnection,
  bootstrapStateConnectionWith,
  type OwnershipVerifier,
} from '../bootstrap.ts';
import {
  DEFAULT_BRANCH_ID,
  type FakeState,
  fakeClient,
  newFakeState,
  PROJECT_ID,
  stateDatabase,
  verifierFor,
  withDefaultBranch,
} from './fake-management-api.ts';

const neverCalled = (): OwnershipVerifier => () => {
  throw new Error('verifyOwnership must not be called on the create path — nothing to verify yet');
};

const run = (
  state: FakeState,
  verify: OwnershipVerifier,
  container: ResolvedContainer = { projectId: PROJECT_ID },
) =>
  Effect.runPromise(
    bootstrapStateConnectionWith(container, verify).pipe(
      Effect.provideService(ManagementClient, fakeClient(state)),
    ),
  );

describe('bootstrapStateConnection', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  test('production, with no branch given, uses the project’s default branch', async () => {
    withDefaultBranch(state);

    await run(state, neverCalled());

    expect(state.branchListCalls).toBe(1);
    expect(state.databases[0]?.branchId).toBe(DEFAULT_BRANCH_ID);
  });

  test('a named stage uses the branch it was given, without looking any up', async () => {
    state.databases.push(stateDatabase('db-existing', 'br-named'));

    const result = await run(state, verifierFor({ 'db-existing': { kind: 'ours' } }), {
      projectId: PROJECT_ID,
      branchId: 'br-named',
    });

    expect(state.branchListCalls).toBe(0);
    expect(result.databaseId).toBe('db-existing');
  });

  test('a project with no default branch fails, naming the project, and creates nothing', async () => {
    state.branches[PROJECT_ID] = [];

    await expect(run(state, neverCalled())).rejects.toThrow(
      new RegExp(`${PROJECT_ID}.*no default Branch`),
    );
    expect(state.databaseCreateCalls).toBe(0);
  });

  test('with no state database present, one is made on the stage’s branch and its ownership is never questioned', async () => {
    withDefaultBranch(state);

    const result = await run(state, neverCalled());

    expect(result.databaseId).toBe('db-1');
    expect(state.databaseCreateCalls).toBe(1);
    expect(state.databases[0]?.name).toBe('prisma-composer-state');
  });

  test('the branch’s own default database is left alone even when it shares our name', async () => {
    withDefaultBranch(state);
    state.databases.push({
      id: 'db-users-default',
      name: 'prisma-composer-state',
      isDefault: true,
      createdAt: new Date(1).toISOString(),
      branchId: DEFAULT_BRANCH_ID,
      projectId: PROJECT_ID,
    });

    const result = await run(state, neverCalled());

    expect(result.databaseId).not.toBe('db-users-default');
    expect(state.databaseCreateCalls).toBe(1);
  });

  test('a database carrying our marker is adopted', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-existing'));

    const result = await run(state, verifierFor({ 'db-existing': { kind: 'ours' } }));

    expect(result.databaseId).toBe('db-existing');
    expect(state.databaseCreateCalls).toBe(0);
  });

  test('a database holding our tables but no marker yet is adopted', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-legacy'));

    const result = await run(state, verifierFor({ 'db-legacy': { kind: 'legacy' } }));

    expect(result.databaseId).toBe('db-legacy');
    expect(state.databaseCreateCalls).toBe(0);
  });

  test('an empty database, left by a run that died before migrating, is adopted', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-empty'));

    const result = await run(state, verifierFor({ 'db-empty': { kind: 'empty' } }));

    expect(result.databaseId).toBe('db-empty');
    expect(state.databaseCreateCalls).toBe(0);
  });

  test('a database holding someone else’s data fails the deploy, naming it, and no second one is made beside it', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-squatter'));

    await expect(
      run(state, verifierFor({ 'db-squatter': { kind: 'squatter', tables: ['users', 'orders'] } })),
    ).rejects.toThrow(/db-squatter/);
    expect(state.databaseCreateCalls).toBe(0);
  });

  test('candidates are tried oldest first, stopping at the first that proves ours', async () => {
    withDefaultBranch(state);
    state.databases.push(
      stateDatabase('db-newest', DEFAULT_BRANCH_ID, 3),
      stateDatabase('db-oldest-squatter', DEFAULT_BRANCH_ID, 1),
      stateDatabase('db-middle-ours', DEFAULT_BRANCH_ID, 2),
    );

    const calls: string[] = [];
    const result = await run(
      state,
      verifierFor(
        {
          'db-oldest-squatter': { kind: 'squatter', tables: ['users'] },
          'db-middle-ours': { kind: 'ours' },
          // 'db-newest' deliberately unstubbed: the loop must never reach it.
        },
        calls,
      ),
    );

    expect(result.databaseId).toBe('db-middle-ours');
    expect(calls).toEqual(['postgres://fake/db-oldest-squatter', 'postgres://fake/db-middle-ours']);
  });

  test('a failure creating the database surfaces rather than being swallowed', async () => {
    withDefaultBranch(state);
    state.createShouldFail = true;

    await expect(run(state, neverCalled())).rejects.toThrow();
  });

  test('the connection string comes from the direct endpoint', async () => {
    withDefaultBranch(state);

    const result = await run(state, neverCalled());

    expect(Redacted.value(result.connectionString)).toBe(`postgres://fake/${result.databaseId}`);
    expect(state.connectionCalls).toEqual([result.databaseId]);
  });

  test('our own connections older than 24h are cleaned up; fresh and foreign ones are left', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-existing'));

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    state.connections['db-existing'] = [
      {
        id: 'conn-aged',
        name: 'prisma-composer-state-1',
        createdAt: new Date(now - 2 * dayMs).toISOString(),
      },
      { id: 'conn-fresh', name: 'prisma-composer-state-2', createdAt: new Date(now).toISOString() },
      {
        id: 'conn-foreign',
        name: 'someone-elses-connection',
        createdAt: new Date(now - 2 * dayMs).toISOString(),
      },
    ];

    await run(state, verifierFor({ 'db-existing': { kind: 'ours' } }));

    expect(state.deletedConnectionIds).toEqual(['conn-aged']);
  });

  test('a connection cleanup that finds nothing still lets the deploy through', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-existing'));
    const result = await run(state, verifierFor({ 'db-existing': { kind: 'ours' } }));

    expect(result.databaseId).toBe('db-existing');
  });
});

describe('bootstrapStateConnection (public entry point)', () => {
  test('wires the real verifyOwnership — typechecked here, not run (that would touch a real Postgres)', () => {
    const typed: (container: ResolvedContainer) => ReturnType<typeof bootstrapStateConnection> =
      bootstrapStateConnection;
    expect(typed).toBe(bootstrapStateConnection);
  });
});
