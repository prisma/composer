import { beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import { ManagementClient } from '../../client.ts';
import type { OwnershipVerifier } from '../bootstrap.ts';
import { deleteStateDatabase, deleteStateDatabaseWith } from '../delete.ts';
import type { StateTarget } from '../discovery.ts';
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
  throw new Error('verifyOwnership must be consulted before any database is deleted');
};

const run = (
  state: FakeState,
  verify: OwnershipVerifier,
  target: StateTarget = { projectId: PROJECT_ID },
) =>
  Effect.runPromise(
    deleteStateDatabaseWith(target, verify).pipe(
      Effect.provideService(ManagementClient, fakeClient(state)),
    ),
  );

describe('deleteStateDatabase', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  test('production, with no branch given, looks on the project’s default branch', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-prod'));

    await run(state, verifierFor({ 'db-prod': { kind: 'ours' } }));

    expect(state.branchListCalls).toBe(1);
    expect(state.deletedDatabaseIds).toEqual(['db-prod']);
  });

  test('a named stage looks on the branch it was given, without looking any up', async () => {
    state.databases.push(stateDatabase('db-stage', 'br-named'));

    await run(state, verifierFor({ 'db-stage': { kind: 'ours' } }), {
      projectId: PROJECT_ID,
      branchId: 'br-named',
    });

    expect(state.branchListCalls).toBe(0);
    expect(state.deletedDatabaseIds).toEqual(['db-stage']);
  });

  test('finding no state database succeeds, so a repeated destroy is a no-op', async () => {
    withDefaultBranch(state);

    await run(state, neverCalled());

    expect(state.deletedDatabaseIds).toEqual([]);
  });

  test('a database carrying our marker is deleted', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-ours'));

    await run(state, verifierFor({ 'db-ours': { kind: 'ours' } }));

    expect(state.deletedDatabaseIds).toEqual(['db-ours']);
  });

  test('a database holding our tables but no marker yet is deleted', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-legacy'));

    await run(state, verifierFor({ 'db-legacy': { kind: 'legacy' } }));

    expect(state.deletedDatabaseIds).toEqual(['db-legacy']);
  });

  test('an empty database, left by a run that died before migrating, is deleted', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-empty'));

    await run(state, verifierFor({ 'db-empty': { kind: 'empty' } }));

    expect(state.deletedDatabaseIds).toEqual(['db-empty']);
  });

  test('a database holding someone else’s data is left alone, and the destroy still succeeds', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-squatter'));

    await run(state, verifierFor({ 'db-squatter': { kind: 'squatter', tables: ['users'] } }));

    expect(state.deletedDatabaseIds).toEqual([]);
  });

  test('the branch’s own default database is never deleted, even when it shares our name', async () => {
    withDefaultBranch(state);
    state.databases.push({
      id: 'db-users-default',
      name: 'prisma-composer-state',
      isDefault: true,
      createdAt: new Date(1).toISOString(),
      branchId: DEFAULT_BRANCH_ID,
      projectId: PROJECT_ID,
    });

    await run(state, neverCalled());

    expect(state.deletedDatabaseIds).toEqual([]);
  });

  test('every database we own is deleted, so duplicates left by a crashed run all go', async () => {
    withDefaultBranch(state);
    state.databases.push(
      stateDatabase('db-first', DEFAULT_BRANCH_ID, 1),
      stateDatabase('db-second', DEFAULT_BRANCH_ID, 2),
    );

    await run(state, verifierFor({ 'db-first': { kind: 'ours' }, 'db-second': { kind: 'empty' } }));

    expect(state.deletedDatabaseIds).toEqual(['db-first', 'db-second']);
  });

  test('someone else’s database does not stop ours from being deleted', async () => {
    withDefaultBranch(state);
    state.databases.push(
      stateDatabase('db-squatter', DEFAULT_BRANCH_ID, 1),
      stateDatabase('db-ours', DEFAULT_BRANCH_ID, 2),
    );

    await run(
      state,
      verifierFor({
        'db-squatter': { kind: 'squatter', tables: ['users'] },
        'db-ours': { kind: 'ours' },
      }),
    );

    expect(state.deletedDatabaseIds).toEqual(['db-ours']);
  });

  test('a database already gone counts as deleted, so a retried destroy still completes', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-ours'));
    state.deleteShouldFailWith = 404;

    await expect(run(state, verifierFor({ 'db-ours': { kind: 'ours' } }))).resolves.toBeUndefined();
  });

  test('a deletion the platform refuses fails the destroy', async () => {
    withDefaultBranch(state);
    state.databases.push(stateDatabase('db-ours'));
    state.deleteShouldFailWith = 409;

    await expect(run(state, verifierFor({ 'db-ours': { kind: 'ours' } }))).rejects.toThrow();
  });

  test('a project with no default branch fails, naming the project, and deletes nothing', async () => {
    state.branches[PROJECT_ID] = [];

    await expect(run(state, neverCalled())).rejects.toThrow(
      new RegExp(`${PROJECT_ID}.*no default Branch`),
    );
    expect(state.deletedDatabaseIds).toEqual([]);
  });
});

describe('deleteStateDatabase (public entry point)', () => {
  test('wires the real verifyOwnership — typechecked here, not run (that would touch a real Postgres)', () => {
    const typed: (target: StateTarget) => ReturnType<typeof deleteStateDatabase> =
      deleteStateDatabase;
    expect(typed).toBe(deleteStateDatabase);
  });
});
