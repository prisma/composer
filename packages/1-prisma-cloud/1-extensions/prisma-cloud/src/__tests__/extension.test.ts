import { describe, expect, test } from 'bun:test';
import type { ConfigDeclaration, Contract } from '@internal/core';
import { configOf, hydrateSync, isNode, number, param, string } from '@internal/core';
import { type } from 'arktype';
import { compute, postgres, postgresContract } from '../index.ts';
import { configKey, deserialize, encode } from '../serializer.ts';
import { bootstrapService } from '../testing.ts';

function scalarDeclaration(
  owner: ConfigDeclaration['owner'],
  name: string,
  opts: { secret?: boolean; optional?: boolean; default?: unknown } = {},
): ConfigDeclaration {
  return {
    owner,
    name,
    schema: { vendor: '@prisma/compose' },
    secret: opts.secret ?? false,
    optional: opts.optional ?? false,
    default: opts.default,
  };
}

const build = {
  extension: '@prisma/compose/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

/** Sets env vars for the duration of `fn`, restoring whatever was there before. */
async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const previous = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('postgres({ name })', () => {
  test('returns a branded resource identity providing postgresContract; type is the contract kind', () => {
    const node = postgres({ name: 'db' });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('resource');
    expect(node.type).toBe('postgres');
    expect(node.extension).toBe('@prisma/compose-prisma-cloud');
    expect(node.name).toBe('db');
    expect(node.provides).toBe(postgresContract);
    expect('connection' in node).toBe(false);
  });
});

describe('postgres()', () => {
  test('returns a branded dependency end requiring postgresContract, declaring { url: string, secret }', () => {
    const end = postgres();

    expect(isNode(end)).toBe(true);
    expect(end.kind).toBe('dependency');
    expect(end.type).toBe('postgres');
    expect(end.name).toBe('postgres');
    expect(end.required).toBe(postgresContract);
    expect(end.connection.params).toEqual({ url: string({ secret: true }) });
  });

  test('the binding IS the typed config — hydrate is the identity on its values (ADR-0015)', () => {
    const end = postgres();

    const binding = end.connection.hydrate({ url: 'postgres://u:p@host:5432/db' });

    // No client factory: load() hands the app PostgresConfig, which it turns
    // into its own client. hydrate returns its input unchanged.
    expect(binding).toEqual({ url: 'postgres://u:p@host:5432/db' });
  });
});

describe('compute()', () => {
  test('returns a branded, runnable service node declaring { port: number, default 3000 }', () => {
    const node = compute({
      name: 'test-service',
      deps: {},
      build,
    });

    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('service');
    expect(node.type).toBe('compute');
    expect(node.params).toEqual({ port: number({ default: 3000 }) });
    expect(typeof node.run).toBe('function');
    expect(typeof node.load).toBe('function');
  });

  test('is inert until run or load — constructing the node hydrates nothing', () => {
    const db = postgres();
    const node = compute({
      name: 'test-service',
      deps: { db },
      build,
    });

    expect(node.inputs.db).toBe(db);
  });

  test('DI without any environment: hydrateSync against a hand-built Config runs the real connection factories', () => {
    const node = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });

    const deps = hydrateSync(node, {
      service: { port: 0 },
      inputs: { db: { url: 'postgres://fake' } },
    });

    expect(deps).toEqual({ db: { url: 'postgres://fake' } });
  });
});

describe('compute({ expose })', () => {
  const fakeContract = <Cmp>(cmp: Cmp): Contract<'rpc', Cmp> => ({
    kind: 'rpc',
    __cmp: cmp,
    satisfies: (required) => required.__cmp === cmp,
  });

  test('threads the exposed contract map onto the node, frozen', () => {
    const authContract = fakeContract({ verify: async () => ({ ok: true }) });

    const node = compute({
      name: 'test-service',
      deps: {},
      build,
      expose: { rpc: authContract },
    });

    expect(node.expose).toEqual({ rpc: authContract });
    expect(node.expose?.rpc).toBe(authContract);
    expect(Object.isFrozen(node.expose)).toBe(true);
  });

  test('expose is absent when not declared — services without it keep working unchanged', () => {
    const node = compute({
      name: 'test-service',
      deps: {},
      build,
    });

    expect(node.expose).toBeUndefined();
  });
});

