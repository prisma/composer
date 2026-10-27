/** `deploy list` through the engine, reading a fake Management API. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ManagementApiClient } from '@prisma/cli-engine';
import { createTestCli, mintTestJwt } from '@prisma/cli-engine/testing';
import { createComposerFamily } from '../src/exports/family.ts';
import { listDeployed } from '../src/family/list-deployed.ts';

/** The app directory: the engine's config file must exist there, though the test seeds its sections. */
const CWD = (() => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-deploy-list-')));
  fs.writeFileSync(path.join(dir, 'prisma.config.ts'), '');
  return dir;
})();

/** An entry module in the app directory whose root module is named `name`. */
function entryNamed(name: string): string {
  const file = path.join(CWD, `${name}.ts`);
  fs.writeFileSync(
    file,
    `import { module } from ${JSON.stringify(import.meta.resolve('@prisma/composer'))};\n` +
      `export default module(${JSON.stringify(name)}, {}, () => ({}));\n`,
  );
  return file;
}

const ENTRY = entryNamed('shop');

interface FakeApi {
  readonly projects?: readonly unknown[];
  readonly branches?: readonly unknown[];
  readonly topology?: { readonly nodes: readonly unknown[] } | undefined;
  readonly services?: readonly unknown[];
  readonly databases?: readonly unknown[];
  readonly buckets?: readonly unknown[];
}

interface Request {
  readonly path: string;
  readonly params: unknown;
}

const page = (data: readonly unknown[] = []) => ({
  data,
  pagination: { nextCursor: null, hasMore: false },
});

function fakeClient(api: FakeApi, requests: Request[]): ManagementApiClient {
  const respond = (status: number, data?: unknown) => ({
    data: status === 200 ? data : undefined,
    error: status === 200 ? undefined : { message: 'not found' },
    response: new Response(null, { status }),
  });
  const bodies: Record<string, () => ReturnType<typeof respond>> = {
    '/v1/projects': () => respond(200, page(api.projects)),
    '/v1/projects/{projectId}/branches': () => respond(200, page(api.branches)),
    '/v1/projects/{projectId}/branches/{branchId}/application-topology': () =>
      api.topology === undefined ? respond(404) : respond(200, { data: api.topology }),
    '/v1/services': () => respond(200, page(api.services)),
    '/v1/databases': () => respond(200, page(api.databases)),
    '/v1/buckets': () => respond(200, page(api.buckets)),
  };
  return {
    GET: async (route: string, options: { params: unknown }) => {
      requests.push({ path: route, params: options.params });
      const body = bodies[route];
      if (body === undefined) throw new Error(`unexpected GET ${route}`);
      return body();
    },
  } as unknown as ManagementApiClient;
}

const COMPOSER_CONFIG = {
  entry: ENTRY,
  extensions: [{ id: 'ext-a', nodes: {} }],
  state: {
    extension: 'ext-a',
    create: (): never => {
      throw new Error('deploy list reads no state');
    },
  },
};

