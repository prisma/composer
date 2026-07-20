import { describe, expect, mock, test } from 'bun:test';
import type { Contract } from '@internal/core';
import type { NodeDescriptor } from '@internal/core/config';
import type { LowerContext, LoweredResult, Outputs } from '@internal/core/deploy';
// Import the REAL modules the mocks below stub, so each mock can spread them.
// This matters beyond convenience: `bun test` runs every test file in ONE
// process and `mock.module` is process-global. When the real module is already
// loaded, bun patches the listed exports in place and every other export
// survives for sibling test files; when it is NOT yet loaded, the factory
// REPLACES the module and a sibling's import of an unlisted export throws.
// Static-importing the real module here forces the survivable patch-in-place
// mode regardless of the (filesystem-dependent) test-file order.
import * as RealPrismaAlchemy from '@internal/lowering';
import * as RealOutput from 'alchemy/Output';
import { type } from 'arktype';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import type { ComputeProvisioned, ComputeSerialized } from '../descriptors/compute.ts';
import { computeDescriptor } from '../descriptors/compute.ts';
import type { S3StoreSerialized } from '../descriptors/s3-store.ts';
// shared.ts's only @internal/lowering import is type-only, so pulling
// projectIdOf in statically doesn't drag the mocked runtime module in early.
import {
  type CloudApplication,
  type ProviderParam,
  projectIdOf,
  type ResolvedCloudOptions,
} from '../descriptors/shared.ts';
import * as RealPgWarm from '../pg-warm-resource.ts';
import * as RealS3Credentials from '../s3-credentials-resource.ts';

// Stub the provider layer AND alchemy/Output so the compute target's data
// flow (id derivation, props threading, outputs shape) runs purely — no
// Alchemy engine, no cloud. Output.map just applies its function directly
// (real Output values are lazy expressions; here every "output" is already
// the resolved value the mock resource returned).
const recorded: {
  envVar: Array<[string, unknown]>;
  db: Array<[string, unknown]>;
  conn: Array<[string, unknown]>;
  warm: Array<[string, unknown]>;
  svc: Array<[string, unknown]>;
  deploy: Array<[string, unknown]>;
  pkg: Array<[unknown]>;
  serviceKey: Array<[string, unknown]>;
  creds: Array<[string, unknown]>;
} = {
  envVar: [],
  db: [],
  conn: [],
  warm: [],
  svc: [],
  deploy: [],
  pkg: [],
  serviceKey: [],
  creds: [],
};

mock.module('alchemy/Output', () => ({
  ...RealOutput,
  map: (output: unknown, fn: (v: unknown) => unknown) => fn(output),
  // Mirrors `map` above: every "output" here is already the resolved value a
  // mock resource returned, so combining them is just collecting the array.
  all: (...outs: unknown[]) => outs,
}));

mock.module('@internal/lowering', () => ({
  ...RealPrismaAlchemy,
  providers: () => ({ stub: 'providers' }),
  EnvironmentVariable: (id: string, props: { key: string }) => {
    recorded.envVar.push([id, props]);
    return Effect.succeed({ id: `${id}#cloud-id`, key: props.key });
  },
  // A real Alchemy Resource (needs the Stack service); stubbed so
  // application.provision's mint runs purely. The returned "value" is
  // derived from `id` (which itself carries the edge id), so distinct edges
  // are distinguishable in assertions.
  ServiceKey: (id: string, props: unknown) => {
    recorded.serviceKey.push([id, props]);
    return Effect.succeed({ value: `key-for-${id}` });
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
    return Effect.succeed({ deploymentId: 'v1', deployedUrl: `https://${id}.example` });
  },
  packageComputeArtifact: (opts: { id: string }) => {
    recorded.pkg.push([opts]);
    return { path: `/tmp/${opts.id}.tar.gz`, sha256: `sha-${opts.id}` };
  },
}));

// PgWarm is a real Alchemy Resource (needs the Stack service); stub it so the
// lowering's data flow runs purely. `reconcile` echoes the url, so the stub
// returns { url } — the same shape the lowering threads into outputs/migration.
mock.module('../pg-warm-resource.ts', () => ({
  ...RealPgWarm,
  PgWarm: (id: string, props: { url: unknown }) => {
    recorded.warm.push([id, props]);
    return Effect.succeed({ url: props.url });
  },
  PgWarmProvider: () => ({ stub: 'pg-warm-provider' }),
}));

// S3Credentials is a real Alchemy Resource (needs the Stack service); stub it
// so the credentials lowering's data flow runs purely. The real provider mints
// a random pair — fixed values here so assertions can name them.
mock.module('../s3-credentials-resource.ts', () => ({
  ...RealS3Credentials,
  S3Credentials: (id: string, props: unknown) => {
    recorded.creds.push([id, props]);
    return Effect.succeed({ accessKeyId: 'AKIA-STUB', secretAccessKey: 'secret-stub' });
  },
  S3CredentialsProvider: () => ({ stub: 's3-credentials-provider' }),
}));

const { prismaCloud } = await import('../exports/control.ts');
const { compute, envParam, envSecret, postgres, postgresContract, s3StoreService } = await import(
  '../exports/index.ts'
);
const { dependency, module, provisionNeed, secret, string } = await import('@internal/core');
const { lowering } = await import('@internal/core/deploy');
const { RPC_PEER_KEY } = await import('@internal/rpc');
const { STREAMS_API_KEY } = await import('../streams-keys.ts');

// The node registry erases each descriptor's P/S to `unknown`, so every hook
// hands back Effect<unknown>. `A` is the caller's claim about what the hook
// under test returns — asserted here, checked by the descriptor's own
// `satisfies` at its definition.
const run = <A>(eff: Effect.Effect<unknown, unknown, unknown>): A =>
  Effect.runSync(eff as Effect.Effect<A>);

// ——— The handoff shapes AS THE MOCKS ABOVE PRODUCE THEM.
//
// The real types describe the real world: `ComputeProvisioned.serviceId` is an
// `Output<string>` (a lazy reference that only resolves when Alchemy applies
// the stack), and `ComputeSerialized.environment` holds real
// `EnvironmentVariable` resources. The mocks at the top of this file collapse
// that laziness on purpose — `Output.map` applies its function directly, and
// each mock resource returns a plain object — so the hooks hand back resolved
// values here and nothing else.
//
// These mirror the real types with that collapse applied. Reusing the real
// types would re-assert `Output<string>` over a plain string, which is the
// exact type lie this slice removed from compute.ts.
//
// They are DERIVED from the real types rather than restated, so a renamed or
// retyped handoff field breaks here instead of leaving these asserting a shape
// that no longer exists. `run<A>` cannot catch that drift — it takes
// Effect<unknown>, so `A` is an unchecked caller assertion — which makes these
// definitions the only compile-time link back to the real types.
/** The mocks collapse Output<T> to T; nothing else about the real types changes. */
type Resolved<T> = T extends RealOutput.Output<infer U> ? U : T;
type Mirror<T> = { readonly [K in keyof T]: Resolved<T[K]> };
/** The mock EnvironmentVariable, standing in for the real resource. */
type MockedEnvironment = ReadonlyArray<{ id: string; key: string }>;