describe("the config serializer (shared by run() and /control's serialize)", () => {
  test("configKey: lone-service root (address '') is unprefixed — owner ▸ name", () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });
    const [dbUrl, port] = configOf(app);
    if (dbUrl === undefined || port === undefined) throw new Error('expected config declarations');

    expect(configKey('', dbUrl)).toBe('DB_URL');
    expect(configKey('', port)).toBe('PORT');
  });

  test('configKey: a module-addressed service prefixes with its address segment', () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });
    const [dbUrl] = configOf(app);
    if (dbUrl === undefined) throw new Error('expected a config declaration');

    expect(configKey('auth', dbUrl)).toBe('AUTH_DB_URL');
  });

  test('configKey: a connection-end input keys the same way as a resource input', () => {
    const app = compute({
      name: 'test-service',
      deps: {},
      build,
    });
    // A synthetic declaration shaped like configOf would produce for a
    // connection-end input named "auth".
    const decl = {
      owner: { input: 'auth' },
      name: 'url',
      schema: {},
      secret: false,
      optional: false,
      default: undefined,
    };

    expect(configKey('storefront', decl)).toBe('STOREFRONT_AUTH_URL');
    void app;
  });

  test('deserialize round-trips what a service declares, reading process.env by configKey', async () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });

    await withEnv({ DB_URL: 'postgres://x', PORT: '4001' }, () => {
      const config = deserialize(app, '');
      expect(config).toEqual({ service: { port: 4001 }, inputs: { db: { url: 'postgres://x' } } });
    });
  });

  test('deserialize: an unset param with a default resolves to the default', async () => {
    const app = compute({
      name: 'test-service',
      deps: {},
      build,
    });

    await withEnv({}, () => {
      expect(deserialize(app, '')).toEqual({ service: { port: 3000 }, inputs: {} });
    });
  });

  test('deserialize: a missing required param fails loudly, naming the param', async () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });

    await withEnv({}, () => {
      expect(() => deserialize(app, '')).toThrow(/db\.url|"url"/);
    });
  });

  test('deserialize: an invalid number fails loudly even with a default present', async () => {
    const app = compute({
      name: 'test-service',
      deps: {},
      build,
    });

    await withEnv({ PORT: 'not-a-number' }, () => {
      expect(() => deserialize(app, '')).toThrow(/port/);
    });
  });

  test('round-trip: a numeric leaf serializes to a string and deserializes back to the identical number', async () => {
    // The gap that hid the serialize bug: /control's serialize encodes typed→
    // string (3000 → "3000"), and this same module's deserialize must read it
    // back as a number (3000). Emulate serialize's encoding for the `port`
    // param, keyed by the SHARED configKey, then read it back through
    // deserialize and assert the number is identical.
    const app = compute({
      name: 'test-service',
      deps: {},
      build,
    });
    const shape = configOf(app);
    const portDecl = shape.find((d) => d.name === 'port');
    if (portDecl === undefined) throw new Error('expected a port declaration');

    const original = 3000;
    // serialize (in target.ts): a concrete number stringifies.
    const encoded = typeof original === 'number' ? String(original) : original;
    expect(encoded).toBe('3000');

    await withEnv({ [configKey('auth', portDecl)]: encoded }, () => {
      const config = deserialize(app, 'auth');
      expect(config.service['port']).toBe(original);
      expect(typeof config.service['port']).toBe('number');
    });
  });
});

describe('compute().run(address, boot) → load() — the round trip', () => {
  test('deploy-side serialize writes address-keyed env; run() re-keys it address-free; load() hydrates it', async () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });

    let loaded: unknown;
    await withEnv({ AUTH_DB_URL: 'postgres://x', AUTH_PORT: '4001', DB_URL: '', PORT: '' }, () =>
      app.run('auth', async () => {
        loaded = app.load();
      }),
    );

    expect(loaded).toEqual({ db: { url: 'postgres://x' } });
    expect(app.config()).toEqual({ port: 4001 });
  });

  test("a lone-service deploy (address '') reads and re-stashes the same unprefixed keys", async () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });

    let loaded: unknown;
    await withEnv({ DB_URL: 'postgres://y', PORT: '' }, () =>
      app.run('', async () => {
        loaded = app.load();
      }),
    );

    expect(loaded).toEqual({ db: { url: 'postgres://y' } });
    expect(app.config()).toEqual({ port: 3000 });
  });

  test('a postgres dependency in deps round-trips through run()/load() — the binding is its config', async () => {
    const db = postgres();
    const app = compute({ name: 'test-service', deps: { db }, build });

    let loaded: unknown;
    await withEnv({ DB_URL: 'postgres://dual', PORT: '' }, () =>
      app.run('', async () => {
        loaded = app.load();
      }),
    );

    expect(loaded).toEqual({ db: { url: 'postgres://dual' } });
    expect(app.config()).toEqual({ port: 3000 });
  });

  test('run() calls boot() exactly once, even with nothing to hydrate', async () => {
    let bootCalls = 0;
    const app = compute({
      name: 'test-service',
      deps: {},
      build,
    });

    await app.run('', async () => {
      bootCalls += 1;
    });

    expect(bootCalls).toBe(1);
  });
});

