import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import type { ManagementApiClient } from '../client.ts';
import { ManagementClient } from '../client.ts';
import { claimPoisonDatabaseUrl } from '../database-url-poison.ts';
import { PrismaApiError } from '../http.ts';

interface PostCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

interface FakeState {
  readonly posts: PostCall[];
  /** `${key}:${class}` combinations the platform already holds — a create for one 409s. */
  readonly existing: ReadonlySet<string>;
  /** When set, every create returns this status instead of 201. */
  readonly failWith?: number;
}

const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  posts: [],
  existing: new Set<string>(),
  ...overrides,
});

/**
 * A stubbed `ManagementApiClient` covering only `POST
 * /v1/environment-variables`. `as any as ManagementApiClient` is acceptable
 * here (test file — exempt from the no-bare-cast rule): the fake's shape
 * already guarantees the safety a hand-written openapi-fetch signature would.
 */
const fakeClient = (state: FakeState): ManagementApiClient => {
  const POST = (path: string, init: { body?: Record<string, unknown> } = {}) => {
    if (path !== '/v1/environment-variables') {
      throw new Error(`fakeClient: unexpected POST ${path}`);
    }
    const body = init.body ?? {};
    state.posts.push({ path, body });

    if (state.failWith !== undefined) {
      return Promise.resolve({
        data: undefined,
        error: { message: 'stubbed failure' },
        response: new Response(null, { status: state.failWith }),
      });
    }
    if (state.existing.has(`${String(body['key'])}:${String(body['class'])}`)) {
      return Promise.resolve({
        data: undefined,
        error: { message: 'A variable with this key already exists in this environment.' },
        response: new Response(null, { status: 409 }),
      });
    }
    return Promise.resolve({
      data: { data: { id: `env-${state.posts.length}` } },
      error: undefined,
      response: new Response(null, { status: 201 }),
    });
  };

  // biome-ignore lint/suspicious/noExplicitAny: test stub — see the doc comment above.
  return { POST } as any as ManagementApiClient;
};

const run = (projectId: string, state: FakeState) =>
  Effect.runPromise(
    claimPoisonDatabaseUrl(projectId).pipe(
      Effect.provideService(ManagementClient, fakeClient(state)),
    ),
  );

describe('claimPoisonDatabaseUrl', () => {
  test('creates both keys in both classes at project level, with a value that cannot connect', async () => {
    const state = newFakeState();

    await run('proj_1', state);

    expect(state.posts.map((p) => p.body)).toEqual([
      { projectId: 'proj_1', class: 'production', key: 'DATABASE_URL', value: '-' },
      { projectId: 'proj_1', class: 'preview', key: 'DATABASE_URL', value: '-' },
      { projectId: 'proj_1', class: 'production', key: 'DATABASE_URL_POOLED', value: '-' },
      { projectId: 'proj_1', class: 'preview', key: 'DATABASE_URL_POOLED', value: '-' },
    ]);
    // Project-level rows only: a branch id would scope the claim to one branch
    // and leave every other stage's preview unclaimed.
    for (const post of state.posts) expect(post.body['branchId']).toBeUndefined();
  });

  // A row already on the platform is the platform's own system-managed one, or
  // one an earlier deploy claimed. Either way it stays exactly as it is: the
  // 409 is swallowed and no PATCH or DELETE follows.
  test('a 409 on one key is skipped, and the remaining claims still run', async () => {
    const state = newFakeState({ existing: new Set(['DATABASE_URL:production']) });

    await run('proj_1', state);

    expect(state.posts).toHaveLength(4);
    expect(state.posts.every((p) => p.path === '/v1/environment-variables')).toBe(true);
  });

  test('every key already present is a complete no-op — four creates, four 409s, nothing else', async () => {
    const state = newFakeState({
      existing: new Set([
        'DATABASE_URL:production',
        'DATABASE_URL:preview',
        'DATABASE_URL_POOLED:production',
        'DATABASE_URL_POOLED:preview',
      ]),
    });

    await expect(run('proj_1', state)).resolves.toBeUndefined();
    expect(state.posts).toHaveLength(4);
  });

  test('any other API error fails, carrying the status — the deploy must not proceed unclaimed', async () => {
    const state = newFakeState({ failWith: 422 });

    const exit = await Effect.runPromise(
      claimPoisonDatabaseUrl('proj_1').pipe(
        Effect.provideService(ManagementClient, fakeClient(state)),
        Effect.flip,
      ),
    );

    expect(exit).toBeInstanceOf(PrismaApiError);
    expect(exit.status).toBe(422);
    // Failed on the first claim: the rest are never attempted.
    expect(state.posts).toHaveLength(1);
  });

  test('no Management API client in context — the local target — claims nothing', async () => {
    await expect(Effect.runPromise(claimPoisonDatabaseUrl('local'))).resolves.toBeUndefined();
  });
});
