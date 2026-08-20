import { describe, expect, test } from 'bun:test';
import type { ContainerInstance } from '@internal/core/config';
import type { BuildsApi, CreateBuildBody, UpdateBuildBody } from '../builds/api.ts';
import { type BuildContainerRefs, buildReporter } from '../builds/reporter.ts';

const ENV = {
  PRISMA_SERVICE_TOKEN: 'token',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF_NAME: 'main',
};

interface Recorded {
  creates: CreateBuildBody[];
  updates: { buildId: string; body: UpdateBuildBody }[];
}

/** `createdId` is explicit, never defaulted — a default would swallow the `undefined` the "platform refused" case depends on. */
function fakeApi(createdId: string | undefined): { api: BuildsApi; recorded: Recorded } {
  const recorded: Recorded = { creates: [], updates: [] };
  return {
    recorded,
    api: {
      create: async (body) => {
        recorded.creates.push(body);
        return createdId;
      },
      update: async (buildId, body) => {
        recorded.updates.push({ buildId, body });
        return true;
      },
      reportResource: async () => true,
    },
  };
}

/** Stands in for the extension's own container; the reporter only ever sees it through `refsOf`. */
const CONTAINER = { projectId: 'proj_1', branchId: 'branch_1' };
const refsOf = (container: ContainerInstance): BuildContainerRefs =>
  container as unknown as BuildContainerRefs;

const begin = (
  api: BuildsApi,
  env: Record<string, string | undefined> = ENV,
  warn: (message: string) => void = () => {},
  reportId: string | undefined = undefined,
) =>
  buildReporter({ api, env, warn, refsOf }).begin({
    appName: 'storefront',
    stage: undefined,
    cwd: import.meta.dir,
    reportId,
  });