describe('bootstrapService(service, config, boot) — the in-process integration seam', () => {
  test("stashes the given Config address-free (like run('', ...)) so the booted entry's load() reads it", async () => {
    const app = compute({ name: 'test-service', deps: { db: postgres() }, build });

    let deps: unknown;
    let cfg: unknown;
    await withEnv({ DB_URL: '', PORT: '' }, () =>
      bootstrapService(
        app,
        { service: { port: 4321 }, inputs: { db: { url: 'postgres://bootstrap' } } },
        async () => {
          deps = app.load();
          cfg = app.config();
        },
      ),
    );

    expect(deps).toEqual({ db: { url: 'postgres://bootstrap' } });
    expect(cfg).toEqual({ port: 4321 });
  });

  test('needs no pre-set environment — the caller supplies the Config directly, unlike run()', async () => {
    const app = compute({ name: 'test-service', deps: { db: postgres() }, build });

    let deps: unknown;
    let cfg: unknown;
    await withEnv({ DB_URL: 'stale', PORT: 'stale' }, () =>
      bootstrapService(
        app,
        { service: { port: 5555 }, inputs: { db: { url: 'postgres://fresh' } } },
        async () => {
          deps = app.load();
          cfg = app.config();
        },
      ),
    );

    expect(deps).toEqual({ db: { url: 'postgres://fresh' } });
    expect(cfg).toEqual({ port: 5555 });
  });

  test('returns { url, fetch } pointing at the configured port', async () => {
    const app = compute({ name: 'test-service', deps: {}, build });

    const svc = await bootstrapService(
      app,
      { service: { port: 6789 }, inputs: {} },
      async () => {},
    );

    expect(svc.url).toBe('http://localhost:6789/');
    expect(typeof svc.fetch).toBe('function');
  });

  test('rejects a Config with no concrete port — the entry self-listens', async () => {
    const app = compute({ name: 'test-service', deps: {}, build });

    await expect(
      bootstrapService(app, { service: {}, inputs: {} }, async () => {}),
    ).rejects.toThrow(/concrete port number/);
  });
});

describe('compute().load()', () => {
  test('returns the deps, memoized per process (same object on re-load)', async () => {
    const app = compute({
      name: 'test-service',
      deps: { db: postgres() },
      build,
    });

    await withEnv({ DB_URL: 'postgres://z', PORT: '' }, () => {
      const first = app.load();
      const second = app.load();

      // Memoized: one binding set per process — the same object each call.
      expect(first).toBe(second);
      expect(first).toEqual({ db: { url: 'postgres://z' } });
      expect(app.config()).toEqual({ port: 3000 });
    });
  });
});

describe('the config pipeline over extension nodes', () => {
  test('configOf is semantic — owner/name/type/secret, no platform keys', () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });

    expect(configOf(app)).toEqual([
      scalarDeclaration({ input: 'db' }, 'url', { secret: true }),
      scalarDeclaration('service', 'port', { default: 3000 }),
    ]);
    expect(JSON.stringify(configOf(app))).not.toContain('DATABASE_URL');
  });

  test('a dep-less service declares only its own params', () => {
    const app = compute({
      name: 'test-service',
      deps: {},
      build,
    });

    expect(configOf(app)).toEqual([scalarDeclaration('service', 'port', { default: 3000 })]);
  });
});

describe('importing a service module', () => {
  test('runs nothing (invariant 3): construction is inert; load() yields the binding from the env', async () => {
    const fixture = await import('./fixtures/side-effect-service.ts');

    // Importing the module must not throw or read the environment; the module
    // top-level does nothing but construct nodes (pure).
    expect(fixture.imported).toBe(true);

    const loaded = await withEnv({ DB_URL: 'postgres://fixture', PORT: '' }, () =>
      fixture.default.load(),
    );

    expect(loaded).toEqual({ db: { url: 'postgres://fixture' } });
    expect(fixture.default.config()).toEqual({ port: 3000 });
  });
});

describe('structured params + target-owned serialization (ADR-0018/0019)', () => {
  test('a schema-typed structured param round-trips: JSON on the wire, validated value back', async () => {
    const jobs = [
      { jobId: 'tick', every: '60s' },
      { jobId: 'mrr', every: '24h' },
    ];
    const app = compute({
      name: 'scheduler',
      deps: {},
      params: {
        jobs: param(type({ jobId: 'string', every: 'string' }).array(), { default: jobs }),
      },
      build,
    });
    const jobsDecl = configOf(app).find((d) => d.name === 'jobs');
    if (jobsDecl === undefined) throw new Error('expected a jobs declaration');

    await withEnv({ [configKey('', jobsDecl)]: JSON.stringify(jobs) }, () => {
      // deserialize JSON-parses the service-own value and validates it against the schema
      expect(deserialize(app, '').service['jobs']).toEqual(jobs);
    });
  });

  test('configOf reports a schema projection, not a scalar type tag', () => {
    const app = compute({ name: 's', deps: { db: postgres() }, build });
    const portDecl = configOf(app).find((d) => d.owner === 'service' && d.name === 'port');
    expect(portDecl?.schema).toEqual({ vendor: '@prisma/compose' });
  });

  test('LANDMINE: a dependency-input value passes through encode untouched — a provisioning ref keeps its edge', () => {
    const ref: unknown = { __ref: 'services.auth.url' };
    // encode's return type is `string`, but a dependency-input value is a ref
    // that flows through unchanged — assert identity without a cast.
    expect(Object.is(encode({ input: 'db' }, ref), ref)).toBe(true); // never JSON-stringified
    // a service-own literal, by contrast, is JSON-encoded
    expect(encode('service', 3000)).toBe('3000');
    expect(encode('service', [{ jobId: 'tick' }])).toBe('[{"jobId":"tick"}]');
  });
});
