import { describe, expect, spyOn, test } from 'bun:test';
import type { ManagementApiClient } from '@internal/lowering';
import { CliError } from '../cli-error.ts';
import {
  deleteAppProject,
  deleteStageBranch,
  deleteStageStateDatabase,
  ensureContainers,
  validateStageName,
} from '../ensure-containers.ts';

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
  isDefault?: boolean;
}

interface FakeState {
  projects: FakeProject[];
  branches: Record<string, FakeBranch[]>;
  /** Answers the flat `GET /v1/databases` — empty unless a test puts one there. */
  databases: { id: string; name: string; isDefault: boolean; createdAt: string }[];
  projectCreateCalls: number;
  branchCreateCalls: number;
  deleteBranchCalls: string[];
  /** Overrides the DELETE response status — defaults to a 204 success. */
  deleteBranchResponseStatus?: number;
  deleteProjectCalls: string[];
  /** Overrides the DELETE response status — defaults to a 204 success. */
  deleteProjectResponseStatus?: number;
}

const newFakeState = (overrides: Partial<FakeState> = {}): FakeState => ({
  projects: [],
  branches: {},
  databases: [],
  projectCreateCalls: 0,
  branchCreateCalls: 0,
  deleteBranchCalls: [],
  deleteProjectCalls: [],
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
 * `/v1/projects/{projectId}/branches` — everything `resolveContainer` (and
 * therefore `ensureContainers`) calls. Mirrors the fake in
 * `@internal/lowering`'s `container.test.ts`.
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
    if (path === '/v1/databases') {
      return Promise.resolve(
        okResponse({ data: state.databases, pagination: { nextCursor: null, hasMore: false } }),
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

const baseEnv = { PRISMA_WORKSPACE_ID: 'ws-1', PRISMA_SERVICE_TOKEN: 'tok' };

describe('validateStageName()', () => {
  test.each(['staging', 'pr-42', 'feat/x'])('accepts %s', (stage) => {
    expect(() => validateStageName(stage)).not.toThrow();
  });

  test.each(['foo..bar', 'foo bar', 'foo~1'])('rejects %s', (stage) => {
    expect(() => validateStageName(stage)).toThrow(CliError);
  });
});

describe('ensureContainers()', () => {
  test('missing PRISMA_WORKSPACE_ID is a CliError', async () => {
    await expect(
      ensureContainers(
        { command: 'deploy', appName: 'storefront', stage: undefined, env: {} },
        { client: fakeClient(newFakeState()) },
      ),
    ).rejects.toThrow(CliError);
    await expect(
      ensureContainers(
        { command: 'deploy', appName: 'storefront', stage: undefined, env: {} },
        { client: fakeClient(newFakeState()) },
      ),
    ).rejects.toThrow(/PRISMA_WORKSPACE_ID/);
  });

  test('missing PRISMA_SERVICE_TOKEN (no injected client) is a CliError', async () => {
    await expect(
      ensureContainers({
        command: 'deploy',
        appName: 'storefront',
        stage: undefined,
        env: { PRISMA_WORKSPACE_ID: 'ws-1' },
      }),
    ).rejects.toThrow(/PRISMA_SERVICE_TOKEN/);
  });

  test('an invalid --stage is a CliError from validateStageName, before any API call', async () => {
    const state = newFakeState();
    await expect(
      ensureContainers(
        { command: 'deploy', appName: 'storefront', stage: 'foo bar', env: baseEnv },
        { client: fakeClient(state) },
      ),
    ).rejects.toThrow(/Invalid --stage/);
    expect(state.projectCreateCalls).toBe(0);
  });

  test('deploy creates the Project + Branch when absent', async () => {
    const state = newFakeState();

    const result = await ensureContainers(
      { command: 'deploy', appName: 'storefront', stage: 'staging', env: baseEnv },
      { client: fakeClient(state) },
    );

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBe('br-proj-1-1');
    expect(state.projectCreateCalls).toBe(1);
    expect(state.branchCreateCalls).toBe(1);
  });

  test('deploy adopts an existing Project + Branch without creating', async () => {
    const state = newFakeState({
      projects: [
        {
          id: 'proj-1',
          name: 'storefront',
          createdAt: new Date(1).toISOString(),
          workspace: { id: 'ws-1' },
        },
      ],
      branches: {
        'proj-1': [{ id: 'br-existing', gitName: 'staging', createdAt: new Date(1).toISOString() }],
      },
    });

    const result = await ensureContainers(
      { command: 'deploy', appName: 'storefront', stage: 'staging', env: baseEnv },
      { client: fakeClient(state) },
    );

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBe('br-existing');
    expect(state.projectCreateCalls).toBe(0);
    expect(state.branchCreateCalls).toBe(0);
  });

  test('destroy against a workspace with no Project at all is "nothing deployed for <app>" — no stage suffix, even though --stage was given', async () => {
    const state = newFakeState();

    const error: unknown = await ensureContainers(
      { command: 'destroy', appName: 'storefront', stage: 'staging', env: baseEnv },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe('Nothing deployed for storefront — deploy it first.');
    expect(state.projectCreateCalls).toBe(0);
    expect(state.branchCreateCalls).toBe(0);
  });

  test('destroy against a Project with no matching Branch is "nothing deployed for <app>/<stage>"', async () => {
    const state = newFakeState({
      projects: [
        {
          id: 'proj-1',
          name: 'storefront',
          createdAt: new Date(1).toISOString(),
          workspace: { id: 'ws-1' },
        },
      ],
    });

    const error: unknown = await ensureContainers(
      { command: 'destroy', appName: 'storefront', stage: 'staging', env: baseEnv },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      'Nothing deployed for storefront/staging — deploy it first.',
    );
    expect(state.projectCreateCalls).toBe(0);
    expect(state.branchCreateCalls).toBe(0);
  });

  test('destroy against a seeded workspace resolves ids and creates nothing', async () => {
    const state = newFakeState({
      projects: [
        {
          id: 'proj-1',
          name: 'storefront',
          createdAt: new Date(1).toISOString(),
          workspace: { id: 'ws-1' },
        },
      ],
      branches: {
        'proj-1': [{ id: 'br-existing', gitName: 'staging', createdAt: new Date(1).toISOString() }],
      },
    });

    const result = await ensureContainers(
      { command: 'destroy', appName: 'storefront', stage: 'staging', env: baseEnv },
      { client: fakeClient(state) },
    );

    expect(result.projectId).toBe('proj-1');
    expect(result.branchId).toBe('br-existing');
    expect(state.projectCreateCalls).toBe(0);
    expect(state.branchCreateCalls).toBe(0);
  });

  test('destroy for the default stage (no stage) against an empty workspace is the "nothing deployed" CliError, without a stage suffix', async () => {
    const state = newFakeState();

    const error: unknown = await ensureContainers(
      { command: 'destroy', appName: 'storefront', stage: undefined, env: baseEnv },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('Nothing deployed for storefront —');
  });
});

describe('deleteStageStateDatabase()', () => {
  test('missing PRISMA_SERVICE_TOKEN (no injected client) is a CliError', async () => {
    await expect(
      deleteStageStateDatabase({ projectId: 'proj-1', branchId: 'br-1', env: {} }),
    ).rejects.toThrow(/PRISMA_SERVICE_TOKEN/);
  });

  test('a branch with no state database on it succeeds, so a repeated destroy is a no-op', async () => {
    const state = newFakeState();

    await expect(
      deleteStageStateDatabase(
        { projectId: 'proj-1', branchId: 'br-1' },
        { client: fakeClient(state) },
      ),
    ).resolves.toBeUndefined();
  });

  test('a Management API failure becomes a CliError naming the step', async () => {
    // No default branch on the project, and no branchId given — the lookup fails.
    const state = newFakeState();

    const error: unknown = await deleteStageStateDatabase(
      { projectId: 'proj-1' },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('Failed to delete the deploy-state database');
  });
});

describe('deleteStageBranch()', () => {
  test('missing PRISMA_SERVICE_TOKEN (no injected client) is a CliError', async () => {
    await expect(deleteStageBranch({ branchId: 'br-1', env: {} })).rejects.toThrow(
      /PRISMA_SERVICE_TOKEN/,
    );
  });

  test('with an injected client, calls DELETE with the branchId', async () => {
    const state = newFakeState();

    await deleteStageBranch({ branchId: 'br-1' }, { client: fakeClient(state) });

    expect(state.deleteBranchCalls).toEqual(['br-1']);
  });

  test('tolerates a 404 (already gone) without throwing', async () => {
    const state = newFakeState({ deleteBranchResponseStatus: 404 });

    await deleteStageBranch({ branchId: 'br-1' }, { client: fakeClient(state) });

    expect(state.deleteBranchCalls).toEqual(['br-1']);
  });

  test('a refused delete (e.g. live members, or the production Branch) throws CliError', async () => {
    const state = newFakeState({ deleteBranchResponseStatus: 409 });

    const error: unknown = await deleteStageBranch(
      { branchId: 'br-1' },
      { client: fakeClient(state) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('Failed to delete the stage Branch');
  });
});

describe('deleteAppProject()', () => {
  test('missing PRISMA_SERVICE_TOKEN (no injected client) logs a warning and does not throw', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(deleteAppProject({ projectId: 'proj-1', env: {} })).resolves.toBeUndefined();
      expect(warnSpy.mock.calls.join(' ')).toContain('PRISMA_SERVICE_TOKEN');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('with an injected client, calls DELETE with the projectId', async () => {
    const state = newFakeState();

    await deleteAppProject({ projectId: 'proj-1' }, { client: fakeClient(state) });

    expect(state.deleteProjectCalls).toEqual(['proj-1']);
  });

  test('success removes the project (logged), does not throw', async () => {
    const state = newFakeState();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        deleteAppProject({ projectId: 'proj-1' }, { client: fakeClient(state) }),
      ).resolves.toBeUndefined();
      expect(logSpy.mock.calls.join(' ')).toContain('Removed the Project');
    } finally {
      logSpy.mockRestore();
    }
  });

  test('tolerates a 404 (already gone) without throwing', async () => {
    const state = newFakeState({ deleteProjectResponseStatus: 404 });

    await expect(
      deleteAppProject({ projectId: 'proj-1' }, { client: fakeClient(state) }),
    ).resolves.toBeUndefined();
    expect(state.deleteProjectCalls).toEqual(['proj-1']);
  });

  test("a 400 (still has another stage's resources) keeps the project and does not throw", async () => {
    const state = newFakeState({ deleteProjectResponseStatus: 400 });
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        deleteAppProject({ projectId: 'proj-1' }, { client: fakeClient(state) }),
      ).resolves.toBeUndefined();
      expect(logSpy.mock.calls.join(' ')).toContain('Kept the Project');
    } finally {
      logSpy.mockRestore();
    }
  });

  test('any other API error logs a warning and does not throw', async () => {
    const state = newFakeState({ deleteProjectResponseStatus: 500 });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        deleteAppProject({ projectId: 'proj-1' }, { client: fakeClient(state) }),
      ).resolves.toBeUndefined();
      expect(warnSpy.mock.calls.join(' ')).toContain('Could not remove the Project');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
