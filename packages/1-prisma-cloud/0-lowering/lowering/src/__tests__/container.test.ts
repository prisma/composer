import { beforeEach, describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import type { ManagementApiClient } from '../client.ts';
import { ManagementClient } from '../client.ts';
import {
  ContainerNotFoundError,
  deleteBranch,
  deleteProject,
  type ProjectRegion,
  resolveContainer,
} from '../container.ts';
import { PrismaApiError } from '../http.ts';

interface FakeProject {
  id: string;
  name: string;
  createdAt: string;
  workspace: { id: string };
  logicalId?: string | null;
}

interface FakeRepository {
  repoId: number;
  repoFullName: string;
  status: 'active' | 'archived';
}

interface FakeBranch {
  id: string;
  gitName: string;
  isDefault: boolean;
  createdAt: string;
}

interface FakeState {
  projects: FakeProject[];
  branches: Record<string, FakeBranch[]>;
  projectCreateCalls: number;
  projectCreateBodies: Record<string, unknown>[];
  branchCreateCalls: number;
  /** When set, the first create for this gitName 409s (racing create), after seeding the winner's branch as if a concurrent caller created it first. */
  raceGitName?: string;
  raced: boolean;
  deleteBranchCalls: string[];
  /** Overrides the DELETE response status — defaults to a 204 success. */
  deleteBranchResponseStatus?: number;
  deleteProjectCalls: string[];
  /** Overrides the DELETE response status — defaults to a 204 success. */
  deleteProjectResponseStatus?: number;
  /** Page size for GET /v1/projects — unset serves everything in one page. */
  projectsPageSize?: number;
  /** When set, GET /v1/projects reports hasMore with a nextCursor equal to the request's cursor — a broken, non-advancing pagination. */
  projectsCursorStuck?: boolean;
  /** When set, GET /v1/projects always reports hasMore with an ever-advancing nextCursor — pagination that never ends. */
  projectsCursorRunaway?: boolean;
  /** When set, GET /v1/projects reports hasMore but returns no nextCursor — more pages that cannot be fetched. */
  projectsCursorMissing?: boolean;
  /** When set, POST /v1/projects responds with a 409 (name already in use). */
  projectCreateConflict?: boolean;
  repositories: Record<string, FakeRepository[]>;
  repositoryQueries: string[];
  repositoryPageSize?: number;
  repositoryResponseStatus?: number;
  repositoryCursorMissing?: boolean;
  branchReadCalls: string[];
}

const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  projects: [],
  branches: {},
  projectCreateCalls: 0,
  projectCreateBodies: [],
  branchCreateCalls: 0,
  raced: false,
  deleteBranchCalls: [],
  deleteProjectCalls: [],
  repositories: {},
  repositoryQueries: [],
  branchReadCalls: [],
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
 * A stubbed `ManagementApiClient` covering projects, source repositories and
 * branches — everything `resolveContainer`
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
      const offset =
        init.params?.query?.['cursor'] === undefined ? 0 : Number(init.params.query['cursor']);
      const pageSize = state.projectsPageSize ?? state.projects.length;
      const data = state.projects.slice(offset, offset + pageSize);
      if (state.projectsCursorStuck === true) {
        return Promise.resolve(
          okResponse({ data, pagination: { nextCursor: String(offset), hasMore: true } }),
        );
      }
      if (state.projectsCursorRunaway === true) {
        return Promise.resolve(
          okResponse({ data, pagination: { nextCursor: String(offset + 1), hasMore: true } }),
        );
      }
      if (state.projectsCursorMissing === true) {
        return Promise.resolve(
          okResponse({ data, pagination: { nextCursor: null, hasMore: true } }),
        );
      }
      const nextOffset = offset + data.length;
      const hasMore = nextOffset < state.projects.length;
      return Promise.resolve(
        okResponse({
          data,
          pagination: { nextCursor: hasMore ? String(nextOffset) : null, hasMore },
        }),
      );
    }
    if (path === '/v1/projects/{projectId}/branches') {
      const projectId = init.params?.path?.['projectId'] ?? '';
      state.branchReadCalls.push(projectId);
      const gitName = init.params?.query?.['gitName'];
      const all = state.branches[projectId] ?? [];
      const data = gitName === undefined ? all : all.filter((b) => b.gitName === gitName);
      return Promise.resolve(
        okResponse({ data, pagination: { nextCursor: null, hasMore: false } }),
      );
    }
    if (path === '/v1/source-repositories') {
      const projectId = init.params?.query?.['projectId'] ?? '';
      state.repositoryQueries.push(projectId);
      if (state.repositoryResponseStatus !== undefined) {
        return Promise.resolve(errorResponse(state.repositoryResponseStatus));
      }
      const offset = Number(init.params?.query?.['cursor'] ?? 0);
      const repositories = state.repositories[projectId] ?? [];
      const pageSize = state.repositoryPageSize ?? repositories.length;
      const data = repositories.slice(offset, offset + pageSize);
      const nextOffset = offset + data.length;
      const hasMore = state.repositoryCursorMissing === true || nextOffset < repositories.length;
      return Promise.resolve(
        okResponse({
          data,
          pagination: {
            nextCursor:
              hasMore && state.repositoryCursorMissing !== true ? String(nextOffset) : null,
            hasMore,
          },
        }),
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
      state.projectCreateBodies.push(init.body ?? {});
      if (state.projectCreateConflict === true) {
        return Promise.resolve(errorResponse(409));
      }
      const id = `proj-${state.projectCreateCalls}`;
      const project: FakeProject = {
        id,
        name: String(init.body?.['name']),
        createdAt: new Date(state.projectCreateCalls).toISOString(),
        workspace: { id: String(init.body?.['workspaceId']) },
        logicalId: typeof init.body?.['logicalId'] === 'string' ? init.body['logicalId'] : null,
      };
      state.projects.push(project);
      // The platform creates every Project with its default Branch.
      state.branches[id] = [
        { id: `br-default-${id}`, gitName: 'main', isDefault: true, createdAt: project.createdAt },
      ];
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
          isDefault: false,
          createdAt: new Date().toISOString(),
        };
        state.branches[projectId] = [...(state.branches[projectId] ?? []), winner];
        return Promise.resolve(errorResponse(409));
      }

      const branch: FakeBranch = {
        id: `br-${projectId}-${state.branchCreateCalls}`,
        gitName,
        isDefault: (state.branches[projectId] ?? []).length === 0,
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
    if (path === '/v1/projects/{id}') {
      const id = init.params?.path?.['id'] ?? '';
      state.deleteProjectCalls.push(id);
      const status = state.deleteProjectResponseStatus ?? 204;
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
  opts: {
    workspaceId: string;
    appName: string;
    stage?: string;
    ensure?: boolean;
    region?: ProjectRegion;
    repositoryId?: number;
  },
) =>
  Effect.runPromise(
    resolveContainer(opts).pipe(Effect.provideService(ManagementClient, fakeClient(state))),
  );

describe('resolveContainer — Project resolution', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  test('no matching project creates one, resolving its default Branch id', async () => {
    const result = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      region: 'us-east-1',
    });

    expect(result.projectId).toBe('proj-1');
    expect(result.defaultBranchId).toBe('br-default-proj-1');
    expect(state.projectCreateCalls).toBe(1);
    expect(state.projects[0]?.name).toBe('storefront');
  });

  test('project creation opts out of the platform default database', async () => {
    await run(state, { workspaceId: 'ws-1', appName: 'storefront', region: 'us-east-1' });

    expect(state.projectCreateBodies[0]?.['createDatabase']).toBe(false);
  });

  test('project creation sends the configured region to the platform', async () => {
    await run(state, { workspaceId: 'ws-1', appName: 'storefront', region: 'ap-southeast-1' });

    expect(state.projectCreateBodies[0]?.['region']).toBe('ap-southeast-1');
  });

  test('no region when a new project is needed fails with an actionable error', async () => {
    const error: unknown = await run(state, { workspaceId: 'ws-1', appName: 'storefront' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).status).toBe(0);
    expect((error as PrismaApiError).message).toContain('"storefront"');
    expect((error as PrismaApiError).message).toContain('prismaCloud({ region:');
    expect((error as PrismaApiError).message).toContain('PRISMA_REGION');
  });

  test('an existing project resolves without a region — region is not required for find', async () => {
    state.projects.push({
      id: 'proj-existing',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
    state.branches['proj-existing'] = [
      { id: 'br-default', gitName: 'main', isDefault: true, createdAt: new Date(1).toISOString() },
    ];

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-existing');
    expect(state.projectCreateCalls).toBe(0);
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
    state.branches['proj-oldest'] = [
      { id: 'br-default', gitName: 'main', isDefault: true, createdAt: new Date(1).toISOString() },
    ];

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

    const result = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      region: 'us-east-1',
    });

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

    const result = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      region: 'us-east-1',
    });

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
    state.branches['proj-existing'] = [
      { id: 'br-default', gitName: 'main', isDefault: true, createdAt: new Date(1).toISOString() },
    ];

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-existing');
    expect(state.projectCreateCalls).toBe(0);
  });

  test('a project beyond the first listing page is still found', async () => {
    state.projectsPageSize = 1;
    state.projects.push(
      {
        id: 'proj-other',
        name: 'other-app',
        createdAt: new Date(1).toISOString(),
        workspace: { id: 'ws-1' },
      },
      {
        id: 'proj-wanted',
        name: 'storefront',
        createdAt: new Date(2).toISOString(),
        workspace: { id: 'ws-1' },
      },
    );
    state.branches['proj-wanted'] = [
      { id: 'br-default', gitName: 'main', isDefault: true, createdAt: new Date(2).toISOString() },
    ];

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-wanted');
    expect(state.projectCreateCalls).toBe(0);
  });

  test('a non-advancing project-listing cursor fails as broken pagination instead of looping', async () => {
    state.projectsPageSize = 1;
    state.projectsCursorStuck = true;
    state.projects.push({
      id: 'proj-1',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });

    const error: unknown = await run(state, { workspaceId: 'ws-1', appName: 'storefront' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).message).toContain('pagination appears broken');
    expect((error as PrismaApiError).message).toContain('non-advancing cursor');
  });

  test('project-listing pagination that never ends fails at the page cap instead of hanging', async () => {
    state.projectsPageSize = 1;
    state.projectsCursorRunaway = true;

    const error: unknown = await run(state, { workspaceId: 'ws-1', appName: 'storefront' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).message).toContain('did not finish within 1000 pages');
  });

  test('a project listing reporting more pages without a cursor fails instead of returning a partial listing', async () => {
    state.projectsPageSize = 1;
    state.projectsCursorMissing = true;
    state.projects.push({
      id: 'proj-1',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });

    const error: unknown = await run(state, { workspaceId: 'ws-1', appName: 'storefront' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).message).toContain('pagination appears broken');
    expect((error as PrismaApiError).message).toContain(
      'reported more pages but returned no cursor',
    );
  });

  test('logical id match: a project whose logical id equals appName is adopted even when another project has a matching name', async () => {
    state.projects.push(
      {
        id: 'proj-slug',
        name: 'old-display-name',
        logicalId: 'storefront',
        createdAt: new Date(1).toISOString(),
        workspace: { id: 'ws-1' },
      },
      {
        id: 'proj-name-only',
        name: 'storefront',
        createdAt: new Date(2).toISOString(),
        workspace: { id: 'ws-1' },
      },
    );
    state.branches['proj-slug'] = [
      { id: 'br-default', gitName: 'main', isDefault: true, createdAt: new Date(1).toISOString() },
    ];

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-slug');
    expect(state.projectCreateCalls).toBe(0);
  });

  test('name fallback: a project with no logical id is still found by display name when no logical id match exists', async () => {
    state.projects.push({
      id: 'proj-legacy',
      name: 'storefront',
      createdAt: new Date(1).toISOString(),
      workspace: { id: 'ws-1' },
    });
    state.branches['proj-legacy'] = [
      { id: 'br-default', gitName: 'main', isDefault: true, createdAt: new Date(1).toISOString() },
    ];

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-legacy');
    expect(state.projectCreateCalls).toBe(0);
  });

  test('project creation sends the module name as the logical id', async () => {
    await run(state, { workspaceId: 'ws-1', appName: 'storefront', region: 'us-east-1' });

    expect(state.projectCreateBodies[0]?.['logicalId']).toBe('storefront');
  });

  test('a 409 on project create surfaces a clear name-conflict error', async () => {
    state.projectCreateConflict = true;

    const error: unknown = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      region: 'us-east-1',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).status).toBe(409);
    expect((error as PrismaApiError).message).toContain('already exists');
    expect((error as PrismaApiError).message).toContain('free the name');
  });
});