type MockedProvisioned = Mirror<ComputeProvisioned>;
type MockedSerialized = Omit<Mirror<ComputeSerialized>, 'environment'> & {
  readonly environment: MockedEnvironment;
};
type MockedS3StoreSerialized = Omit<Mirror<S3StoreSerialized>, 'environment'> & {
  readonly environment: MockedEnvironment;
};

/** Sets env vars for the duration of `fn`, restoring whatever was there before. */
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): Promise<T> {
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

// Typed accessors over the kind-discriminated registry — a wrong kind here is
// a test bug, so they throw rather than silently widen.
type Descriptor = ReturnType<typeof prismaCloud>;
function applicationOf(descriptor: Descriptor) {
  if (descriptor.application === undefined) throw new Error('expected an application hook');
  return descriptor.application;
}
function resourceDescriptorOf(ext: Descriptor, type: string) {
  const descriptor = ext.nodes[type];
  if (descriptor === undefined || descriptor.kind !== 'resource')
    throw new Error(`expected a resource descriptor for "${type}"`);
  return descriptor;
}
function serviceDescriptorOf(ext: Descriptor, type: string) {
  const descriptor = ext.nodes[type];
  if (descriptor === undefined || descriptor.kind !== 'service')
    throw new Error(`expected a service descriptor for "${type}"`);
  return descriptor;
}
const configFor = (descriptor: Descriptor) => ({
  extensions: [descriptor],
  state: () => {
    throw new Error('state() must not be called by lowering()');
  },
});

describe("projectIdOf — narrowing ctx.application to this extension's own product", () => {
  test("accepts this extension's own application product", () => {
    expect(projectIdOf({ projectId: 'shop-project-id' })).toBe('shop-project-id');
  });

  // ctx.application is `unknown`: core never reads the application hook's
  // product and cannot type it. Anything that isn't prisma-cloud's own product
  // — most importantly `undefined`, which is what core hands a node whose
  // extension declares no application hook — must fail here, naming the hook
  // that didn't run, rather than surfacing as `undefined` inside a deployed
  // service's env.
  test.each([
    ['undefined (the extension declared no application hook)', undefined],
    ['null', null],
    ['a non-object', 'shop-project-id'],
    ['an object without projectId', { branchId: 'b_1' }],
    ['an object whose projectId is not a string', { projectId: 42 }],
  ])('throws, naming the hook that must run, on %s', (_label, value) => {
    expect(() => projectIdOf(value)).toThrow(/prisma-cloud: ctx\.application/);
    expect(() => projectIdOf(value)).toThrow(/application hook must run before any node lowers/);
  });
});

describe('prismaCloud().application.provision (once-per-lowering hook)', () => {
  test('default stage: references PRISMA_PROJECT_ID (no Project minted), poisons DATABASE_URL + DATABASE_URL_POOLED with "-", class production, no branchId', async () => {
    await withEnv({ PRISMA_PROJECT_ID: 'shop-project-id', PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const before = recorded.envVar.length;

      const result = run<CloudApplication>(
        applicationOf(target).provision({ graph: { edges: [] } } as unknown as LowerContext),
      );

      expect(result).toEqual({ projectId: 'shop-project-id' });
      // "-", not "": the API rejects empty env-var values (verified at the R4 deploy proof).
      expect(recorded.envVar.slice(before)).toEqual([
        [
          'DATABASE_URL-poison',
          {
            projectId: 'shop-project-id',
            key: 'DATABASE_URL',
            value: '-',
            class: 'production',
          },
        ],
        [
          'DATABASE_URL_POOLED-poison',
          {
            projectId: 'shop-project-id',
            key: 'DATABASE_URL_POOLED',
            value: '-',
            class: 'production',
          },
        ],
      ]);
    });
  });

  test('named stage (PRISMA_BRANCH_ID set): poison env vars carry class "preview" and branchId', async () => {
    await withEnv({ PRISMA_PROJECT_ID: 'shop-project-id', PRISMA_BRANCH_ID: 'branch_1' }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const before = recorded.envVar.length;

      const result = run<CloudApplication>(
        applicationOf(target).provision({ graph: { edges: [] } } as unknown as LowerContext),
      );

      expect(result).toEqual({ projectId: 'shop-project-id' });
      expect(recorded.envVar.slice(before)).toEqual([
        [
          'DATABASE_URL-poison',
          {
            projectId: 'shop-project-id',
            key: 'DATABASE_URL',
            value: '-',
            class: 'preview',
            branchId: 'branch_1',
          },
        ],
        [
          'DATABASE_URL_POOLED-poison',
          {
            projectId: 'shop-project-id',
            key: 'DATABASE_URL_POOLED',
            value: '-',
            class: 'preview',
            branchId: 'branch_1',
          },
        ],
      ]);
    });
  });

  test('fails with the required-variable error when PRISMA_PROJECT_ID is missing', async () => {
    await withEnv({ PRISMA_PROJECT_ID: undefined, PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });

      expect(() =>
        run<CloudApplication>(applicationOf(target).provision({} as unknown as LowerContext)),
      ).toThrow(/PRISMA_PROJECT_ID/);
    });
  });
});

describe("prismaCloud().nodes['postgres'] — the resource descriptor", () => {
  test("creates a Database + Connection in the application's project; url unwraps the Redacted connection string", async () => {
    await withEnv({ PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      // ctx.id is the module provision id — one Database per provisioned resource.
      const ctx = {
        id: 'data',
        application: { projectId: 'shop-project#cloud-id' },
      } as unknown as LowerContext;

      const result = run<LoweredResult>(resourceDescriptorOf(target, 'postgres')(ctx));

      expect(result.outputs).toEqual({ url: 'postgres://data-conn' });
      // The entity carries NO `url`: a connection string is not a public
      // endpoint. The outputs above still carry one — same key, opposite
      // meaning, which is exactly why only the descriptor can decide.
      expect(result.entities).toEqual([{ kind: 'postgres-database', id: 'data-db#cloud-id' }]);
      expect(recorded.db).toEqual([
        ['data-db', { projectId: 'shop-project#cloud-id', name: 'data', region: 'us-east-1' }],
      ]);
      expect(recorded.conn).toEqual([
        ['data-conn', { databaseId: 'data-db#cloud-id', name: 'data' }],
      ]);
    });
  });

  test('named stage (PRISMA_BRANCH_ID set): Database is created with branchId', async () => {
    await withEnv({ PRISMA_BRANCH_ID: 'branch_1' }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const ctx = {
        id: 'data2',
        application: { projectId: 'shop-project#cloud-id' },
      } as unknown as LowerContext;
      const before = recorded.db.length;

      run<Outputs>(resourceDescriptorOf(target, 'postgres')(ctx));

      expect(recorded.db.slice(before)).toEqual([
        [
          'data2-db',
          {
            projectId: 'shop-project#cloud-id',
            name: 'data2',
            region: 'us-east-1',
            branchId: 'branch_1',
          },
        ],
      ]);
    });
  });
});

