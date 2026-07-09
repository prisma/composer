import { describe, expect, mock, test } from 'bun:test';
import type { LowerContext, LoweredNode } from '@makerkit/core/deploy';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';

// Stub the provider layer AND alchemy/Output so the compute target's data
// flow (id derivation, props threading, outputs shape) runs purely — no
// Alchemy engine, no cloud. Output.map just applies its function directly
// (real Output values are lazy expressions; here every "output" is already
// the resolved value the mock resource returned).
const recorded = {
  project: [] as unknown[][],
  envVar: [] as unknown[][],
  db: [] as unknown[][],
  conn: [] as unknown[][],
  svc: [] as unknown[][],
  deploy: [] as unknown[][],
  pkg: [] as unknown[][],
};

mock.module('alchemy/Output', () => ({
  map: (output: unknown, fn: (v: unknown) => unknown) => fn(output),
}));

mock.module('@makerkit/prisma-alchemy', () => ({
  providers: () => ({ stub: 'providers' }),
  Project: (id: string, props: unknown) => {
    recorded.project.push([id, props]);
    return Effect.succeed({ id: `${id}#cloud-id`, name: id });
  },
  EnvironmentVariable: (id: string, props: { key: string }) => {
    recorded.envVar.push([id, props]);
    return Effect.succeed({ id: `${id}#cloud-id`, key: props.key });
  },
  Database: (id: string, props: unknown) => {
    recorded.db.push([id, props]);
    return Effect.succeed({ id: `${id}#cloud-id`, name: id });
  },
  Connection: (id: string, props: unknown) => {
    recorded.conn.push([id, props]);
    return Effect.succeed({
      id: `${id}#cloud-id`,
      connectionString: Redacted.make(`postgres://${id}`),
    });
  },
  ComputeService: (id: string, props: unknown) => {
    recorded.svc.push([id, props]);
    return Effect.succeed({ id: `${id}#cloud-id`, name: id });
  },
  Deployment: (id: string, props: unknown) => {
    recorded.deploy.push([id, props]);
    return Effect.succeed({ versionId: 'v1', deployedUrl: `https://${id}.example` });
  },
  packageComputeArtifact: (opts: { id: string }) => {
    recorded.pkg.push([opts]);
    return { path: `/tmp/${opts.id}.tar.gz`, sha256: `sha-${opts.id}` };
  },
}));

const { prismaCloud } = await import('../target.ts');
const { compute } = await import('../index.ts');
const { postgres } = await import('../index.ts');

const run = <A>(eff: Effect.Effect<A, unknown, unknown>): A =>
  Effect.runSync(eff as Effect.Effect<A>);

describe('prismaCloud().application.provision', () => {
  test('provisions one Project and poisons DATABASE_URL + DATABASE_URL_POOLED with "-"', () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });

    const result = run<LoweredNode>(
      target.application.provision({ opts: { name: 'shop' } } as unknown as LowerContext),
    );

    expect(result.outputs).toEqual({ projectId: 'shop-project#cloud-id' });
    expect(recorded.project).toEqual([['shop-project', { workspaceId: 'ws_1', name: 'shop' }]]);
    // "-", not "": the API rejects empty env-var values (verified at the R4 deploy proof).
    expect(recorded.envVar).toEqual([
      [
        'DATABASE_URL-poison',
        {
          projectId: 'shop-project#cloud-id',
          key: 'DATABASE_URL',
          value: '-',
          class: 'production',
        },
      ],
      [
        'DATABASE_URL_POOLED-poison',
        {
          projectId: 'shop-project#cloud-id',
          key: 'DATABASE_URL_POOLED',
          value: '-',
          class: 'production',
        },
      ],
    ]);
  });
});

describe("prismaCloud().resources['postgres']", () => {
  test("creates a Database + Connection in the application's project; url unwraps the Redacted connection string", () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const ctx = {
      id: 'auth.db',
      application: { outputs: { projectId: 'shop-project#cloud-id' } },
    } as unknown as LowerContext;

    const result = run<LoweredNode>(target.resources['postgres']!(ctx));

    expect(result.outputs).toEqual({ url: 'postgres://auth.db-conn' });
    expect(recorded.db).toEqual([
      ['auth.db-db', { projectId: 'shop-project#cloud-id', name: 'auth.db', region: 'us-east-1' }],
    ]);
    expect(recorded.conn).toEqual([
      ['auth.db-conn', { databaseId: 'auth.db-db#cloud-id', name: 'auth.db' }],
    ]);
  });
});

