import { describe, expect, spyOn, test } from 'bun:test';
import type { ManagementApiClient } from '@internal/lowering';
import {
  containerDescriptor,
  isPrismaCloudContainer,
  PrismaCloudContainer,
  prismaCloudContainerOf,
} from '../container.ts';

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

/** A stubbed `ManagementApiClient` covering only `/v1/projects` and `/v1/projects/{projectId}/branches` — everything `resolveContainer` calls. */
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

/** Sets env vars for the duration of `fn`, restoring whatever was there before. */
async function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const baseEnv = { PRISMA_WORKSPACE_ID: 'ws-1', PRISMA_SERVICE_TOKEN: 'tok' };

describe('containerDescriptor().ensure()', () => {
  test('missing PRISMA_WORKSPACE_ID throws naming the variable', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: undefined, PRISMA_SERVICE_TOKEN: 'tok' }, async () => {
      const descriptor = containerDescriptor({ client: fakeClient(newFakeState()) });
      await expect(descriptor.ensure({ appName: 'storefront', stage: undefined })).rejects.toThrow(
        /PRISMA_WORKSPACE_ID is required/,
      );
    });
  });

  test('missing PRISMA_SERVICE_TOKEN (no injected client) throws naming the variable', async () => {
    await withEnv({ PRISMA_WORKSPACE_ID: 'ws-1', PRISMA_SERVICE_TOKEN: undefined }, async () => {
      const descriptor = containerDescriptor();
      await expect(descriptor.ensure({ appName: 'storefront', stage: undefined })).rejects.toThrow(
        /PRISMA_SERVICE_TOKEN is required/,
      );
    });
  });

  test('creates the Project + Branch when absent, returning a PrismaCloudContainer', async () => {
    const state = newFakeState();

    await withEnv(baseEnv, async () => {
      const descriptor = containerDescriptor({ client: fakeClient(state) });
      const instance = await descriptor.ensure({ appName: 'storefront', stage: 'staging' });

      expect(isPrismaCloudContainer(instance)).toBe(true);
      expect(instance.projectId).toBe('proj-1');
      expect(instance.branchId).toBe('br-proj-1-1');
      expect(state.projectCreateCalls).toBe(1);
      expect(state.branchCreateCalls).toBe(1);
    });
  });

  test('adopts an existing Project + Branch without creating', async () => {
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

    await withEnv(baseEnv, async () => {
      const descriptor = containerDescriptor({ client: fakeClient(state) });
      const instance = await descriptor.ensure({ appName: 'storefront', stage: 'staging' });

      expect(instance.projectId).toBe('proj-1');
      expect(instance.branchId).toBe('br-existing');
      expect(state.projectCreateCalls).toBe(0);
      expect(state.branchCreateCalls).toBe(0);
    });
  });

  test('a Management API failure throws the resolving-containers message', async () => {
    // A GET whose response carries an `error` fails `call()` with a
    // PrismaApiError, which `ensure` translates to the operator-facing text.
    const failingClient: ManagementApiClient = {
      GET: () =>
        Promise.resolve({
          data: undefined,
          error: { message: 'boom' },
          response: new Response(null, { status: 500 }),
        }),
    } as unknown as ManagementApiClient;

    await withEnv(baseEnv, async () => {
      const descriptor = containerDescriptor({ client: failingClient });
      await expect(descriptor.ensure({ appName: 'storefront', stage: undefined })).rejects.toThrow(
        /Prisma Management API error resolving containers/,
      );
    });
  });
});

describe('containerDescriptor().locate()', () => {
  test('nothing deployed for the app at all resolves to undefined (no stage)', async () => {
    const state = newFakeState();

    await withEnv(baseEnv, async () => {
      const descriptor = containerDescriptor({ client: fakeClient(state) });
      const instance = await descriptor.locate({ appName: 'storefront', stage: undefined });

      expect(instance).toBeUndefined();
      expect(state.projectCreateCalls).toBe(0);
    });
  });

  test('a Project with no matching Branch resolves to undefined', async () => {
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

    await withEnv(baseEnv, async () => {
      const descriptor = containerDescriptor({ client: fakeClient(state) });
      const instance = await descriptor.locate({ appName: 'storefront', stage: 'staging' });

      expect(instance).toBeUndefined();
      expect(state.branchCreateCalls).toBe(0);
    });
  });

  test('a seeded workspace resolves ids and creates nothing', async () => {
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

    await withEnv(baseEnv, async () => {
      const descriptor = containerDescriptor({ client: fakeClient(state) });
      const instance = await descriptor.locate({ appName: 'storefront', stage: 'staging' });

      expect(instance?.projectId).toBe('proj-1');
      expect(instance?.branchId).toBe('br-existing');
      expect(state.projectCreateCalls).toBe(0);
      expect(state.branchCreateCalls).toBe(0);
    });
  });
});