describe("prismaCloud().nodes['credentials'] — the resource descriptor", () => {
  test('reports NO entities — a minted keypair is secret material, and an entity is built to be printed', () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const ctx = { id: 'creds' } as unknown as LowerContext;

    const result = run<LoweredResult>(resourceDescriptorOf(target, 'credentials')(ctx));

    // The pair reaches consumers through the OUTPUTS — that is what they are for.
    expect(result.outputs).toEqual({
      accessKeyId: 'AKIA-STUB',
      secretAccessKey: 'secret-stub',
    });
    // It must never reach an entity. Entities get rendered to a terminal
    // and are the one channel with nothing publishable to say here.
    expect(result.entities).toEqual([]);
  });
});

describe("prismaCloud().nodes['compute'] — the service descriptor", () => {
  test("provision creates a ComputeService inside the application's project", async () => {
    await withEnv({ PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const ctx = {
        id: 'auth',
        application: { projectId: 'shop-project#cloud-id' },
      } as unknown as LowerContext;

      const result = run<MockedProvisioned>(serviceDescriptorOf(target, 'compute').provision(ctx));

      expect(result).toEqual({
        serviceId: 'auth-svc#cloud-id',
        projectId: 'shop-project#cloud-id',
      });
      expect(recorded.svc).toEqual([
        ['auth-svc', { projectId: 'shop-project#cloud-id', name: 'auth', region: 'us-east-1' }],
      ]);
    });
  });

  test('named stage (PRISMA_BRANCH_ID set): provision creates a ComputeService with branchId', async () => {
    await withEnv({ PRISMA_BRANCH_ID: 'branch_1' }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const ctx = {
        id: 'auth2',
        application: { projectId: 'shop-project#cloud-id' },
      } as unknown as LowerContext;
      const before = recorded.svc.length;

      run<MockedProvisioned>(serviceDescriptorOf(target, 'compute').provision(ctx));

      expect(recorded.svc.slice(before)).toEqual([
        [
          'auth2-svc',
          {
            projectId: 'shop-project#cloud-id',
            name: 'auth2',
            region: 'us-east-1',
            branchId: 'branch_1',
          },
        ],
      ]);
    });
  });

  test('serialize writes one env var per Config leaf, keyed by configKey(address, decl)', async () => {
    await withEnv({ PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const node = compute({
        name: 'test-service',
        deps: {
          db: postgres(),
        },
        build: {
          extension: '@prisma/composer/node',
          type: 'node',
          module: 'file:///test/service.ts',
          entry: 'server.js',
        },
      });
      const ctx = {
        address: 'auth',
        node,
        graph: { secrets: [], edges: [] },
        application: {},
      } as unknown as LowerContext;
      const provisioned = { serviceId: 'auth-svc#cloud-id', projectId: 'shop-project#cloud-id' };
      const config = { service: { port: 3000 }, inputs: { db: { url: 'postgres://real-db' } } };

      const result = run<MockedSerialized>(
        serviceDescriptorOf(target, 'compute').serialize(ctx, provisioned, config),
      );

      expect(recorded.envVar.slice(-2)).toEqual([
        [
          'COMPOSER_AUTH_DB_URL-var',
          {
            projectId: 'shop-project#cloud-id',
            key: 'COMPOSER_AUTH_DB_URL',
            value: 'postgres://real-db',
            class: 'production',
          },
        ],
        // The concrete numeric leaf is encoded typed→string ("3000", not 3000):
        // the ConfigVariable value field is string-typed, and deserialize reads
        // it back to a number (round-tripped in pack.test.ts).
        [
          'COMPOSER_AUTH_PORT-var',
          {
            projectId: 'shop-project#cloud-id',
            key: 'COMPOSER_AUTH_PORT',
            value: '3000',
            class: 'production',
          },
        ],
      ]);
      expect(result.environment).toEqual([
        { id: 'COMPOSER_AUTH_DB_URL-var#cloud-id', key: 'COMPOSER_AUTH_DB_URL' },
        { id: 'COMPOSER_AUTH_PORT-var#cloud-id', key: 'COMPOSER_AUTH_PORT' },
      ]);
      // serialize also surfaces the resolved listen port for deploy() — the
      // Deployment must route to whatever the app binds, not a constant.
      expect(result.port).toBe(3000);
    });
  });

  test('an optional connection param with no provisioned value writes NO env-var row; a provided one still does', async () => {
    await withEnv({ PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      // A dependency shaped like rpc()'s post-slice-1 connection: a required
      // url plus an optional serviceKey the deploy has not provisioned yet.
      const authDep = dependency({
        type: 'rpc',
        connection: {
          params: { url: string(), serviceKey: string({ optional: true }) },
          hydrate: (v) => v,
        },
      });
      const node = compute({
        name: 'test-service',
        deps: { auth: authDep },
        build: {
          extension: '@prisma/composer/node',
          type: 'node',
          module: 'file:///test/service.ts',
          entry: 'server.js',
        },
      });
      const ctx = {
        address: 'consumer',
        node,
        graph: { secrets: [], edges: [] },
        application: {},
      } as unknown as LowerContext;
      const provisioned = {
        serviceId: 'consumer-svc#cloud-id',
        projectId: 'shop-project#cloud-id',
      };
      // buildConfig resolves url from the wired provider; serviceKey has no value yet.
      const config = {
        service: { port: 3000 },
        inputs: { auth: { url: 'http://auth.internal', serviceKey: undefined } },
      };
      const before = recorded.envVar.length;

      run<MockedSerialized>(
        serviceDescriptorOf(target, 'compute').serialize(ctx, provisioned, config),
      );

      const writes = recorded.envVar.slice(before).map(([, props]) => props);
      // The provided url still writes its row...
      expect(writes).toContainEqual({
        projectId: 'shop-project#cloud-id',
        key: 'COMPOSER_CONSUMER_AUTH_URL',
        value: 'http://auth.internal',
        class: 'production',
      });
      // ...but the unprovisioned serviceKey writes none — no "value: Required" at deploy.
      const writtenKeys = writes.map((p) => (p as { key: string }).key);
      expect(writtenKeys).not.toContain('COMPOSER_CONSUMER_AUTH_SERVICEKEY');
    });
  });

  test('a secret slot serializes to a POINTER row — value is the bound platform NAME, never a value (ADR-0029)', async () => {
    await withEnv(
      // The real secret value is present in the deploy shell, proving it still
      // cannot reach the serialized row.
      { PRISMA_BRANCH_ID: undefined, STRIPE_SECRET_KEY: 'sk_live_should_not_leak' },
      () => {
        const target = prismaCloud({ workspaceId: 'ws_1' });
        const node = compute({
          name: 'ingest',
          deps: {},
          secrets: { stripeKey: secret() },
          build: {
            extension: '@prisma/composer/node',
            type: 'node',
            module: 'file:///test/service.ts',
            entry: 'server.js',
          },
        });
        // The root bound the slot to STRIPE_SECRET_KEY — it rides on graph.secrets.
        const graph = {
          secrets: [
            { serviceAddress: 'ingest', slot: 'stripeKey', source: envSecret('STRIPE_SECRET_KEY') },
          ],
          edges: [],
        };
        const ctx = {
          address: 'ingest',
          node,
          graph,
          application: {},
        } as unknown as LowerContext;
        const provisioned = { projectId: 'shop-project#cloud-id' };
        const config = { service: { port: 3000 }, inputs: {} };
        const before = recorded.envVar.length;

        run<MockedSerialized>(
          serviceDescriptorOf(target, 'compute').serialize(ctx, provisioned, config),
        );

        const writes = recorded.envVar.slice(before).map(([, props]) => props);
        // The pointer row holds the bound platform NAME, never a value.
        expect(writes).toContainEqual({
          projectId: 'shop-project#cloud-id',
          key: 'COMPOSER_INGEST_STRIPEKEY',
          value: 'STRIPE_SECRET_KEY',
          class: 'production',
        });
        // No serialized EnvironmentVariable output carries the secret's value.
        expect(JSON.stringify(writes)).not.toContain('sk_live');
      },
    );
  });

  test('an env-sourced param serializes a POINTER row — value is the bound platform NAME, never a value', async () => {
    await withEnv(
      // The real value is present in the deploy shell, proving it still cannot
      // reach the serialized row — buildConfig never resolved a source's value.
      { PRISMA_BRANCH_ID: undefined, APP_ORIGIN: 'https://should-not-leak.example.com' },
      () => {
        const target = prismaCloud({ workspaceId: 'ws_1' });
        const node = compute({
          name: 'web',
          deps: {},
          params: { appOrigin: string() },
          build: {
            extension: '@prisma/composer/node',
            type: 'node',
            module: 'file:///test/service.ts',
            entry: 'server.js',
          },
        });
        // The root bound the slot to APP_ORIGIN — it rides on graph.params.
        const graph = {
          secrets: [],
          params: [{ serviceAddress: 'web', slot: 'appOrigin', binding: envParam('APP_ORIGIN') }],
          edges: [],
        };
        const ctx = {
          address: 'web',
          node,
          graph,
          application: {},
        } as unknown as LowerContext;
        const provisioned = { projectId: 'shop-project#cloud-id' };
        // buildConfig resolved the param to the opaque ParamSource, unvalidated — exactly what
        // deploy.ts's resolveParam does for a source-bound param.
        const config = { service: { port: 3000, appOrigin: envParam('APP_ORIGIN') }, inputs: {} };
        const before = recorded.envVar.length;

        run<MockedSerialized>(
          serviceDescriptorOf(target, 'compute').serialize(ctx, provisioned, config),
        );

        const writes = recorded.envVar.slice(before).map(([, props]) => props);
        // The pointer row holds the bound platform NAME, never a value.
        expect(writes).toContainEqual({
          projectId: 'shop-project#cloud-id',
          key: 'COMPOSER_WEB_APPORIGIN',
          value: '@composer-param-pointer:APP_ORIGIN',
          class: 'production',
        });
        // No serialized EnvironmentVariable output carries the actual value.
        expect(JSON.stringify(writes)).not.toContain('should-not-leak');
      },
    );
  });

  test('a literal-bound param still serializes as a plain JSON-encoded value row (unchanged)', async () => {
    await withEnv({ PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const node = compute({
        name: 'web',
        deps: {},
        params: { appOrigin: string() },
        build: {
          extension: '@prisma/composer/node',
          type: 'node',
          module: 'file:///test/service.ts',
          entry: 'server.js',
        },
      });
      const graph = { secrets: [], params: [], edges: [] };
      const ctx = {
        address: 'web',
        node,
        graph,
        application: {},
      } as unknown as LowerContext;
      const provisioned = { projectId: 'shop-project#cloud-id' };
      const config = {
        service: { port: 3000, appOrigin: 'https://literal.example.com' },
        inputs: {},
      };
      const before = recorded.envVar.length;

      run<MockedSerialized>(
        serviceDescriptorOf(target, 'compute').serialize(ctx, provisioned, config),
      );

      const writes = recorded.envVar.slice(before).map(([, props]) => props);
      expect(writes).toContainEqual({
        projectId: 'shop-project#cloud-id',
        key: 'COMPOSER_WEB_APPORIGIN',
        value: '"https://literal.example.com"',
        class: 'production',
      });
    });
  });

  test('named stage (PRISMA_BRANCH_ID set): serialize writes env vars with class "preview" and branchId', async () => {
    await withEnv({ PRISMA_BRANCH_ID: 'branch_1' }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const node = compute({
        name: 'test-service',
        deps: {},
        build: {
          extension: '@prisma/composer/node',
          type: 'node',
          module: 'file:///test/service.ts',
          entry: 'server.js',
        },
      });
      const ctx = {
        address: 'auth3',
        node,
        graph: { secrets: [], edges: [] },
        application: {},
      } as unknown as LowerContext;
      const provisioned = { projectId: 'shop-project#cloud-id' };
      const config = { service: { port: 3000 }, inputs: {} };
      const before = recorded.envVar.length;

      run<MockedSerialized>(
        serviceDescriptorOf(target, 'compute').serialize(ctx, provisioned, config),
      );

      expect(recorded.envVar.slice(before)).toEqual([
        [
          'COMPOSER_AUTH3_PORT-var',
          {
            projectId: 'shop-project#cloud-id',
            key: 'COMPOSER_AUTH3_PORT',
            value: '3000',
            class: 'preview',
            branchId: 'branch_1',
          },
        ],
      ]);
    });
  });

  test('serialize surfaces a non-default port so deploy routes to it', async () => {
    await withEnv({ PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const node = compute({
        name: 'test-service',
        deps: {},
        build: {
          extension: '@prisma/composer/node',
          type: 'node',
          module: 'file:///test/service.ts',
          entry: 'server.js',
        },
      });
      const ctx = {
        address: 'auth',
        node,
        graph: { secrets: [], edges: [] },
        application: {},
      } as unknown as LowerContext;
      const provisioned = { projectId: 'shop-project#cloud-id' };
      // A port other than the pack default: serialize must carry 8080 through,
      // not silently normalize it back to 3000.
      const config = { service: { port: 8080 }, inputs: {} };

      const result = run<MockedSerialized>(
        serviceDescriptorOf(target, 'compute').serialize(ctx, provisioned, config),
      );

      expect(result.port).toBe(8080);
    });
  });

  test("package delegates to prisma-alchemy's deterministic artifact packager", () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const ctx = { id: 'auth' } as unknown as LowerContext;

    const result = run(
      serviceDescriptorOf(target, 'compute').package(ctx, {
        assembled: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
        address: 'auth',
      }),
    );

    expect(recorded.pkg).toEqual([
      [
        {
          id: 'auth',
          bundleDir: 'modules/auth/dist/bundle',
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
    const provisioned = { serviceId: 'auth-svc#cloud-id', projectId: 'shop-project#cloud-id' };
    const artifact = { path: '/tmp/auth.tar.gz', sha256: 'sha-auth' };
    const serialized = {
      environment: [{ id: 'COMPOSER_AUTH_DB_URL-var#cloud-id', key: 'COMPOSER_AUTH_DB_URL' }],
      // A non-default port from serialize must reach the Deployment verbatim.
      port: 8080,
    };

    const result = run<LoweredResult>(
      serviceDescriptorOf(target, 'compute').deploy(ctx, provisioned, artifact, serialized),
    );

    expect(recorded.deploy).toEqual([
      [
        'auth-deploy',
        {
          computeServiceId: 'auth-svc#cloud-id',
          artifactPath: '/tmp/auth.tar.gz',
          artifactHash: 'sha-auth',
          environment: serialized.environment,
          port: 8080,
        },
      ],
    ]);
    expect(result.outputs).toEqual({
      url: 'https://auth-deploy.example',
      projectId: 'shop-project#cloud-id',
    });
    // compute publishes its URL deliberately — a Compute service's deployed
    // endpoint IS public, and this descriptor is the only party that knows it.
    expect(result.entities).toEqual([
      {
        kind: 'compute-service',
        id: 'auth-svc#cloud-id',
        url: 'https://auth-deploy.example',
      },
    ]);
  });
});

describe("prismaCloud().nodes['s3-store'] — the service descriptor with extended outputs (§ 5)", () => {
  const build = {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  };

  test('serialize surfaces bucket + the wired credentials alongside compute env writes', async () => {
    await withEnv({ PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const node = s3StoreService({ name: 'store', deps: {}, build });
      const ctx = {
        address: 'store',
        node,
        graph: { secrets: [], edges: [] },
        application: {},
      } as unknown as LowerContext;
      const provisioned = { serviceId: 'store-svc#cloud-id', projectId: 'shop-project#cloud-id' };
      // buildConfig would populate inputs.credentials from the wired resource's
      // lowered outputs; bucket is the service's own param.
      const config = {
        service: { port: 3000, bucket: 'streams' },
        inputs: { credentials: { accessKeyId: 'AKIA123', secretAccessKey: 'sekret' } },
      };

      const result = run<MockedS3StoreSerialized>(
        serviceDescriptorOf(target, 's3-store').serialize(ctx, provisioned, config),
      );

      expect(result.bucket).toBe('streams');
      expect(result.accessKeyId).toBe('AKIA123');
      expect(result.secretAccessKey).toBe('sekret');
      // compute's own serialize product survives the extension.
      expect(result.port).toBe(3000);
      expect(Array.isArray(result.environment)).toBe(true);
    });
  });

  test('serialize fails closed when credentials or bucket are unwired (F5)', async () => {
    await withEnv({ PRISMA_BRANCH_ID: undefined }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const node = s3StoreService({ name: 'store', deps: {}, build });
      const ctx = {
        address: 'store',
        node,
        graph: { secrets: [], edges: [] },
        application: {},
      } as unknown as LowerContext;
      const provisioned = { projectId: 'shop-project#cloud-id' };
      const serialize = (config: unknown) =>
        run<MockedS3StoreSerialized>(
          serviceDescriptorOf(target, 's3-store').serialize(
            ctx,
            provisioned,
            config as Parameters<ReturnType<typeof serviceDescriptorOf>['serialize']>[2],
          ),
        );

      // No credentials wired.
      expect(() => serialize({ service: { port: 3000, bucket: 'streams' }, inputs: {} })).toThrow(
        /must wire a 'credentials' dependency and a 'bucket' param/,
      );
      // No bucket param.
      expect(() =>
        serialize({
          service: { port: 3000 },
          inputs: { credentials: { accessKeyId: 'AKIA123', secretAccessKey: 'sekret' } },
        }),
      ).toThrow(/must wire a 'credentials' dependency and a 'bucket' param/);
    });
  });

  test('deploy outputs carry all four S3Config field names for a consumer s3() slot', async () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const ctx = { id: 'store' } as unknown as LowerContext;
    const provisioned = { serviceId: 'store-svc#cloud-id', projectId: 'shop-project#cloud-id' };
    const artifact = { path: '/tmp/store.tar.gz', sha256: 'sha-store' };
    const serialized = {
      environment: [{ id: 'STORE_PORT-var#cloud-id', key: 'STORE_PORT' }],
      port: 3000,
      bucket: 'streams',
      accessKeyId: 'AKIA123',
      secretAccessKey: 'sekret',
    };

    const result = run<LoweredResult>(
      serviceDescriptorOf(target, 's3-store').deploy(ctx, provisioned, artifact, serialized),
    );

    // The four S3Config fields a consumer's s3() slot resolves by name, plus url.
    expect(result.outputs).toEqual({
      url: 'https://store-deploy.example',
      projectId: 'shop-project#cloud-id',
      bucket: 'streams',
      accessKeyId: 'AKIA123',
      secretAccessKey: 'sekret',
    });
    // The entities are compute's, passed through untouched — an s3-store IS
    // a compute service and became nothing else. Note what is NOT here: the
    // credentials ride in the outputs (the consumer needs them) but never reach
    // an entity, which exists to be printed to a terminal.
    expect(result.entities).toEqual([
      {
        kind: 'compute-service',
        id: 'store-svc#cloud-id',
        url: 'https://store-deploy.example',
      },
    ]);
  });

  test('provision + package delegate to compute unchanged', () => {
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const ctx = {
      id: 'store',
      application: { projectId: 'p#cloud-id' },
    } as unknown as LowerContext;
    const provisionResult = run<MockedProvisioned>(
      serviceDescriptorOf(target, 's3-store').provision(ctx),
    );
    expect(provisionResult.serviceId).toBe('store-svc#cloud-id');

    const pkg = run(
      serviceDescriptorOf(target, 's3-store').package(ctx, {
        assembled: { dir: 'd', entry: 'server.js' },
        address: 'store',
      }),
    );
    expect(pkg).toEqual({ path: '/tmp/store.tar.gz', sha256: 'sha-store' });
  });
});

