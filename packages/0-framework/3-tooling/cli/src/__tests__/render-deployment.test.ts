import { describe, expect, test } from 'bun:test';
import { service } from '@internal/core';
import type { DeployedNode, DeploymentResult } from '@internal/core/deploy';
import { deploymentReport, renderDeployment } from '../exports/render-deployment.ts';

/**
 * The renderer reads only `address` and `entities` — `node` is along for the
 * ride (it is what makes a deployed node joinable to the graph). A real
 * ServiceNode rather than a stub, so these fixtures cannot drift from the type.
 */
const deployed = (address: string, entities: DeployedNode['entities']): DeployedNode => ({
  address,
  node: service({
    name: address,
    extension: 'test/pack',
    type: 'compute',
    inputs: {},
    params: {},
    build: {
      extension: '@prisma/composer/node',
      type: 'node',
      module: 'file:///test/service.ts',
      entry: 'server.js',
    },
  }),
  entities,
});

const result = (app: string, nodes: readonly DeployedNode[]): DeploymentResult => ({ app, nodes });

describe('renderDeployment', () => {
  test('renders the pinned tree: nested addresses, aligned entities, urls on their own line', () => {
    const results = [
      deployed('auth.api', [
        { kind: 'compute-service', id: 'cps_abc123', url: 'https://xyz.ewr.prisma.build' },
      ]),
      deployed('db', [{ kind: 'postgres-database', id: 'pdb_def456' }]),
      deployed('web', [
        { kind: 'compute-service', id: 'cps_ghi789', url: 'https://uvw.ewr.prisma.build' },
      ]),
    ];

    expect(renderDeployment(result('storefront-auth', results))).toBe(
      [
        'storefront-auth',
        '├─ auth',
        '│  └─ api   compute-service cps_abc123',
        '│           https://xyz.ewr.prisma.build',
        '├─ db       postgres-database pdb_def456',
        '└─ web      compute-service cps_ghi789',
        '            https://uvw.ewr.prisma.build',
      ].join('\n'),
    );
  });

  test('a node that reported no entities is listed, not silently dropped — it deployed, it just published nothing', () => {
    const results = [
      deployed('creds', []),
      deployed('store', [{ kind: 'compute-service', id: 'cps_1' }]),
    ];

    expect(renderDeployment(result('app', results))).toBe(
      ['app', '├─ creds   (no entities reported)', '└─ store   compute-service cps_1'].join('\n'),
    );
  });

  test('an intermediate address segment is structure, not a deployed node — it carries no entity column', () => {
    // Only `auth.api` deployed; `auth` exists solely to hold it.
    const results = [deployed('auth.api', [{ kind: 'compute-service', id: 'cps_1' }])];

    expect(renderDeployment(result('app', results))).toBe(
      ['app', '└─ auth', '   └─ api   compute-service cps_1'].join('\n'),
    );
  });

  test('a node with several entities puts each on its own line, aligned under the first', () => {
    const results = [
      deployed('svc', [
        { kind: 'compute-service', id: 'cps_1', url: 'https://a.example' },
        { kind: 'postgres-database', id: 'pdb_1' },
      ]),
    ];

    expect(renderDeployment(result('app', results))).toBe(
      [
        'app',
        '└─ svc   compute-service cps_1',
        '         https://a.example',
        '         postgres-database pdb_1',
      ].join('\n'),
    );
  });

  test('the app name alone when nothing deployed', () => {
    expect(renderDeployment(result('app', []))).toBe('app');
  });

  test('deep nesting keeps every entity in one column', () => {
    const results = [
      deployed('a.b.c', [{ kind: 'compute-service', id: 'cps_1' }]),
      deployed('z', [{ kind: 'postgres-database', id: 'pdb_1' }]),
    ];

    expect(renderDeployment(result('app', results))).toBe(
      [
        'app',
        '├─ a',
        '│  └─ b',
        '│     └─ c   compute-service cps_1',
        '└─ z         postgres-database pdb_1',
      ].join('\n'),
    );
  });
});

describe('deploymentReport', () => {
  test('prints a leading blank line then the rendered tree', () => {
    const lines: unknown[] = [];
    const original = console.log;
    console.log = (value?: unknown) => {
      lines.push(value);
    };
    try {
      deploymentReport(
        result('app', [deployed('db', [{ kind: 'postgres-database', id: 'pdb_1' }])]),
      );
    } finally {
      console.log = original;
    }

    expect(lines).toEqual(['', 'app\n└─ db   postgres-database pdb_1']);
  });
});
