import { describe, expect, test } from 'bun:test';
import type { ContainerInstance } from '@internal/core/config';
import type { BuildsApi, CreateBuildBody, UpdateBuildBody } from '../builds/api.ts';
import { type BuildReportAnchors, buildReporter } from '../builds/reporter.ts';

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

/** Stands in for the extension's own container; the reporter only ever sees it through `anchorsOf`. */
const CONTAINER = { projectId: 'proj_1', branchId: 'branch_1' };
const anchorsOf = (container: ContainerInstance): BuildReportAnchors =>
  container as unknown as BuildReportAnchors;

const begin = (
  api: BuildsApi,
  env: Record<string, string | undefined> = ENV,
  warn: (message: string) => void = () => {},
) =>
  buildReporter({ api, env, warn, anchorsOf }).begin({
    appName: 'storefront',
    stage: undefined,
    cwd: import.meta.dir,
  });

describe('buildReporter', () => {
  test('creates a build and marks it running in the deploy phase', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.finish({ ok: true, failingStep: undefined, errorMessage: undefined });

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
    await session?.finish({ ok: true, failingStep: undefined, errorMessage: undefined });

    expect(recorded.creates).toEqual([]);
    expect(recorded.updates.every((u) => u.buildId === 'bld_from_action')).toBe(true);
    // The creator's own link to its logs is never overwritten.
    expect(recorded.updates.some((u) => 'externalLogUrl' in u.body)).toBe(false);
  });

  test('passes the build id into the apply, so the state store reports against it', async () => {
    const { api } = fakeApi('bld_new');

    const session = await begin(api);
    expect(session?.childEnv()).toEqual({ PRISMA_BUILD_ID: 'bld_new' });
    await session?.finish({ ok: true, failingStep: undefined, errorMessage: undefined });
  });

  test('attaches the project and branch on their own, so a rejection costs only the anchors', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.anchor({ container: CONTAINER as unknown as ContainerInstance });
    await session?.finish({ ok: true, failingStep: undefined, errorMessage: undefined });

    expect(recorded.updates[1]).toEqual({
      buildId: 'bld_new',
      body: { projectId: 'proj_1', branchId: 'branch_1' },
    });
  });

  test('an extension with no container has nothing to attach and sends nothing', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.anchor({ container: undefined });
    await session?.finish({ ok: true, failingStep: undefined, errorMessage: undefined });

    expect(recorded.updates.some((u) => 'projectId' in u.body)).toBe(false);
  });

  test('a failed run reports its named cause and the detail', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.finish({
      ok: false,
      failingStep: 'DEPLOY.PREFLIGHT_FAILED',
      errorMessage: 'STRIPE_KEY is not set for preview.',
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

  test('finishing twice reports once — the signal path and the normal path cannot both land', async () => {
    const { api, recorded } = fakeApi('bld_new');

    const session = await begin(api);
    await session?.finish({ ok: true, failingStep: undefined, errorMessage: undefined });
    await session?.finish({ ok: false, failingStep: 'X.Y', errorMessage: 'second' });

    expect(recorded.updates.filter((u) => u.body.state !== 'running')).toHaveLength(1);
  });

  test('no service token means no session, and no complaint — the deploy fails for its own reason', async () => {
    const warnings: string[] = [];
    const session = await buildReporter({
      env: {},
      warn: (m) => warnings.push(m),
      anchorsOf,
    }).begin({ appName: 'storefront', stage: undefined, cwd: import.meta.dir });

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
      anchorsOf,
    }).begin({ appName: 'storefront', stage: undefined, cwd: '/' });

    expect(session).toBeUndefined();
    expect(recorded.creates).toEqual([]);
    expect(warnings.join('\n')).toContain('no commit and branch');
  });

  test('a build the platform would not create ends the session rather than reporting into nothing', async () => {
    const { api, recorded } = fakeApi(undefined);

    expect(await begin(api)).toBeUndefined();
    expect(recorded.updates).toEqual([]);
  });
});