describe('s3StoreService() authoring factory', () => {
  const build = {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  };

  test("routes to the 's3-store' lowering but keeps compute's deps/params/expose/load", () => {
    const node = s3StoreService({
      name: 'store',
      deps: { db: postgres() },
      build,
      expose: { store: postgresContract },
    });
    expect(node.type).toBe('s3-store');
    expect(node.kind).toBe('service');
    expect(Object.keys(node.inputs)).toEqual(['db']);
    expect(node.expose).toEqual({ store: postgresContract });
    expect(typeof node.load).toBe('function');
    expect(typeof node.config).toBe('function');
    // The reserved compute param survives the type override.
    expect(node.params.port).toBeDefined();
  });
});

describe('sharing: one module-provisioned postgres, two compute consumers — through core lowering()', () => {
  test("ONE Database + Connection; both services' env writes carry its url under their own keys", async () => {
    await withEnv(
      { PRISMA_PROJECT_ID: 'shop-project#cloud-id', PRISMA_BRANCH_ID: undefined },
      () => {
        const target = prismaCloud({ workspaceId: 'ws_1' });
        const build = {
          extension: '@prisma/composer/node',
          type: 'node',
          module: 'file:///test/service.ts',
          entry: 'server.js',
        };
        const root = module('shop', {}, ({ provision }) => {
          const db = provision(postgres({ name: 'data' }), { id: 'data' });
          provision(compute({ name: 'auth', deps: { main: postgres() }, build }), {
            id: 'auth',
            deps: {
              main: db,
            },
          });
          provision(compute({ name: 'billing', deps: { store: postgres() }, build }), {
            id: 'billing',
            deps: {
              store: db,
            },
          });
          return {};
        });
        const before = {
          db: recorded.db.length,
          conn: recorded.conn.length,
          envVar: recorded.envVar.length,
        };

        run<undefined>(
          lowering(root, configFor(target), {
            name: 'shop',
            bundles: {
              auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
              billing: { dir: 'modules/billing/dist/bundle', entry: 'server.js' },
            },
          }),
        );

        expect(recorded.db.slice(before.db)).toEqual([
          ['data-db', { projectId: 'shop-project#cloud-id', name: 'data', region: 'us-east-1' }],
        ]);
        expect(recorded.conn.slice(before.conn)).toEqual([
          ['data-conn', { databaseId: 'data-db#cloud-id', name: 'data' }],
        ]);

        const writes = recorded.envVar.slice(before.envVar).map(([, props]) => props);
        expect(writes).toContainEqual({
          projectId: 'shop-project#cloud-id',
          key: 'COMPOSER_AUTH_MAIN_URL',
          value: 'postgres://data-conn',
          class: 'production',
        });
        expect(writes).toContainEqual({
          projectId: 'shop-project#cloud-id',
          key: 'COMPOSER_BILLING_STORE_URL',
          value: 'postgres://data-conn',
          class: 'production',
        });
      },
    );
  });
});

