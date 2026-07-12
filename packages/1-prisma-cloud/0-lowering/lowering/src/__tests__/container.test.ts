import { beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import type { ManagementApiClient } from '../client.ts';
import { ManagementClient } from '../client.ts';
import { ContainerNotFoundError, deleteBranch, resolveContainer } from '../container.ts';
import { PrismaApiError } from '../http.ts';

interface FakeProject {
  id: string;
  name: string;
  createdAt: string;
  workspace: { id: string };
}

interface FakeBranch {
  id: string;
  gitName: string;
  createdAt: string;
}

interface FakeState {
  projects: FakeProject[];
  branches: Record<string, FakeBranch[]>;
  projectCreateCalls: number;
  branchCreateCalls: number;
  /** When set, the first create for this gitName 409s (racing create), after seeding the winner's branch as if a concurrent caller created it first. */
  raceGitName?: string;
  raced: boolean;
  deleteBranchCalls: string[];
  /** Overrides the DELETE response status — defaults to a 204 success. */
  deleteBranchResponseStatus?: number;
}

const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  projects: [],
  branches: {},
  projectCreateCalls: 0,
  branchCreateCalls: 0,
  raced: false,
  deleteBranchCalls: [],
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

/**
 * A stubbed `ManagementApiClient` covering only `/v1/projects` and
 * `/v1/projects/{projectId}/branches` — everything `resolveContainer`
 * calls. `as ManagementApiClient` is acceptable here (test file — exempt
 * from the no-bare-cast rule): this fake's shape already guarantees the
 * safety a hand-written openapi-fetch generic signature would.
 */
const fakeClient = (state: FakeState): ManagementApiClient => {
  const GET = (
    path: string,
    init: { params?: { path?: Record<string, string>; query?: Record<string, string> } } = {},
  ) => {
    if (path === '/v1/projects') {
      return Promise.resolve(
        okResponse({ data: state.projects, pagination: { nextCursor: null, hasMore: false } }),
      );
    }
    if (path === '/v1/projects/{projectId}/branches') {
      const projectId = init.params?.path?.['projectId'] ?? '';
      const gitName = init.params?.query?.['gitName'];
      const all = state.branches[projectId] ?? [];
      const data = gitName === undefined ? all : all.filter((b) => b.gitName === gitName);
      return Promise.resolve(
        okResponse({ data, pagination: { nextCursor: null, hasMore: false } }),
      );
    }
    throw new Error(`fakeClient: unexpected GET ${path}`);
  };

  const POST = (
    path: string,
    init: { params?: { path?: Record<string, string> }; body?: Record<string, unknown> } = {},
  ) => {
    if (path === '/v1/projects') {
      state.projectCreateCalls++;
      const id = `proj-${state.projectCreateCalls}`;
      const project: FakeProject = {
        id,
        name: String(init.body?.['name']),
        createdAt: new Date(state.projectCreateCalls).toISOString(),
        workspace: { id: String(init.body?.['workspaceId']) },
      };
      state.projects.push(project);
      return Promise.resolve(okResponse({ data: project }, 201));
    }
    if (path === '/v1/projects/{projectId}/branches') {
      const projectId = init.params?.path?.['projectId'] ?? '';
      const gitName = String(init.body?.['gitName']);
      state.branchCreateCalls++;

      if (state.raceGitName === gitName && !state.raced) {
        state.raced = true;
        const winner: FakeBranch = {
          id: `br-race-${gitName}`,
          gitName,
          createdAt: new Date().toISOString(),
        };
        state.branches[projectId] = [...(state.branches[projectId] ?? []), winner];
        return Promise.resolve(errorResponse(409));
      }

      const branch: FakeBranch = {
        id: `br-${projectId}-${state.branchCreateCalls}`,
        gitName,
        createdAt: new Date().toISOString(),
      };
      state.branches[projectId] = [...(state.branches[projectId] ?? []), branch];
      return Promise.resolve(okResponse({ data: branch }, 201));
    }
    throw new Error(`fakeClient: unexpected POST ${path}`);
  };

  const DELETE = (path: string, init: { params?: { path?: Record<string, string> } } = {}) => {
    if (path === '/v1/branches/{branchId}') {
      const branchId = init.params?.path?.['branchId'] ?? '';
      state.deleteBranchCalls.push(branchId);
      const status = state.deleteBranchResponseStatus ?? 204;
      return Promise.resolve(
        status >= 400
          ? errorResponse(status)
          : { data: undefined, error: undefined, response: new Response(null, { status }) },
      );
    }
    throw new Error(`fakeClient: unexpected DELETE ${path}`);
  };

  // biome-ignore lint/suspicious/noExplicitAny: test stub — see the doc comment above.
  return { GET, POST, DELETE } as any as ManagementApiClient;
};

const run = (
  state: FakeState,
  opts: { workspaceId: string; appName: string; stage?: string; ensure?: boolean },
) =>
  Effect.runPromise(
    resolveContainer(opts).pipe(Effect.provideService(ManagementClient, fakeClient(state))),
  );

describe('resolveContainer — Project resolution', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  test('no matching project creates one', async () => {
    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-1');
    expect(state.projectCreateCalls).toBe(1);
    expect(state.projects[0]?.name).toBe('storefront');
  });

  test('adopt-oldest: several projects share the name — the oldest is adopted, none created', async () => {
    state.projects.push(
      {
        id: 'proj-newest',
        name: 'storefront',
        createdAt: new Date(3).toISOString(),
        workspace: { id: 'ws-1' },
      },
      {
        id: 'proj-oldest',
        name: 'storefront',
        createdAt: new Date(1).toISOString(),
        workspace: { id: 'ws-1' },
      },
      {
        id: 'proj-middle',
        name: 'storefront',
        createdAt: new Date(2).toISOString(),
        workspace: { id: 'ws-1' },
      },
    );

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-oldest');
    expect(state.projectCreateCalls).toBe(0);
  });

  test('a project with the same name in a different workspace is not adopted', async () => {
    state.projects.push({
      id: 'proj-other-ws',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-2' },
    });

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-1');
    expect(state.projectCreateCalls).toBe(1);
  });

  test('a project with a different name is not adopted', async () => {
    state.projects.push({
      id: 'proj-other-name',
      name: 'other-app',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-1');
    expect(state.projectCreateCalls).toBe(1);
  });

  test('workspace-id shape mismatch: a wksp_-prefixed API id still matches a bare configured id', async () => {
    state.projects.push({
      id: 'proj-existing',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'wksp_ws-1' },
    });

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-existing');
    expect(state.projectCreateCalls).toBe(0);
  });
});

describe('resolveContainer — Branch resolution', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
    state.projects.push({
      id: 'proj-1',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
  });

  test('the default stage (no stage given) creates no Branch', async () => {
    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBeUndefined();
    expect(state.branchCreateCalls).toBe(0);
  });

  test('a named stage with no existing Branch creates one', async () => {
    const result = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      stage: 'staging',
    });

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBe('br-proj-1-1');
    expect(state.branchCreateCalls).toBe(1);
    expect(state.branches['proj-1']?.[0]?.gitName).toBe('staging');
  });

  test('a named stage with an existing Branch adopts it — create-if-absent is idempotent', async () => {
    state.branches['proj-1'] = [
      { id: 'br-existing', gitName: 'staging', createdAt: new Date(1).toISOString() },
    ];

    const result = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      stage: 'staging',
    });

    expect(result.branchId).toBe('br-existing');
    expect(state.branchCreateCalls).toBe(0);
  });

  test('a racing create (409, someone else created the Branch first) re-observes and adopts the winner', async () => {
    state.raceGitName = 'staging';

    const result = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      stage: 'staging',
    });

    expect(result.branchId).toBe('br-race-staging');
    expect(state.branchCreateCalls).toBe(1);
  });

  test('two different named stages resolve to two different Branches', async () => {
    const staging = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      stage: 'staging',
    });
    const preview = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      stage: 'pr-42',
    });

    expect(staging.branchId).not.toBe(preview.branchId);
    expect(state.branches['proj-1']).toHaveLength(2);
  });
});