describe("prismaCloud().services['compute']", () => {
  test("provision creates a ComputeService inside the application's project", () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const ctx = {
      id: 'auth',
      application: { outputs: { projectId: 'shop-project#cloud-id' } },
    } as unknown as LowerContext;

    const result = run<LoweredNode>(target.services['compute']!.provision(ctx));

    expect(result.outputs).toEqual({
      serviceId: 'auth-svc#cloud-id',
      projectId: 'shop-project#cloud-id',
    });
    expect(recorded.svc).toEqual([
      ['auth-svc', { projectId: 'shop-project#cloud-id', name: 'auth', region: 'us-east-1' }],
    ]);
  });

  test('serialize writes one env var per Config leaf, keyed by configKey(address, decl)', () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const node = compute({
      name: 'test-service',
      deps: {
        db: postgres({
          name: 'test-resource',
          client: ({ url }) => ({ url }),
        }),
      },
      build: {
        kind: 'node',
        pack: '@makerkit/node',
        module: 'file:///test/service.ts',
        entry: 'server.js',
      },
    });
    const ctx = { address: 'auth', node } as unknown as LowerContext;
    const provisioned: LoweredNode = {
      outputs: { serviceId: 'auth-svc#cloud-id', projectId: 'shop-project#cloud-id' },
    };
    const config = { service: { port: 3000 }, inputs: { db: { url: 'postgres://real-db' } } };

    const result = run<LoweredNode>(
      target.services['compute']!.serialize(ctx, provisioned, config),
    );

    expect(recorded.envVar.slice(-2)).toEqual([
      [
        'AUTH_DB_URL-var',
        {
          projectId: 'shop-project#cloud-id',
          key: 'AUTH_DB_URL',
          value: 'postgres://real-db',
          class: 'production',
        },
      ],
      // The concrete numeric leaf is encoded typed→string ("3000", not 3000):
      // the ConfigVariable value field is string-typed, and deserialize reads
      // it back to a number (round-tripped in pack.test.ts).
      [
        'AUTH_PORT-var',
        {
          projectId: 'shop-project#cloud-id',
          key: 'AUTH_PORT',
          value: '3000',
          class: 'production',
        },
      ],
    ]);
    expect(result.outputs['environment']).toEqual([
      { id: 'AUTH_DB_URL-var#cloud-id', key: 'AUTH_DB_URL' },
      { id: 'AUTH_PORT-var#cloud-id', key: 'AUTH_PORT' },
    ]);
    // serialize also surfaces the resolved listen port for deploy() — the
    // Deployment must route to whatever the app binds, not a constant.
    expect(result.outputs['port']).toBe(3000);
  });

  test('serialize surfaces a non-default port so deploy routes to it', () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const node = compute({
      name: 'test-service',
      deps: {},
      build: {
        kind: 'node',
        pack: '@makerkit/node',
        module: 'file:///test/service.ts',
        entry: 'server.js',
      },
    });
    const ctx = { address: 'auth', node } as unknown as LowerContext;
    const provisioned: LoweredNode = { outputs: { projectId: 'shop-project#cloud-id' } };
    // A port other than the pack default: serialize must carry 8080 through,
    // not silently normalize it back to 3000.
    const config = { service: { port: 8080 }, inputs: {} };

    const result = run<LoweredNode>(
      target.services['compute']!.serialize(ctx, provisioned, config),
    );

    expect(result.outputs['port']).toBe(8080);
  });

  test("package delegates to prisma-alchemy's deterministic artifact packager", () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const ctx = { id: 'auth' } as unknown as LowerContext;

    const result = run(
      target.services['compute']!.package(ctx, {
        assembled: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' },
        address: 'auth',
      }),
    );

    expect(recorded.pkg).toEqual([
      [
        {
          id: 'auth',
          bundleDir: 'hexes/auth/dist/bundle',
          appEntry: 'server.js',
          address: 'auth',
        },
      ],
    ]);
    expect(result).toEqual({ path: '/tmp/auth.tar.gz', sha256: 'sha-auth' });
  });

  test("deploy's environment prop IS serialize's returned records — the edge that kills PRO-211", () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const ctx = { id: 'auth' } as unknown as LowerContext;
    const provisioned: LoweredNode = {
      outputs: { serviceId: 'auth-svc#cloud-id', projectId: 'shop-project#cloud-id' },
    };
    const artifact = { path: '/tmp/auth.tar.gz', sha256: 'sha-auth' };
    const serialized: LoweredNode = {
      outputs: {
        environment: [{ id: 'AUTH_DB_URL-var#cloud-id', key: 'AUTH_DB_URL' }],
        // A non-default port from serialize must reach the Deployment verbatim.
        port: 8080,
      },
    };

    const result = run<LoweredNode>(
      target.services['compute']!.deploy(ctx, provisioned, artifact, serialized),
    );

    expect(recorded.deploy).toEqual([
      [
        'auth-deploy',
        {
          computeServiceId: 'auth-svc#cloud-id',
          artifactPath: '/tmp/auth.tar.gz',
          artifactHash: 'sha-auth',
          environment: serialized.outputs['environment'],
          port: 8080,
        },
      ],
    ]);
    expect(result.outputs).toEqual({
      url: 'https://auth-deploy.example',
      projectId: 'shop-project#cloud-id',
    });
  });
});