describe('ADR-0030: per-binding RPC service keys — mint (control.ts) + wire (descriptors/compute.ts)', () => {
  const build = {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  };
  // A fake RPC-shaped Contract (mirrors extension.test.ts's fakeContract) — not
  // @internal/rpc. Proves the target reacts to the `serviceKey` param's
  // provision need alone, never to "rpc" by name (ADR-0030's
  // not-RPC-special-cased promise) — it still carries RPC_PEER_KEY as its
  // brand, since that's the only brand this target's control.ts registers.
  const fakeRpcContract: Contract<'rpc', Record<never, never>> = {
    kind: 'rpc',
    __cmp: {},
    satisfies: () => true,
  };
  const rpcLikeDep = () =>
    dependency({
      type: 'rpc',
      connection: {
        params: {
          url: string(),
          serviceKey: string({ optional: true, provision: provisionNeed(RPC_PEER_KEY) }),
        },
        hydrate: (v) => v,
      },
    });

  test("consumer's edge writes its own serviceKey var; the provider's writes the accepted set with that one key", async () => {
    await withEnv(
      { PRISMA_PROJECT_ID: 'shop-project#cloud-id', PRISMA_BRANCH_ID: undefined },
      () => {
        const target = prismaCloud({ workspaceId: 'ws_1' });
        const root = module('shop', {}, ({ provision }) => {
          const auth = provision(
            compute({ name: 'auth', deps: {}, build, expose: { verify: fakeRpcContract } }),
            { id: 'auth' },
          );
          provision(compute({ name: 'web', deps: { auth: rpcLikeDep() }, build }), {
            id: 'web',
            deps: { auth: auth.verify },
          });
          return {};
        });
        const before = { envVar: recorded.envVar.length, serviceKey: recorded.serviceKey.length };

        run<undefined>(
          lowering(root, configFor(target), {
            name: 'shop',
            bundles: {
              auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
              web: { dir: 'modules/web/dist/bundle', entry: 'server.js' },
            },
          }),
        );

        // One ServiceKey minted, its id carrying the edge id.
        expect(recorded.serviceKey.slice(before.serviceKey).map(([id]) => id)).toEqual([
          'servicekey-web.auth',
        ]);

        const writes = recorded.envVar.slice(before.envVar).map(([, props]) => props);
        expect(writes).toContainEqual({
          projectId: 'shop-project#cloud-id',
          key: 'COMPOSER_WEB_AUTH_SERVICEKEY',
          value: 'key-for-servicekey-web.auth',
          class: 'production',
        });
        expect(writes).toContainEqual({
          projectId: 'shop-project#cloud-id',
          key: 'COMPOSER_AUTH_RPC_ACCEPTED_KEYS',
          value: '["key-for-servicekey-web.auth"]',
          class: 'production',
        });
      },
    );
  });

  test('two consumers of one provider mint two distinct edge keys; the accepted set carries both', async () => {
    await withEnv(
      { PRISMA_PROJECT_ID: 'shop-project#cloud-id', PRISMA_BRANCH_ID: undefined },
      () => {
        const target = prismaCloud({ workspaceId: 'ws_1' });
        const root = module('shop', {}, ({ provision }) => {
          const auth = provision(
            compute({ name: 'auth2', deps: {}, build, expose: { verify: fakeRpcContract } }),
            { id: 'auth2' },
          );
          provision(compute({ name: 'web1', deps: { auth: rpcLikeDep() }, build }), {
            id: 'web1',
            deps: { auth: auth.verify },
          });
          provision(compute({ name: 'web2', deps: { auth: rpcLikeDep() }, build }), {
            id: 'web2',
            deps: { auth: auth.verify },
          });
          return {};
        });
        const before = recorded.envVar.length;

        run<undefined>(
          lowering(root, configFor(target), {
            name: 'shop',
            bundles: {
              auth2: { dir: 'modules/auth2/dist/bundle', entry: 'server.js' },
              web1: { dir: 'modules/web1/dist/bundle', entry: 'server.js' },
              web2: { dir: 'modules/web2/dist/bundle', entry: 'server.js' },
            },
          }),
        );

        const writes = recorded.envVar
          .slice(before)
          .map(([, props]) => props as { key: string; value: string });
        const web1Key = writes.find((w) => w.key === 'COMPOSER_WEB1_AUTH_SERVICEKEY')?.value;
        const web2Key = writes.find((w) => w.key === 'COMPOSER_WEB2_AUTH_SERVICEKEY')?.value;
        expect(web1Key).toBeDefined();
        expect(web2Key).toBeDefined();
        expect(web1Key).not.toBe(web2Key);

        const acceptedRaw = writes.find((w) => w.key === 'COMPOSER_AUTH2_RPC_ACCEPTED_KEYS')?.value;
        if (acceptedRaw === undefined) throw new Error('expected an accepted-keys row');
        expect(JSON.parse(acceptedRaw).sort()).toEqual([web1Key, web2Key].sort());
      },
    );
  });

  test('a provider that exposes RPC with zero wired consumers still writes an accepted-set var — value "[]" (deny-all, closes the fail-open hole)', async () => {
    await withEnv(
      { PRISMA_PROJECT_ID: 'shop-project#cloud-id', PRISMA_BRANCH_ID: undefined },
      () => {
        const target = prismaCloud({ workspaceId: 'ws_1' });
        const root = module('shop', {}, ({ provision }) => {
          provision(
            compute({ name: 'auth3', deps: {}, build, expose: { verify: fakeRpcContract } }),
            { id: 'auth3' },
          );
          return {};
        });
        const before = { envVar: recorded.envVar.length, serviceKey: recorded.serviceKey.length };

        run<undefined>(
          lowering(root, configFor(target), {
            name: 'shop',
            bundles: { auth3: { dir: 'modules/auth3/dist/bundle', entry: 'server.js' } },
          }),
        );

        // No consumer, so no ServiceKey is minted.
        expect(recorded.serviceKey.slice(before.serviceKey)).toEqual([]);

        const writes = recorded.envVar.slice(before.envVar).map(([, props]) => props);
        expect(writes).toContainEqual({
          projectId: 'shop-project#cloud-id',
          key: 'COMPOSER_AUTH3_RPC_ACCEPTED_KEYS',
          value: '[]',
          class: 'production',
        });
      },
    );
  });

  test('a service with no `expose` never serves, so it writes no accepted-keys var', async () => {
    await withEnv(
      { PRISMA_PROJECT_ID: 'shop-project#cloud-id', PRISMA_BRANCH_ID: undefined },
      () => {
        const target = prismaCloud({ workspaceId: 'ws_1' });
        const root = module('shop', {}, ({ provision }) => {
          const auth = provision(
            compute({ name: 'auth4', deps: {}, build, expose: { verify: fakeRpcContract } }),
            { id: 'auth4' },
          );
          // storefront is a pure consumer — it exposes nothing of its own.
          provision(compute({ name: 'storefront', deps: { auth: rpcLikeDep() }, build }), {
            id: 'storefront',
            deps: { auth: auth.verify },
          });
          return {};
        });
        const before = recorded.envVar.length;

        run<undefined>(
          lowering(root, configFor(target), {
            name: 'shop',
            bundles: {
              auth4: { dir: 'modules/auth4/dist/bundle', entry: 'server.js' },
              storefront: { dir: 'modules/storefront/dist/bundle', entry: 'server.js' },
            },
          }),
        );

        const writtenKeys = recorded.envVar
          .slice(before)
          .map(([, props]) => (props as { key: string }).key);
        expect(writtenKeys).not.toContain('COMPOSER_STOREFRONT_RPC_ACCEPTED_KEYS');
      },
    );
  });
});