describe('resolveContainer — GitHub repository connection', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState({
      projects: ['own', 'other'].map((name) => ({
        id: `proj-${name}`,
        name,
        logicalId: name,
        createdAt: new Date(1).toISOString(),
        workspace: { id: 'ws-1' },
      })),
      branches: {
        'proj-own': [
          { id: 'br-own', gitName: 'main', isDefault: true, createdAt: new Date(1).toISOString() },
        ],
        'proj-other': [
          {
            id: 'br-other',
            gitName: 'main',
            isDefault: true,
            createdAt: new Date(1).toISOString(),
          },
        ],
      },
      repositories: {
        'proj-own': [{ repoId: 101, repoFullName: 'acme/own', status: 'active' }],
        'proj-other': [{ repoId: 202, repoFullName: 'acme/other', status: 'active' }],
      },
    });
  });

  test.each([undefined, 'preview'])(
    'a renamed root cannot select another connected Project (stage %s)',
    async (stage) => {
      await expect(
        run(state, {
          workspaceId: 'ws-1',
          appName: 'other',
          repositoryId: 101,
          ...(stage !== undefined ? { stage } : {}),
        }),
      ).rejects.toThrow('is connected to Project "own" (proj-own)');
      expect(state.projectCreateCalls).toBe(0);
      expect(state.branchCreateCalls).toBe(0);
      expect(state.branchReadCalls).toEqual([]);
    },
  );

  test('the same refusal covers legacy display-name matching', async () => {
    delete state.projects[1]!.logicalId;
    await expect(
      run(state, { workspaceId: 'ws-1', appName: 'other', repositoryId: 101 }),
    ).rejects.toThrow('selects Project "other" (proj-other)');
    expect(state.branchReadCalls).toEqual([]);
  });

  test('a connected repository cannot create a new Project by changing the app name', async () => {
    await expect(
      run(state, {
        workspaceId: 'ws-1',
        appName: 'new-name',
        repositoryId: 101,
        region: 'us-east-1',
      }),
    ).rejects.toThrow('selects no existing Project');
    expect(state.projectCreateCalls).toBe(0);
    expect(state.branchReadCalls).toEqual([]);
  });

  test("a repository with no visible active connection cannot adopt another repository's Project", async () => {
    state.repositories['proj-own'] = [];
    await expect(
      run(state, { workspaceId: 'ws-1', appName: 'other', repositoryId: 101 }),
    ).rejects.toThrow('but this run is from repository 101');
    expect(state.branchReadCalls).toEqual([]);
  });

  test('destroy cannot resolve a different connected Project either', async () => {
    await expect(
      run(state, { workspaceId: 'ws-1', appName: 'other', repositoryId: 101, ensure: false }),
    ).rejects.toThrow('is connected to Project "own"');
    expect(state.branchReadCalls).toEqual([]);
  });

  test('a matching connection resolves normally using numeric identity after a repository rename', async () => {
    state.repositories['proj-own']![0]!.repoFullName = 'acme/renamed';
    expect(await run(state, { workspaceId: 'ws-1', appName: 'own', repositoryId: 101 })).toEqual({
      projectId: 'proj-own',
      defaultBranchId: 'br-own',
    });
  });

  test('the guard pages source connections instead of adopting a possibly incomplete listing', async () => {
    state.repositoryPageSize = 1;
    state.repositories['proj-own']!.unshift({
      repoId: 303,
      repoFullName: 'acme/archived',
      status: 'archived',
    });
    await expect(
      run(state, { workspaceId: 'ws-1', appName: 'other', repositoryId: 101 }),
    ).rejects.toThrow('is connected to Project "own"');
    expect(state.repositoryQueries).toEqual(['proj-own', 'proj-own']);
  });

  test.each([401, 404, 500])(
    'a failed connection lookup (HTTP %s) refuses before mutations',
    async (status) => {
      state.repositoryResponseStatus = status;
      await expect(
        run(state, { workspaceId: 'ws-1', appName: 'other', repositoryId: 101 }),
      ).rejects.toThrow();
      expect(state.projectCreateCalls).toBe(0);
      expect(state.branchReadCalls).toEqual([]);
    },
  );

  test('broken source pagination fails rather than skipping the guard', async () => {
    state.repositoryCursorMissing = true;
    await expect(
      run(state, { workspaceId: 'ws-1', appName: 'other', repositoryId: 101 }),
    ).rejects.toThrow('reported more pages but returned no cursor');
    expect(state.branchReadCalls).toEqual([]);
  });

  test('connections outside the configured workspace do not constrain the deploy', async () => {
    state.projects[0]!.workspace.id = 'ws-other';
    state.repositories['proj-other'] = [];
    state.branches['proj-other'] = state.branches['proj-own']!;
    expect(
      (await run(state, { workspaceId: 'ws-1', appName: 'other', repositoryId: 101 })).projectId,
    ).toBe('proj-other');
    expect(state.repositoryQueries).toEqual(['proj-other']);
  });

  test('first deploy can create its Project while no active source connection is visible', async () => {
    state.projects = [];
    expect(
      (
        await run(state, {
          workspaceId: 'ws-1',
          appName: 'own',
          repositoryId: 101,
          region: 'us-east-1',
        })
      ).projectId,
    ).toBe('proj-1');
    expect(state.projectCreateCalls).toBe(1);
  });

  test('outside GitHub Actions the resolver makes no source-repository requests', async () => {
    expect((await run(state, { workspaceId: 'ws-1', appName: 'own' })).projectId).toBe('proj-own');
    expect(state.repositoryQueries).toEqual([]);
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

  test('the default stage (no stage given) creates no Branch, resolving the existing default Branch id', async () => {
    state.branches['proj-1'] = [
      { id: 'br-default', gitName: 'main', isDefault: true, createdAt: new Date(1).toISOString() },
    ];

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront' });

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBeUndefined();
    expect(result.defaultBranchId).toBe('br-default');
    expect(state.branchCreateCalls).toBe(0);
  });

  test('the default stage on a project with no default Branch fails naming the broken platform invariant', async () => {
    state.branches['proj-1'] = [];

    const error: unknown = await run(state, { workspaceId: 'ws-1', appName: 'storefront' }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).message).toContain('proj-1 has no default Branch');
    expect(state.branchCreateCalls).toBe(0);
  });

  test('a named stage with no existing Branch creates one, and carries no defaultBranchId', async () => {
    const result = await run(state, {
      workspaceId: 'ws-1',
      appName: 'storefront',
      stage: 'staging',
    });

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBe('br-proj-1-1');
    expect(result.defaultBranchId).toBeUndefined();
    expect(state.branchCreateCalls).toBe(1);
    expect(state.branches['proj-1']?.[0]?.gitName).toBe('staging');
  });

  test('a named stage with an existing Branch adopts it — create-if-absent is idempotent', async () => {
    state.branches['proj-1'] = [
      {
        id: 'br-existing',
        gitName: 'staging',
        isDefault: false,
        createdAt: new Date(1).toISOString(),
      },
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
      {
        id: 'br-existing',
        gitName: 'staging',
        isDefault: false,
        createdAt: new Date(1).toISOString(),
      },
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
    state.branches['proj-1'] = [
      { id: 'br-default', gitName: 'main', isDefault: true, createdAt: new Date(1).toISOString() },
    ];

    const result = await run(state, { workspaceId: 'ws-1', appName: 'storefront', ensure: false });

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBeUndefined();
    expect(result.defaultBranchId).toBe('br-default');
    expect(state.projectCreateCalls).toBe(0);
    expect(state.branchCreateCalls).toBe(0);
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

describe('deleteProject', () => {
  let state: FakeState;

  beforeEach(() => {
    state = newFakeState();
  });

  const runDelete = (projectId: string) =>
    Effect.runPromise(
      deleteProject(projectId).pipe(Effect.provideService(ManagementClient, fakeClient(state))),
    );

  test('issues DELETE /v1/projects/{id}', async () => {
    await runDelete('proj-1');

    expect(state.deleteProjectCalls).toEqual(['proj-1']);
  });

  test('tolerates a 404 (already gone) without throwing', async () => {
    state.deleteProjectResponseStatus = 404;

    await runDelete('proj-1');

    expect(state.deleteProjectCalls).toEqual(['proj-1']);
  });

  test('surfaces a non-404 error (e.g. still has dependencies) as PrismaApiError', async () => {
    state.deleteProjectResponseStatus = 400;

    const error: unknown = await runDelete('proj-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrismaApiError);
    expect((error as PrismaApiError).status).toBe(400);
  });
});