function cliWith(api: FakeApi, requests: Request[] = []) {
  const family = createComposerFamily();
  const command = family.commands['deploy list'];
  const deploy = family.commands['deploy'];
  if (command === undefined || deploy === undefined) throw new Error('no deploy list command');
  return createTestCli({
    commandFamilies: [family],
    commands: { deploy, 'deploy list': command },
    groups: { deploy: { brief: 'Deploy the app.' } },
    config: { composer: COMPOSER_CONFIG },
    credential: {
      token: mintTestJwt({
        sub: 'user_1',
        workspace_id: 'ws_1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      refreshToken: undefined,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    managementApi: { client: fakeClient(api, requests) },
  });
}

const project = {
  id: 'proj_1',
  name: 'shop',
  createdAt: '2026-10-01T00:00:00Z',
  workspace: { id: 'wksp_ws_1' },
  logicalId: 'shop',
};

const deployed: FakeApi = {
  projects: [project],
  branches: [{ id: 'br_default', isDefault: true }],
  topology: {
    nodes: [
      { logicalId: 'shop', parentLogicalId: null, kind: 'module' },
      { logicalId: 'shop.api', parentLogicalId: 'shop', kind: 'service' },
      { logicalId: 'shop.catalog', parentLogicalId: 'shop', kind: 'module' },
      {
        logicalId: 'shop.catalog.db',
        parentLogicalId: 'shop.catalog',
        kind: 'resource',
        type: 'postgres',
      },
      { logicalId: 'shop.files', parentLogicalId: 'shop', kind: 'resource', type: 's3' },
    ],
  },
  services: [
    {
      id: 'svc_1',
      logicalId: 'shop.api',
      appEndpointDomain: 'https://api.prisma.app',
      branchId: 'br_default',
    },
  ],
  databases: [{ id: 'db_1', logicalId: 'shop.catalog.db', branchId: 'br_default' }],
  buckets: [{ id: 'bkt_1', logicalId: 'shop.files', branchId: 'br_default' }],
};

const listed = [
  { address: 'shop', kind: 'project', platformId: 'proj_1', url: null },
  { address: 'shop.api', kind: 'service', platformId: 'svc_1', url: 'https://api.prisma.app' },
  { address: 'shop.catalog', kind: 'module', platformId: null, url: null },
  { address: 'shop.catalog.db', kind: 'postgres', platformId: 'db_1', url: null },
  { address: 'shop.files', kind: 'bucket', platformId: 'bkt_1', url: null },
];

describe('deploy list', () => {
  test('the published family ships it', () => {
    expect(Object.keys(createComposerFamily().commands)).toContain('deploy list');
  });

  test('lists every node of production with its platform ID and URL as the JSON result', async () => {
    const requests: Request[] = [];
    const cli = cliWith(deployed, requests);

    const result = await cli.run(['deploy', 'list', '--json'], { cwd: CWD });

    expect(result.exitCode).toBe(0);
    expect(result.json.at(-1)).toMatchObject({ envelope: { ok: true, result: listed } });
    expect(requests.find((r) => r.path === '/v1/services')?.params).toEqual({
      query: { projectId: 'proj_1', branchId: 'br_default' },
    });
  });

  test('finds a named environment by its Branch', async () => {
    const requests: Request[] = [];
    const cli = cliWith({ ...deployed, branches: [{ id: 'br_pr42' }] }, requests);

    const result = await cli.run(['deploy', 'list', '--environment', 'pr-42', '--json'], {
      cwd: CWD,
    });

    expect(result.exitCode).toBe(0);
    expect(
      requests.find((r) => r.path === '/v1/projects/{projectId}/branches')?.params,
    ).toMatchObject({ query: { gitName: 'pr-42' } });
    expect(requests.find((r) => r.path.endsWith('/application-topology'))?.params).toEqual({
      path: { projectId: 'proj_1', branchId: 'br_pr42' },
    });
  });

  test('rejects --stage as an unknown flag', async () => {
    const requests: Request[] = [];
    const cli = cliWith(deployed, requests);

    const result = await cli.run(['deploy', 'list', '--stage', 'pr-42', '--json'], { cwd: CWD });

    expect(result.exitCode).toBe(2);
    expect(result.json.at(-1)).toMatchObject({
      envelope: { ok: false, error: { code: 'CLI.INVALID_ARGUMENTS' } },
    });
    expect(requests).toEqual([]);
  });

  test('refuses a name whose Branch is the default Branch, telling the user to use production', async () => {
    const cli = cliWith({ ...deployed, branches: [{ id: 'br_default', isDefault: true }] });

    const result = await cli.run(['deploy', 'list', '--environment', 'main', '--json'], {
      cwd: CWD,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.json.at(-1)).toMatchObject({
      envelope: {
        ok: false,
        error: {
          code: 'DEPLOY.CONTAINER_FAILED',
          summary: expect.stringContaining('Use the environment production for it'),
        },
      },
    });
  });

  test('rejects an invalid --environment with DEPLOY.ENVIRONMENT_INVALID before any lookup', async () => {
    const requests: Request[] = [];
    const cli = cliWith(deployed, requests);

    const result = await cli.run(['deploy', 'list', '--environment', 'foo..bar', '--json'], {
      cwd: CWD,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.json.at(-1)).toMatchObject({
      envelope: { ok: false, error: { code: 'DEPLOY.ENVIRONMENT_INVALID' } },
    });
    expect(requests).toEqual([]);
  });

  test('loads the app from --entry', async () => {
    const cli = cliWith({
      ...deployed,
      projects: [{ ...project, id: 'proj_3', logicalId: 'shop-c' }],
    });

    const result = await cli.run(['deploy', 'list', '--entry', entryNamed('shop-c'), '--json'], {
      cwd: CWD,
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.at(-1)).toMatchObject({
      envelope: { ok: true, result: [{ ...listed[0], platformId: 'proj_3' }, ...listed.slice(1)] },
    });
  });

  test('looks the app up under --name', async () => {
    const cli = cliWith({
      ...deployed,
      projects: [{ ...project, id: 'proj_2', logicalId: 'shop-b' }],
    });

    const result = await cli.run(['deploy', 'list', '--name', 'shop-b', '--json'], { cwd: CWD });

    expect(result.exitCode).toBe(0);
    expect(result.json.at(-1)).toMatchObject({
      envelope: { ok: true, result: [{ ...listed[0], platformId: 'proj_2' }, ...listed.slice(1)] },
    });
  });

  test('writes one tab-separated line per node to stdout: address, kind, platform ID and URL', async () => {
    const cli = cliWith(deployed);

    const result = await cli.run(['deploy', 'list'], { cwd: CWD });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'shop\tproject\tproj_1\t\n' +
        'shop.api\tservice\tsvc_1\thttps://api.prisma.app\n' +
        'shop.catalog\tmodule\t\t\n' +
        'shop.catalog.db\tpostgres\tdb_1\t\n' +
        'shop.files\tbucket\tbkt_1\t\n',
    );
  });

  test('shows a table to a person', async () => {
    const cli = cliWith(deployed);

    const result = await cli.run(['deploy', 'list', '--format', 'human'], { cwd: CWD });

    expect(result.exitCode).toBe(0);
    const lines = result.stderr.split('\n');
    expect(lines[0]).toMatch(/^Address +Kind +Platform ID +URL$/);
    expect(lines).toContainEqual(expect.stringMatching(/^shop\.catalog\.db +postgres +db_1 +—$/));
    expect(lines).toContainEqual(
      expect.stringMatching(/^shop\.api +service +svc_1 +https:\/\/api\.prisma\.app$/),
    );
  });

  test('fails like deploy when the credential names no workspace', async () => {
    const requests: Request[] = [];

    const result = await listDeployed({
      config: { value: COMPOSER_CONFIG, file: path.join(CWD, 'prisma.config.ts') },
      entry: undefined,
      name: undefined,
      environment: 'production',
      cwd: CWD,
      workspaceId: undefined,
      client: fakeClient(deployed, requests),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('DEPLOY.CONTAINER_FAILED');
    expect(result.failure.message).toBe('environment variable PRISMA_WORKSPACE_ID is required.');
    expect(requests).toEqual([]);
  });

  test.each([
    [
      'no Project',
      { ...deployed, projects: [] },
      [],
      'Nothing deployed for shop in the environment production.',
    ],
    [
      'no Branch',
      { ...deployed, branches: [] },
      ['--environment', 'pr-42'],
      'Nothing deployed for shop in the environment pr-42.',
    ],
    [
      'no topology',
      { ...deployed, topology: undefined },
      [],
      'Nothing deployed for shop in the environment production.',
    ],
    [
      'a topology with no nodes',
      { ...deployed, topology: { nodes: [] } },
      [],
      'Nothing deployed for shop in the environment production.',
    ],
  ] as const)(
    'fails with DEPLOY.TARGET_NOT_FOUND when there is %s',
    async (_case, api, flags, message) => {
      const cli = cliWith(api);

      const result = await cli.run(['deploy', 'list', ...flags, '--json'], { cwd: CWD });

      expect(result.exitCode).not.toBe(0);
      expect(result.json.at(-1)).toMatchObject({
        envelope: { ok: false, error: { code: 'DEPLOY.TARGET_NOT_FOUND', summary: message } },
      });
    },
  );
});