describe('containerDescriptor().remove()', () => {
  test('a named-stage instance deletes its Branch', async () => {
    const state = newFakeState();
    const instance = new PrismaCloudContainer(
      { appName: 'app', stage: 'staging' },
      'proj-1',
      'br-1',
    );

    await withEnv(baseEnv, async () => {
      const descriptor = containerDescriptor({ client: fakeClient(state) });
      await descriptor.remove(instance);

      expect(state.deleteBranchCalls).toEqual(['br-1']);
    });
  });

  test('a named-stage Branch delete tolerates a 404 (already gone)', async () => {
    const state = newFakeState({ deleteBranchResponseStatus: 404 });
    const instance = new PrismaCloudContainer(
      { appName: 'app', stage: 'staging' },
      'proj-1',
      'br-1',
    );

    await withEnv(baseEnv, async () => {
      const descriptor = containerDescriptor({ client: fakeClient(state) });
      await descriptor.remove(instance);

      expect(state.deleteBranchCalls).toEqual(['br-1']);
    });
  });

  test('a refused Branch delete (live members, or the production Branch) throws', async () => {
    const state = newFakeState({ deleteBranchResponseStatus: 409 });
    const instance = new PrismaCloudContainer(
      { appName: 'app', stage: 'staging' },
      'proj-1',
      'br-1',
    );

    await withEnv(baseEnv, async () => {
      const descriptor = containerDescriptor({ client: fakeClient(state) });
      await expect(descriptor.remove(instance)).rejects.toThrow(
        /Failed to delete the stage Branch/,
      );
    });
  });

  test('a default-stage instance removes the Project (logged), does not throw', async () => {
    const state = newFakeState();
    const instance = new PrismaCloudContainer(
      { appName: 'app', stage: undefined },
      'proj-1',
      undefined,
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await withEnv(baseEnv, async () => {
        const descriptor = containerDescriptor({ client: fakeClient(state) });
        await descriptor.remove(instance);

        expect(state.deleteProjectCalls).toEqual(['proj-1']);
        expect(logSpy.mock.calls.join(' ')).toContain('Removed the Project');
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('a 400 (still has another stage’s resources) keeps the Project and does not throw', async () => {
    const state = newFakeState({ deleteProjectResponseStatus: 400 });
    const instance = new PrismaCloudContainer(
      { appName: 'app', stage: undefined },
      'proj-1',
      undefined,
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    try {
      await withEnv(baseEnv, async () => {
        const descriptor = containerDescriptor({ client: fakeClient(state) });
        await descriptor.remove(instance);

        expect(logSpy.mock.calls.join(' ')).toContain('Kept the Project');
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('any other Project delete API error warns and does not throw', async () => {
    const state = newFakeState({ deleteProjectResponseStatus: 500 });
    const instance = new PrismaCloudContainer(
      { appName: 'app', stage: undefined },
      'proj-1',
      undefined,
    );
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await withEnv(baseEnv, async () => {
        const descriptor = containerDescriptor({ client: fakeClient(state) });
        await descriptor.remove(instance);

        expect(warnSpy.mock.calls.join(' ')).toContain('Could not remove the Project');
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('a default-stage Project removal without a token (no injected client) warns and does not throw', async () => {
    const instance = new PrismaCloudContainer(
      { appName: 'app', stage: undefined },
      'proj-1',
      undefined,
    );
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await withEnv({ PRISMA_WORKSPACE_ID: 'ws-1', PRISMA_SERVICE_TOKEN: undefined }, async () => {
        const descriptor = containerDescriptor();
        await expect(descriptor.remove(instance)).resolves.toBeUndefined();
        expect(warnSpy.mock.calls.join(' ')).toContain('PRISMA_SERVICE_TOKEN');
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('serialize()/deserialize() — the parent→child transport round trip', () => {
  test('a named-stage instance round-trips through JSON', () => {
    const instance = new PrismaCloudContainer(
      { appName: 'shop', stage: 'staging' },
      'proj-1',
      'br-1',
    );
    const descriptor = containerDescriptor();

    const restored = descriptor.deserialize(instance.serialize());

    expect(isPrismaCloudContainer(restored)).toBe(true);
    expect(restored.input).toEqual({ appName: 'shop', stage: 'staging' });
    expect(restored.projectId).toBe('proj-1');
    expect(restored.branchId).toBe('br-1');
  });

  test('a default-stage instance round-trips with branchId absent', () => {
    const instance = new PrismaCloudContainer(
      { appName: 'shop', stage: undefined },
      'proj-1',
      undefined,
    );
    const descriptor = containerDescriptor();

    const restored = descriptor.deserialize(instance.serialize());

    expect(restored.input).toEqual({ appName: 'shop', stage: undefined });
    expect(restored.branchId).toBeUndefined();
  });

  test('serialize() never emits an empty string', () => {
    const instance = new PrismaCloudContainer(
      { appName: 'shop', stage: undefined },
      'proj-1',
      undefined,
    );
    expect(instance.serialize().length).toBeGreaterThan(0);
  });

  test.each([
    ['not JSON', 'not-json-at-all'],
    ['not an object', '"a string"'],
    ['missing input', JSON.stringify({ projectId: 'p' })],
    ['input.appName not a string', JSON.stringify({ input: { appName: 42 }, projectId: 'p' })],
    [
      'input.stage not a string or absent',
      JSON.stringify({ input: { appName: 'a', stage: 42 }, projectId: 'p' }),
    ],
    ['missing projectId', JSON.stringify({ input: { appName: 'a' } })],
    [
      'branchId not a string or absent',
      JSON.stringify({ input: { appName: 'a' }, projectId: 'p', branchId: 42 }),
    ],
  ])('rejects an invalid payload: %s', (_label, payload) => {
    const descriptor = containerDescriptor();
    expect(() => descriptor.deserialize(payload)).toThrow(/container transport payload/);
  });
});

describe('prismaCloudContainerOf()', () => {
  test('narrows a resolved PrismaCloudContainer', () => {
    const instance = new PrismaCloudContainer(
      { appName: 'shop', stage: undefined },
      'proj-1',
      undefined,
    );
    expect(prismaCloudContainerOf(instance)).toBe(instance);
  });

  test('throws, naming the missing descriptor run, on undefined', () => {
    expect(() => prismaCloudContainerOf(undefined)).toThrow(
      /the Prisma Cloud container was not resolved — the extension's container descriptor did not run/,
    );
  });
});