describe('resolveContainer — ensure: false (find-only, used by destroy)', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  test('a missing Project fails with ContainerNotFoundError and creates nothing', async () => {
    const error: unknown = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      ensure: false,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContainerNotFoundError);
    expect((error as ContainerNotFoundError).appName).toBe('storefront');
    expect((error as ContainerNotFoundError).stage).toBeUndefined();
    expect(state.projectCreateCalls).toBe(0);
  });

  test('a named stage with a missing Branch fails with ContainerNotFoundError and creates nothing', async () => {
    state.projects.push({
      id: 'proj-1',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });

    const error: unknown = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      stage: 'staging',
      ensure: false,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContainerNotFoundError);
    expect((error as ContainerNotFoundError).appName).toBe('storefront');
    expect((error as ContainerNotFoundError).stage).toBe('staging');
    expect(state.branchCreateCalls).toBe(0);
  });

  test('a found Project and Branch resolve normally under ensure: false, with zero create calls', async () => {
    state.projects.push({
      id: 'proj-1',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
    state.branches['proj-1'] = [
      { id: 'br-existing', gitName: 'staging', createdAt: new Date(1).toISOString() },
    ];

    const result = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      stage: 'staging',
      ensure: false,
    });

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBe('br-existing');
    expect(state.projectCreateCalls).toBe(0);
    expect(state.branchCreateCalls).toBe(0);
  });

  test('a found Project alone (default stage) resolves normally under ensure: false, with zero create calls', async () => {
    state.projects.push({
      id: 'proj-1',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront', ensure: false });

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBeUndefined();
    expect(state.projectCreateCalls).toBe(0);
  });
});

describe('deleteBranch', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  const runDelete = (branchId: string) =>
    Effect.runPromise(
      deleteBranch(branchId).pipe(Effect.provideService(ManagementClient, fakeClient(state))),
    );

  test('issues DELETE /v1/branches/{branchId}', async () => {
    await runDelete('br-1');

    expect(state.deleteBranchCalls).toEqual(['br-1']);
  });

  test('tolerates a 404 (already gone) without throwing', async () => {
    state.deleteBranchResponseStatus = 404;

    await runDelete('br-1');

    expect(state.deleteBranchCalls).toEqual(['br-1']);
  });

  test('surfaces a non-404 error (e.g. live members, or the production Branch) as PrismaApiError', async () => {
    state.deleteBranchResponseStatus = 409;

    const error: unknown = await runDelete('br-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).status).toBe(409);
  });
});