describe("streams' provisioned bearer key — one value per PROVIDER, stored on the provider", () => {
  const build = {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  };
  // A fake streams-shaped Contract + dependency: the target reacts to the
  // `apiKey` param's need brand alone, never to "streams" by name.
  const fakeStreamsContract: Contract<'streams', Record<never, never>> = {
    kind: 'streams',
    __cmp: {},
    satisfies: () => true,
  };
  const streamsLikeDep = () =>
    dependency({
      type: 'streams',
      connection: {
        params: { url: string(), apiKey: string({ provision: provisionNeed(STREAMS_API_KEY) }) },
        hydrate: (v) => v,
      },
    });

  test('two consumers of one streams module share ONE key; the provider stores that same key', async () => {
    await withEnv(
      { PRISMA_PROJECT_ID: 'shop-project#cloud-id', PRISMA_BRANCH_ID: undefined },
      () => {
        const target = prismaCloud({ workspaceId: 'ws_1' });
        const root = module('shop', {}, ({ provision }) => {
          const events = provision(
            compute({ name: 'events', deps: {}, build, expose: { streams: fakeStreamsContract } }),
            { id: 'events' },
          );
          provision(compute({ name: 'reader', deps: { events: streamsLikeDep() }, build }), {
            id: 'reader',
            deps: { events: events.streams },
          });
          provision(compute({ name: 'writer', deps: { events: streamsLikeDep() }, build }), {
            id: 'writer',
            deps: { events: events.streams },
          });
          return {};
        });
        const before = { envVar: recorded.envVar.length, serviceKey: recorded.serviceKey.length };

        run<undefined>(
          lowering(root, configFor(target), {
            name: 'shop',
            bundles: {
              events: { dir: 'modules/events/dist/bundle', entry: 'server.js' },
              reader: { dir: 'modules/reader/dist/bundle', entry: 'server.js' },
              writer: { dir: 'modules/writer/dist/bundle', entry: 'server.js' },
            },
          }),
        );

        // Both edges resolve to ONE resource id — the PROVIDER's address, not
        // the edge's — so the mint is shared (upstream auths a single API_KEY).
        expect([
          ...new Set(recorded.serviceKey.slice(before.serviceKey).map(([id]) => id)),
        ]).toEqual(['streamskey-events']);

        const writes = recorded.envVar.slice(before.envVar).map(([, props]) => props);
        const writtenValue = (envName: string): unknown =>
          (
            writes.find((w) => (w as { key: string }).key === envName) as
              | { value?: unknown }
              | undefined
          )?.value;
        expect(writtenValue('COMPOSER_READER_EVENTS_APIKEY')).toBe('key-for-streamskey-events');
        expect(writtenValue('COMPOSER_WRITER_EVENTS_APIKEY')).toBe('key-for-streamskey-events');

        // The provider's own reserved provider param: the same key, under the
        // name the streams entrypoint reads (address-scoped; compute's run
        // validates and re-stashes it), JSON-encoded like any service-own
        // literal param.
        expect(writes).toContainEqual({
          projectId: 'shop-project#cloud-id',
          key: 'COMPOSER_EVENTS_STREAMS_API_KEY',
          value: '"key-for-streamskey-events"',
          class: 'production',
        });
      },
    );
  });

  test('the reserved provider param refuses two disagreeing keys for one provider (a per-edge flip would be loud)', () => {
    // The provider param writes ONE key, which is only correct while the
    // provisioner mints per provider. Drive serialize directly with two
    // inbound edges whose refs disagree — the shape a per-edge flip would
    // produce without a paired accepted-set provider param.
    const target = prismaCloud({ workspaceId: 'ws_1' });
    const node = compute({
      name: 'events',
      deps: {},
      build,
      expose: { streams: fakeStreamsContract },
    });
    const consumerNode = compute({ name: 'reader', deps: { events: streamsLikeDep() }, build });
    const graph = {
      nodes: [
        { id: 'events', node },
        { id: 'reader', node: consumerNode },
        { id: 'writer', node: consumerNode },
      ],
      edges: [
        { kind: 'dependency', from: 'events', to: 'reader', input: 'events' },
        { kind: 'dependency', from: 'events', to: 'writer', input: 'events' },
      ],
      secrets: [],
    };
    const ctx = {
      address: 'events',
      node,
      graph,
      provisioned: new Map([
        ['reader.events', 'key-one'],
        ['writer.events', 'key-two'],
      ]),
    } as unknown as LowerContext;

    expect(() =>
      run<MockedSerialized>(
        serviceDescriptorOf(target, 'compute').serialize(
          ctx,
          { outputs: { projectId: 'shop-project#cloud-id' } },
          { service: { port: 3000 }, inputs: {} } as Parameters<
            ReturnType<typeof serviceDescriptorOf>['serialize']
          >[2],
        ),
      ),
    ).toThrow(/provisioned 2 distinct keys/);
  });

  test('a streams provider with no consumers mints nothing and stores no key', async () => {
    await withEnv(
      { PRISMA_PROJECT_ID: 'shop-project#cloud-id', PRISMA_BRANCH_ID: undefined },
      () => {
        const target = prismaCloud({ workspaceId: 'ws_1' });
        const root = module('shop', {}, ({ provision }) => {
          provision(
            compute({ name: 'lonely', deps: {}, build, expose: { streams: fakeStreamsContract } }),
            { id: 'lonely' },
          );
          return {};
        });
        const before = { envVar: recorded.envVar.length, serviceKey: recorded.serviceKey.length };

        run<undefined>(
          lowering(root, configFor(target), {
            name: 'shop',
            bundles: { lonely: { dir: 'modules/lonely/dist/bundle', entry: 'server.js' } },
          }),
        );

        expect(recorded.serviceKey.slice(before.serviceKey)).toEqual([]);
        const keys = recorded.envVar
          .slice(before.envVar)
          .map(([, props]) => (props as { key: string }).key);
        expect(keys).not.toContain('COMPOSER_LONELY_STREAMS_API_KEY');
      },
    );
  });
});

