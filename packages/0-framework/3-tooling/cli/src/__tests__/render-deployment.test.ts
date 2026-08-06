import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { service } from '@internal/core';
import type { DeployedNode, DeploymentResult } from '@internal/core/deploy';
import {
  DEPLOYMENT_RESULT_FILE_ENV,
  deploymentReport,
  renderDeployment,
  toDeploymentSummary,
} from '../render-deployment.ts';

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

  test("an entity's details render one labeled line each — a newline-holding value one line per entry (ADR-0042's input document + absent keys)", () => {
    const results = [
      deployed('web', [
        {
          kind: 'compute-service',
          id: 'cps_1',
          url: 'https://a.example',
          details: {
            input: '{"greeting":"hello","stripeKey":{"$secret":"STRIPE_SECRET_KEY"}}',
            absent: 'greeting → ENV_GREETING\nregion → ENV_REGION',
          },
        },
      ]),
    ];

    expect(renderDeployment(result('app', results))).toBe(
      [
        'app',
        '└─ web   compute-service cps_1',
        '         https://a.example',
        '         input {"greeting":"hello","stripeKey":{"$secret":"STRIPE_SECRET_KEY"}}',
        '         absent greeting → ENV_GREETING',
        '         absent region → ENV_REGION',
      ].join('\n'),
    );
  });

  test('an empty details value emits no line — the common zero-absent case renders nothing spurious', () => {
    const results = [
      deployed('web', [
        {
          kind: 'compute-service',
          id: 'cps_1',
          url: 'https://a.example',
          details: {
            input: '{"greeting":"hello"}',
            absent: '',
          },
        },
      ]),
    ];

    expect(renderDeployment(result('app', results))).toBe(
      [
        'app',
        '└─ web   compute-service cps_1',
        '         https://a.example',
        '         input {"greeting":"hello"}',
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

describe('toDeploymentSummary', () => {
  test('projects app + per-node address/entities, dropping the in-process node', () => {
    const input = result('app', [
      deployed('auth.api', [
        { kind: 'compute-service', id: 'cps_1', url: 'https://a.example' },
        { kind: 'postgres-database', id: 'pdb_1' },
      ]),
      deployed('db', []),
    ]);

    const summary = toDeploymentSummary(input);

    expect(summary).toEqual({
      app: 'app',
      nodes: [
        {
          address: 'auth.api',
          entities: [
            { kind: 'compute-service', id: 'cps_1', url: 'https://a.example' },
            { kind: 'postgres-database', id: 'pdb_1' },
          ],
        },
        { address: 'db', entities: [] },
      ],
    });
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    for (const node of summary.nodes) {
      expect('node' in node).toBe(false);
    }
  });
});

describe('deploymentReport', () => {
  const envKeeper = process.env[DEPLOYMENT_RESULT_FILE_ENV];
  afterEach(() => {
    if (envKeeper === undefined) {
      delete process.env[DEPLOYMENT_RESULT_FILE_ENV];
    } else {
      process.env[DEPLOYMENT_RESULT_FILE_ENV] = envKeeper;
    }
  });

  test('prints a leading blank line then the rendered tree', () => {
    delete process.env[DEPLOYMENT_RESULT_FILE_ENV];
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

  test(`writes the JSON summary to the file named by ${DEPLOYMENT_RESULT_FILE_ENV}, printing the same output`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-report-'));
    const file = path.join(dir, 'deployment-result.json');
    process.env[DEPLOYMENT_RESULT_FILE_ENV] = file;
    const input = result('app', [deployed('db', [{ kind: 'postgres-database', id: 'pdb_1' }])]);
    const lines: unknown[] = [];
    const original = console.log;
    console.log = (value?: unknown) => {
      lines.push(value);
    };
    try {
      deploymentReport(input);
    } finally {
      console.log = original;
    }

    expect(lines).toEqual(['', 'app\n└─ db   postgres-database pdb_1']);
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed).toEqual(toDeploymentSummary(input) as never);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes no file when the env var is unset', () => {
    delete process.env[DEPLOYMENT_RESULT_FILE_ENV];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-report-'));
    const original = console.log;
    console.log = () => {};
    try {
      deploymentReport(result('app', []));
    } finally {
      console.log = original;
    }

    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
