import { describe, expect, test } from 'bun:test';
import { Load, module } from '@internal/core';
import type { CliStructuredError } from '@internal/foundation/errors';
import type { ManagementApiClient } from '@internal/lowering';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { PrismaCloudContainer } from '../container.ts';
import { runEnvironmentSetPreflight } from '../environment-set-preflight.ts';
import { compute } from '../exports/index.ts';
import { envParam, generatedParam } from '../param.ts';
import { envSecret } from '../secret.ts';

const schema: StandardSchemaV1 = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};
const graph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(
        compute({
          name: 'web',
          deps: {},
          input: schema,
          build: {
            extension: '@prisma/composer/node',
            type: 'node',
            module: 'file:///test/service.ts',
            entry: 'server.js',
          },
        }),
        {
          id: 'web',
          input: {
            token: envSecret('NAMED_SET_TOKEN'),
            greeting: envParam('NAMED_SET_GREETING'),
            generated: generatedParam(),
          },
        },
      );
    }),
  );

function platform(saved = false) {
  const writes: { path: string; body: unknown }[] = [];
  const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });
  const set = {
    id: 'envset_one',
    projectId: 'proj_one',
    name: 'previews',
    branches: [{ id: 'br_one' }],
    consoleUrl: 'https://console.prisma.io/ws/project/environment-variables?environmentSetId=one',
  };
  const client = {
    GET: async (path: string) =>
      path.endsWith('/environment-sets')
        ? ok({ data: [set], pagination: { hasMore: false, nextCursor: null } })
        : ok({
            data: {
              ...set,
              variables: [
                { key: 'NAMED_SET_TOKEN', isSet: saved, updatedAt: '2026-10-28T00:00:00Z' },
                { key: 'NAMED_SET_GREETING', isSet: saved, updatedAt: '2026-10-28T00:00:00Z' },
              ],
            },
          }),
    POST: async (path: string, options: { body: unknown }) => {
      writes.push({ path, body: options.body });
      return ok({ data: set });
    },
    PUT: async (path: string, options: { body: unknown }) => {
      writes.push({ path, body: options.body });
      return ok({ data: set });
    },
    PATCH: async (path: string, options: { body: unknown }) => {
      writes.push({ path, body: options.body });
      return ok({ data: { updatedAt: '2026-10-28T01:00:00Z' } });
    },
  } as unknown as ManagementApiClient;
  return { client, writes };
}
const container = new PrismaCloudContainer(
  { appName: 'app', environment: 'pr-42' },
  'proj_one',
  'br_one',
);

describe('named environment set preflight', () => {
  test('declares placeholders and defers missing configuration so the upload can finish', async () => {
    delete process.env['NAMED_SET_TOKEN'];
    delete process.env['NAMED_SET_GREETING'];
    const { client, writes } = platform();
    const failures: CliStructuredError[] = [];
    const result = await runEnvironmentSetPreflight(
      {
        graph: graph(),
        container,
        environment: 'pr-42',
        deferFailure: (failure) => failures.push(failure),
      },
      ({ environment }) => (environment.startsWith('pr-') ? 'previews' : 'production'),
      client,
    );
    expect(result.environmentSet?.missing).toEqual(['NAMED_SET_GREETING', 'NAMED_SET_TOKEN']);
    expect(writes[0]?.body).toEqual({
      name: 'previews',
      keys: ['NAMED_SET_GREETING', 'NAMED_SET_TOKEN'],
    });
    expect(failures[0]?.code).toBe('DEPLOY.CONFIGURATION_REQUIRED');
    expect(failures[0]?.message).not.toContain('generated');
  });

  test('fills only unset keys and keeps values out of the transport', async () => {
    process.env['NAMED_SET_TOKEN'] = 'shell-secret';
    process.env['NAMED_SET_GREETING'] = '';
    try {
      const { client, writes } = platform();
      const result = await runEnvironmentSetPreflight(
        { graph: graph(), container, environment: 'pr-42' },
        'previews',
        client,
      );
      expect(result.environmentSet?.missing).toEqual([]);
      expect(
        writes.filter((write) => write.path.includes('/variables/')).map((write) => write.body),
      ).toEqual([
        { value: '', onlyIfUnset: true },
        { value: 'shell-secret', onlyIfUnset: true },
      ]);
      expect(JSON.stringify(result.environmentSet)).not.toContain('shell-secret');
      const saved = platform(true);
      await runEnvironmentSetPreflight(
        { graph: graph(), container, environment: 'pr-42' },
        undefined,
        saved.client,
      );
      expect(saved.writes.some((write) => write.path.includes('/variables/'))).toBe(false);
    } finally {
      delete process.env['NAMED_SET_TOKEN'];
      delete process.env['NAMED_SET_GREETING'];
    }
  });
});

test('an unmanaged legacy DATABASE_URL requires explicit named-set adoption', async () => {
  const noBindings = Load(
    module('app', ({ provision }) => {
      provision(
        compute({
          name: 'web',
          deps: {},
          build: {
            extension: '@prisma/composer/node',
            type: 'node',
            module: 'file:///test/service.ts',
            entry: 'server.js',
          },
        }),
        { id: 'web' },
      );
    }),
  );
  const calls: string[] = [];
  const client = {
    GET: async (path: string) => {
      calls.push(path);
      return {
        data: {
          data: path.endsWith('/environment-sets')
            ? []
            : [{ key: 'DATABASE_URL', isManagedBySystem: false, branchId: null }],
          pagination: { hasMore: false, nextCursor: null },
        },
        response: new Response(null, { status: 200 }),
      };
    },
  } as unknown as ManagementApiClient;
  const result = await runEnvironmentSetPreflight(
    { graph: noBindings, container, environment: 'pr-42' },
    undefined,
    client,
  );
  expect(result.environmentSet).toBeUndefined();
  expect(calls).toEqual(['/v1/projects/{projectId}/environment-sets', '/v1/environment-variables']);
});