describe("descriptors/compute.ts's provider-param loop is generic over the registry it is handed — adding a brand is control.ts's edit alone", () => {
  const build = {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  };
  const anyContract: Contract<'rpc', Record<never, never>> = {
    kind: 'rpc',
    __cmp: {},
    satisfies: () => true,
  };

  test('three independently-registered provider params — including a brand this test invents — each write their own row through the same unmodified serialize()', async () => {
    await withEnv({ PRISMA_BRANCH_ID: undefined }, () => {
      // Neither of these two symbols is RPC_PEER_KEY or STREAMS_API_KEY —
      // `computeDescriptor` is handed this registry as plain data and never
      // imports a brand's module, so it cannot tell a real brand from a made-
      // up one. That is the property this test pins: the loop in
      // descriptors/compute.ts needs no edit to support a new registrant.
      const brandOne = Symbol('provider-param-test/one');
      const brandTwo = Symbol('provider-param-test/two');
      const brandThree = Symbol('provider-param-test/three');
      const providerParams: ReadonlyMap<symbol, ProviderParam> = new Map([
        [
          brandOne,
          { name: 'PARAM_ONE', schema: type('string'), brand: brandOne, value: () => 'value-one' },
        ],
        [
          brandTwo,
          { name: 'PARAM_TWO', schema: type('string'), brand: brandTwo, value: () => 'value-two' },
        ],
        // A third registrant may also decline to write a row at all.
        [
          brandThree,
          {
            name: 'PARAM_THREE',
            schema: type('string'),
            brand: brandThree,
            value: () => undefined,
          },
        ],
      ]);
      const o: ResolvedCloudOptions = {
        workspaceId: 'ws_1',
        projectId: 'shop-project#cloud-id',
        branchId: undefined,
        providerParams,
      };
      const node = compute({ name: 'multi', deps: {}, build, expose: { any: anyContract } });
      const ctx = {
        address: 'multi',
        node,
        graph: { secrets: [], edges: [] },
        application: { outputs: {} },
        provisioned: new Map(),
      } as unknown as LowerContext;
      const provisioned = { serviceId: 'multi-svc#cloud-id', projectId: 'shop-project#cloud-id' };
      const config = { service: { port: 3000 }, inputs: {} };
      const before = recorded.envVar.length;

      // The three-brand options can't ride the shared registry, so erase the
      // precise descriptor to the registry's own type — the same assignment
      // control.ts makes when it registers the real one.
      const descriptor: NodeDescriptor = computeDescriptor(o);
      if (descriptor.kind !== 'service') throw new Error('expected a service descriptor');
      run<MockedSerialized>(descriptor.serialize(ctx, provisioned, config));

      const writes = recorded.envVar.slice(before).map(([, props]) => props);
      expect(writes).toContainEqual({
        projectId: 'shop-project#cloud-id',
        key: 'COMPOSER_MULTI_PARAM_ONE',
        value: '"value-one"',
        class: 'production',
      });
      expect(writes).toContainEqual({
        projectId: 'shop-project#cloud-id',
        key: 'COMPOSER_MULTI_PARAM_TWO',
        value: '"value-two"',
        class: 'production',
      });
      expect(writes.map((w) => (w as { key: string }).key)).not.toContain(
        'COMPOSER_MULTI_PARAM_THREE',
      );
    });
  });
});