describe('buildReporter', () => {
  test('creates a build and marks it running in the deploy phase', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });

    expect(recorded.creates).toEqual([
      { source: 'cli', commitSha: 'a'.repeat(40), branchName: 'main' },
    ]);
    // `deploy`, never `build`: Composer does not build the user's code.
    expect(recorded.updates[0]).toEqual({
      buildId: 'bld_new',
      body: { phase: 'deploy', state: 'running' },
    });
  });

  test('joins the build the Action created instead of creating a second one', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api, { ...ENV, PRISMA_BUILD_ID: 'bld_from_action' });
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });

    expect(recorded.creates).toEqual([]);
    expect(recorded.updates.every((u) => u.buildId === 'bld_from_action')).toBe(true);
    // The creator's own link to its logs is never overwritten.
    expect(recorded.updates.some((u) => 'externalLogUrl' in u.body)).toBe(false);
  });

  test('joins the build named on the command line, without the environment variable', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api, ENV, () => {}, 'bld_from_flag');
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });

    expect(recorded.creates).toEqual([]);
    expect(recorded.updates.every((u) => u.buildId === 'bld_from_flag')).toBe(true);
    expect(session?.childEnv()).toEqual({ PRISMA_BUILD_ID: 'bld_from_flag' });
  });

  test('the command line beats the environment — a job-wide variable does not override one step', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(
      api,
      { ...ENV, PRISMA_BUILD_ID: 'bld_from_env' },
      () => {},
      'bld_from_flag',
    );
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });

    expect(recorded.updates.every((u) => u.buildId === 'bld_from_flag')).toBe(true);
  });

  test('an empty build id is how a shell spells unset, so the build is created', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api, { ...ENV, PRISMA_BUILD_ID: '' }, () => {}, '');
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });

    expect(recorded.creates).toHaveLength(1);
    expect(recorded.updates.every((u) => u.buildId === 'bld_new')).toBe(true);
  });

  test('passes the build id into the apply, so the state store reports against it', async () => {
    const { api } = fakeApi('bld_new');

    const session = await begin(api);
    expect(session?.childEnv()).toEqual({ PRISMA_BUILD_ID: 'bld_new' });
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });
  });

  test('attaches the project and branch on their own, so a rejection costs only those fields', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.attach({ container: CONTAINER as unknown as ContainerInstance });
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });

    expect(recorded.updates[1]).toEqual({
      buildId: 'bld_new',
      body: { projectId: 'proj_1', branchId: 'branch_1' },
    });
  });

  test('an extension with no container has nothing to attach and sends nothing', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.attach({ container: undefined });
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });

    expect(recorded.updates.some((u) => 'projectId' in u.body)).toBe(false);
  });

  test('a failed run reports its named cause and the detail', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.finish({
      ok: false,
      cancelled: false,
      failingStep: 'DEPLOY.PREFLIGHT_FAILED',
      errorMessage: 'STRIPE_KEY is not set for preview.',
      entities: [],
    });

    expect(recorded.updates.at(-1)).toEqual({
      buildId: 'bld_new',
      body: {
        state: 'failed',
        failingStep: 'DEPLOY.PREFLIGHT_FAILED',
        errorMessage: 'STRIPE_KEY is not set for preview.',
      },
    });
  });

  test('a run that deployed one service records the app and where it can be reached', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [
        { kind: 'postgres-database', id: 'db_1' },
        { kind: 'compute-service', id: 'app_1', url: 'https://storefront.example' },
      ],
    });

    expect(recorded.updates.at(-1)?.body).toEqual({
      state: 'succeeded',
      appId: 'app_1',
      deployedUrl: 'https://storefront.example',
    });
  });

  test('a run that deployed several services records neither — there is no one answer to record', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [
        { kind: 'compute-service', id: 'app_1', url: 'https://web.example' },
        { kind: 'compute-service', id: 'app_2', url: 'https://api.example' },
      ],
    });

    expect(recorded.updates.at(-1)?.body).toEqual({ state: 'succeeded' });
  });

  test('a service with no public address still records the app it deployed', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [{ kind: 'compute-service', id: 'app_1' }],
    });

    expect(recorded.updates.at(-1)?.body).toEqual({ state: 'succeeded', appId: 'app_1' });
  });

  test('finishing twice reports once — the signal path and the normal path cannot both land', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });
    await session?.finish({
      ok: false,
      cancelled: false,
      failingStep: 'X.Y',
      errorMessage: 'second',
      entities: [],
    });

    expect(recorded.updates.filter((u) => u.body.state !== 'running')).toHaveLength(1);
  });

  test('no service token means no session, and no complaint — the deploy fails for its own reason', async () => {
    const warnings: string[] = [];
    const session = await buildReporter({
      env: {},
      warn: (m) => warnings.push(m),
      refsOf,
    }).begin({
      appName: 'storefront',
      stage: undefined,
      cwd: import.meta.dir,
      reportId: undefined,
    });

    expect(session).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test('a run with no commit or branch says so, and reports nothing', async () => {
    const warnings: string[] = [];
    const { api, recorded } = fakeApi('bld_new');
    const session = await buildReporter({
      api,
      env: { PRISMA_SERVICE_TOKEN: 'token' },
      warn: (m) => warnings.push(m),
      refsOf,
    }).begin({ appName: 'storefront', stage: undefined, cwd: '/', reportId: undefined });

    expect(session).toBeUndefined();
    expect(recorded.creates).toEqual([]);
    expect(warnings.join('\n')).toContain('no commit and branch');
  });

  test('a build the platform would not create ends the session rather than reporting into nothing', async () => {
    const { api, recorded } = fakeApi(undefined);

    expect(await begin(api)).toBeUndefined();
    expect(recorded.updates).toEqual([]);
  });

  test('a platform that rejects the create ends the session without throwing', async () => {
    const warnings: string[] = [];
    const api: BuildsApi = {
      create: () => Promise.reject(new Error('the platform is unavailable')),
      update: async () => true,
      reportResource: async () => true,
    };

    expect(await begin(api, ENV, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings.join('\n')).toContain('the platform is unavailable');
  });

  test('a rejected terminal update does not reject finish', async () => {
    const warnings: string[] = [];
    const api: BuildsApi = {
      create: async () => 'bld_new',
      update: () => Promise.reject(new Error('the platform is unavailable')),
      reportResource: async () => true,
    };

    const session = await begin(api, ENV, (m) => warnings.push(m));
    // begin PATCHes running and already tolerates the rejection; finish must too.
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });
    expect(warnings.length).toBeGreaterThan(0);
  });
});
