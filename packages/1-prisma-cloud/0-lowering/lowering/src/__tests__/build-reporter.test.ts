import { describe, expect, test } from 'bun:test';
import { type Contract, Load, module, resource } from '@internal/core';
import type { ContainerInstance } from '@internal/core/config';
import type { BuildsApi, CreateBuildBody, UpdateBuildBody } from '../builds/api.ts';
import {
  type ApplicationTopologyApi,
  type ApplicationTopologyBody,
  applicationTopologyContentHash,
  composeApplicationTopology,
} from '../builds/application-topology.ts';
import { type BuildContainerRefs, buildReporter } from '../builds/reporter.ts';

const ENV = {
  PRISMA_SERVICE_TOKEN: 'token',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF_NAME: 'main',
};

/** A real loaded graph — one resource under the root — so the topology on the wire comes from Load's authored view, not a hand-built stand-in. */
const dbContract: Contract<'fake/db', undefined> = {
  kind: 'fake/db',
  __cmp: undefined,
  satisfies: (required) => required.kind === 'fake/db',
};
const GRAPH = Load(
  module('storefront', ({ provision }) => {
    provision(resource({ name: 'db', extension: 'test/pack', provides: dbContract }));
  }),
);
const TOPOLOGY = composeApplicationTopology(GRAPH);
const CONTENT_HASH = applicationTopologyContentHash(TOPOLOGY);

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

interface RecordedTopology {
  replaces: {
    projectId: string;
    branchId: string;
    submission: ApplicationTopologyBody & { contentHash: string };
  }[];
}

function fakeTopology(landed = true): {
  topology: ApplicationTopologyApi;
  recordedTopology: RecordedTopology;
} {
  const recordedTopology: RecordedTopology = { replaces: [] };
  return {
    recordedTopology,
    topology: {
      replace: async (projectId, branchId, submission) => {
        recordedTopology.replaces.push({ projectId, branchId, submission });
        return landed;
      },
    },
  };
}

/** Stands in for the extension's own container; the reporter only ever sees it through `refsOf`. */
const CONTAINER = { projectId: 'proj_1', branchId: 'branch_1', stageBranchId: 'branch_1' };
const refsOf = (container: ContainerInstance): BuildContainerRefs =>
  container as unknown as BuildContainerRefs;

const begin = (
  api: BuildsApi,
  env: Record<string, string | undefined> = ENV,
  warn: (message: string) => void = () => {},
  reportId: string | undefined = undefined,
  topology: ApplicationTopologyApi = fakeTopology().topology,
) =>
  buildReporter({ api, env, warn, refsOf, topology }).begin({
    appName: 'storefront',
    graph: GRAPH,
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

  test('attaches the project, branch, and topology hash in one update, apart from progress', async () => {
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
      body: {
        projectId: 'proj_1',
        branchId: 'branch_1',
        applicationTopologyContentHash: CONTENT_HASH,
      },
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
      graph: GRAPH,
      stage: undefined,
      cwd: import.meta.dir,
      reportId: undefined,
    });

    expect(session).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test('a run with no commit or branch says so, reports no build — and still submits the topology', async () => {
    const warnings: string[] = [];
    const { api, recorded } = fakeApi('bld_new');
    const { topology, recordedTopology } = fakeTopology();
    const session = await buildReporter({
      api,
      topology,
      env: { PRISMA_SERVICE_TOKEN: 'token' },
      warn: (m) => warnings.push(m),
      refsOf,
    }).begin({
      appName: 'storefront',
      graph: GRAPH,
      stage: undefined,
      cwd: '/',
      reportId: undefined,
    });
    await session?.attach({ container: CONTAINER as unknown as ContainerInstance });
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });

    expect(recorded.creates).toEqual([]);
    expect(recorded.updates).toEqual([]);
    expect(warnings.join('\n')).toContain('no commit and branch');
    expect(session?.childEnv()).toEqual({});
    // The declared topology depends on no repository.
    expect(recordedTopology.replaces).toHaveLength(1);
  });

  test('a build the platform would not create reports nothing into it — but the topology still lands', async () => {
    const { api, recorded } = fakeApi(undefined);
    const { topology, recordedTopology } = fakeTopology();

    const session = await begin(api, ENV, () => {}, undefined, topology);
    await session?.attach({ container: CONTAINER as unknown as ContainerInstance });

    expect(recorded.updates).toEqual([]);
    expect(session?.childEnv()).toEqual({});
    expect(recordedTopology.replaces).toHaveLength(1);
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

  test('attach replaces the stage Branch topology once and stamps the build with its content hash', async () => {
    const { api, recorded } = fakeApi('bld_new');
    const { topology, recordedTopology } = fakeTopology();

    const session = await begin(api, ENV, () => {}, undefined, topology);
    await session?.attach({ container: CONTAINER as unknown as ContainerInstance });
    await session?.finish({
      ok: true,
      cancelled: false,
      failingStep: undefined,
      errorMessage: undefined,
      entities: [],
    });

    expect(recordedTopology.replaces).toEqual([
      {
        projectId: 'proj_1',
        branchId: 'branch_1',
        submission: { contentHash: CONTENT_HASH, ...TOPOLOGY },
      },
    ]);
    // The submitted body is the authored graph: stated containment, the
    // resource's reserved $out port, logical ids throughout.
    expect(recordedTopology.replaces[0]?.submission.nodes).toEqual([
      { logicalId: 'db', parentLogicalId: 'storefront', kind: 'resource', type: 'fake/db' },
      { logicalId: 'storefront', parentLogicalId: null, kind: 'module' },
    ]);
    expect(recordedTopology.replaces[0]?.submission.ports).toEqual([
      { logicalId: 'db', direction: 'out', name: '$out', contractKind: 'fake/db' },
    ]);
    // The hash rides the attach update — until the platform accepts the
    // field, a hash-only body would be stripped empty and rejected
    // ("at least one field must be given"; observed live 2026-08-21).
    expect(recorded.updates).toContainEqual({
      buildId: 'bld_new',
      body: {
        projectId: 'proj_1',
        branchId: 'branch_1',
        applicationTopologyContentHash: CONTENT_HASH,
      },
    });
  });

  test('a container that resolves no stage Branch submits nowhere, but the build still records the hash', async () => {
    const { api, recorded } = fakeApi('bld_new');
    const { topology, recordedTopology } = fakeTopology();

    const session = await begin(api, ENV, () => {}, undefined, topology);
    await session?.attach({
      container: { projectId: 'proj_1', branchId: undefined } as unknown as ContainerInstance,
    });

    expect(recordedTopology.replaces).toEqual([]);
    expect(recorded.updates).toContainEqual({
      buildId: 'bld_new',
      body: { projectId: 'proj_1', applicationTopologyContentHash: CONTENT_HASH },
    });
  });

  test('a submission the platform refused still leaves the hash on the build — a value match, not a reference', async () => {
    const { api, recorded } = fakeApi('bld_new');
    const { topology } = fakeTopology(false);

    const session = await begin(api, ENV, () => {}, undefined, topology);
    await session?.attach({ container: CONTAINER as unknown as ContainerInstance });

    expect(recorded.updates).toContainEqual({
      buildId: 'bld_new',
      body: {
        projectId: 'proj_1',
        branchId: 'branch_1',
        applicationTopologyContentHash: CONTENT_HASH,
      },
    });
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