describe('name validation — fail fast on Prisma name constraints, before creating anything', () => {
  const build = {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///test/service.ts',
    entry: 'server.js',
  };
  const bundles = { auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' } };

  // The plain throw validateName raises becomes an Effect defect; run() (runSync)
  // re-raises it synchronously — exactly what `lower()`'s Effect.orDie surfaces
  // at deploy. Capture it directly rather than through the typed error channel.
  const lowerError = (eff: Effect.Effect<unknown, unknown, unknown>): Error => {
    try {
      run(eff);
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected lowering to throw');
  };

  test('a too-short postgres provision id throws the framework error at lower time, before any Database is recorded', async () => {
    await withEnv({ PRISMA_PROJECT_ID: 'shop-project#cloud-id' }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const root = module('shop', {}, ({ provision }) => {
        const db = provision(postgres({ name: 'db' }), { id: 'db' });
        provision(compute({ name: 'auth', deps: { main: postgres() }, build }), {
          id: 'auth',
          deps: {
            main: db,
          },
        });
        return {};
      });
      const before = recorded.db.length;

      const error = lowerError(lowering(root, configFor(target), { name: 'shop', bundles }));

      // A framework authoring error naming the id and the constraint — not a raw PrismaApiError.
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('resource name (from provision id) "db"');
      expect(error.message).toContain('3–65 characters');
      expect(error.message).not.toContain('PrismaApiError');
      // It failed BEFORE creating the Database (strictly better than the mid-deploy API error).
      expect(recorded.db.length).toBe(before);
    });
  });

  test('a too-short service provision id throws the framework error naming the service name', async () => {
    await withEnv({ PRISMA_PROJECT_ID: 'shop-project#cloud-id' }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const root = module('shop', {}, ({ provision }) => {
        provision(compute({ name: 'a', deps: {}, build }), { id: 'a' });
        return {};
      });
      const before = recorded.svc.length;

      const error = lowerError(
        lowering(root, configFor(target), { name: 'shop', bundles: { a: bundles.auth } }),
      );

      expect(error.message).toContain('service name (from provision id) "a"');
      expect(error.message).toContain('3–65 characters');
      expect(recorded.svc.length).toBe(before);
    });
  });

  test('a valid-name module lowers unchanged — no throw, the Database is created', async () => {
    await withEnv({ PRISMA_PROJECT_ID: 'shop-project#cloud-id' }, () => {
      const target = prismaCloud({ workspaceId: 'ws_1' });
      const root = module('shop', {}, ({ provision }) => {
        const db = provision(postgres({ name: 'data' }), { id: 'data' });
        provision(compute({ name: 'auth', deps: { main: postgres() }, build }), {
          id: 'auth',
          deps: {
            main: db,
          },
        });
        return {};
      });
      const before = recorded.db.length;

      expect(() =>
        run<undefined>(lowering(root, configFor(target), { name: 'shop', bundles })),
      ).not.toThrow();
      expect(recorded.db.length).toBe(before + 1);
    });
  });
});
