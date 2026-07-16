import { describe, expect, test } from 'bun:test';
import type { ConfigDeclaration, Contract } from '@internal/core';
import {
  configOf,
  hydrateSync,
  isNode,
  number,
  param,
  SecretBox,
  secret,
  string,
} from '@internal/core';
import { RPC_ACCEPTED_KEYS_ENV } from '@internal/rpc';
import { type } from 'arktype';
import { compute, postgres, postgresContract } from '../index.ts';
import { configKey, deserialize, deserializeSecrets, encode, secretKey } from '../serializer.ts';
import { serviceKeyEnvName } from '../service-keys.ts';
import { bootstrapService } from '../testing.ts';

function scalarDeclaration(
  owner: ConfigDeclaration['owner'],
  name: string,
  opts: { optional?: boolean; default?: unknown } = {},
): ConfigDeclaration {
  return {
    owner,
    name,
    schema: { vendor: '@prisma/composer' },
    optional: opts.optional ?? false,
    default: opts.default,
  };
}

const build = {
  extension: '@prisma/composer/node',
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
    expect(node.extension).toBe('@prisma/composer-prisma-cloud');
    expect(node.name).toBe('db');
    expect(node.provides).toBe(postgresContract);
    expect('connection' in node).toBe(false);
  });
});

describe('postgres()', () => {
  test('returns a branded dependency end requiring postgresContract, declaring { url: string }', () => {
    const end = postgres();

    expect(isNode(end)).toBe(true);
    expect(end.kind).toBe('dependency');
    expect(end.type).toBe('postgres');
    expect(end.name).toBe('postgres');
    expect(end.required).toBe(postgresContract);
    expect(end.connection.params).toEqual({ url: string() });
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

  test('rejects a secret slot name that collides with a param name (same config key)', () => {
    expect(() =>
      compute({
        name: 'test-service',
        deps: {},
        params: { token: string() },
        secrets: { token: secret() },
        build,
      }),
    ).toThrow(/secret slot "token" collides with a param of the same name/);
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
  test("configKey: lone-service root (address '') has no address segment — COMPOSER_ ▸ owner ▸ name", () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });
    const [dbUrl, port] = configOf(app);
    if (dbUrl === undefined || port === undefined) throw new Error('expected config declarations');

    expect(configKey('', dbUrl)).toBe('COMPOSER_DB_URL');
    expect(configKey('', port)).toBe('COMPOSER_PORT');
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

    expect(configKey('auth', dbUrl)).toBe('COMPOSER_AUTH_DB_URL');
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
      optional: false,
      default: undefined,
    };

    expect(configKey('storefront', decl)).toBe('COMPOSER_STOREFRONT_AUTH_URL');
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

    await withEnv({ COMPOSER_DB_URL: 'postgres://x', COMPOSER_PORT: '4001' }, () => {
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

    await withEnv({ COMPOSER_PORT: 'not-a-number' }, () => {
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
    await withEnv(
      {
        COMPOSER_AUTH_DB_URL: 'postgres://x',
        COMPOSER_AUTH_PORT: '4001',
        COMPOSER_DB_URL: '',
        COMPOSER_PORT: '',
      },
      () =>
        app.run('auth', async () => {
          loaded = app.load();
        }),
    );

    expect(loaded).toEqual({ db: { url: 'postgres://x' } });
    expect(app.config()).toEqual({ port: 4001 });
  });

  test("a lone-service deploy (address '') reads and re-stashes the same COMPOSER_-prefixed keys", async () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });

    let loaded: unknown;
    await withEnv({ COMPOSER_DB_URL: 'postgres://y', COMPOSER_PORT: '' }, () =>
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
    await withEnv({ COMPOSER_DB_URL: 'postgres://dual', COMPOSER_PORT: '' }, () =>
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

  test('run() exposes the resolved service port as process.env.PORT before boot (non-default)', async () => {
    const app = compute({ name: 'ingest', deps: {}, build });
    let portAtBoot: string | undefined;
    await withEnv({ COMPOSER_INGEST_PORT: '8080', COMPOSER_PORT: '', PORT: '' }, () =>
      app.run('ingest', async () => {
        // Set before boot() runs — a framework-unaware server (Next standalone)
        // binds process.env.PORT, so it must see the port Compute routes to.
        portAtBoot = process.env['PORT'];
      }),
    );
    expect(portAtBoot).toBe('8080');
  });

  test('run() exposes the default port (3000) when none is configured', async () => {
    const app = compute({ name: 'ingest', deps: {}, build });
    let portAtBoot: string | undefined;
    await withEnv({ COMPOSER_INGEST_PORT: '', COMPOSER_PORT: '', PORT: '' }, () =>
      app.run('ingest', async () => {
        portAtBoot = process.env['PORT'];
      }),
    );
    expect(portAtBoot).toBe('3000');
  });

  test('run() re-stashes the address-scoped RPC accepted-keys var address-free (ADR-0030)', async () => {
    const app = compute({ name: 'auth', deps: {}, build });
    let seenAtBoot: string | undefined;
    await withEnv(
      {
        [serviceKeyEnvName('auth')]: '["key-a","key-b"]',
        COMPOSER_AUTH_PORT: '',
        COMPOSER_PORT: '',
        [RPC_ACCEPTED_KEYS_ENV]: '',
      },
      () =>
        app.run('auth', async () => {
          seenAtBoot = process.env[RPC_ACCEPTED_KEYS_ENV];
        }),
    );
    expect(seenAtBoot).toBe('["key-a","key-b"]');
  });

  test('run() re-stashes nothing when no accepted-keys var was written for this address', async () => {
    const app = compute({ name: 'plain', deps: {}, build });
    let seenAtBoot: string | undefined;
    await withEnv({ COMPOSER_PLAIN_PORT: '', COMPOSER_PORT: '', [RPC_ACCEPTED_KEYS_ENV]: '' }, () =>
      app.run('plain', async () => {
        seenAtBoot = process.env[RPC_ACCEPTED_KEYS_ENV];
      }),
    );
    expect(seenAtBoot).toBe('');
  });

  test("serviceKeyEnvName('') is @internal/rpc's RPC_ACCEPTED_KEYS_ENV — writer and reader cannot drift", () => {
    expect(serviceKeyEnvName('')).toBe(RPC_ACCEPTED_KEYS_ENV);
  });
});

describe('bootstrapService(service, config, boot) — the in-process integration seam', () => {
  test("stashes the given Config address-free (like run('', ...)) so the booted entry's load() reads it", async () => {
    const app = compute({ name: 'test-service', deps: { db: postgres() }, build });

    let deps: unknown;
    let cfg: unknown;
    await withEnv({ COMPOSER_DB_URL: '', COMPOSER_PORT: '' }, () =>
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
    await withEnv({ COMPOSER_DB_URL: 'stale', COMPOSER_PORT: 'stale' }, () =>
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

    await withEnv({ COMPOSER_DB_URL: 'postgres://z', COMPOSER_PORT: '' }, () => {
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
  test('configOf is semantic — owner/name/type, no platform keys', () => {
    const app = compute({
      name: 'test-service',
      deps: {
        db: postgres(),
      },
      build,
    });

    expect(configOf(app)).toEqual([
      scalarDeclaration({ input: 'db' }, 'url'),
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

    const loaded = await withEnv({ COMPOSER_DB_URL: 'postgres://fixture', COMPOSER_PORT: '' }, () =>
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
    expect(portDecl?.schema).toEqual({ vendor: '@prisma/composer' });
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

describe('secret slots — pointer rows + boot double-lookup (ADR-0029)', () => {
  const secretApp = () =>
    compute({ name: 'ingest', deps: {}, secrets: { stripeKey: secret() }, build });

  test('secretKey derives COMPOSER_<addr>_<slot>', () => {
    expect(secretKey('', 'stripeKey')).toBe('COMPOSER_STRIPEKEY');
    expect(secretKey('ingest', 'stripeKey')).toBe('COMPOSER_INGEST_STRIPEKEY');
  });

  test('the pointer key holds the platform NAME; deserializeSecrets double-looks-up the value', async () => {
    const app = secretApp();
    await withEnv(
      { [secretKey('', 'stripeKey')]: 'STRIPE_SECRET_KEY', STRIPE_SECRET_KEY: 'sk_live_abc' },
      () => {
        expect(deserializeSecrets(app, '')).toEqual({ stripeKey: 'sk_live_abc' });
      },
    );
  });

  test('a missing pointer row fails loudly', async () => {
    const app = secretApp();
    await withEnv({}, () => {
      expect(() => deserializeSecrets(app, '')).toThrow(/missing secret pointer/);
    });
  });

  test('a missing platform var fails loudly, naming both keys', async () => {
    const app = secretApp();
    await withEnv({ [secretKey('', 'stripeKey')]: 'STRIPE_SECRET_KEY' }, () => {
      expect(() => deserializeSecrets(app, '')).toThrow(/STRIPE_SECRET_KEY/);
    });
  });

  test('an empty platform var fails loudly — empty is unresolved', async () => {
    const app = secretApp();
    await withEnv(
      { [secretKey('', 'stripeKey')]: 'STRIPE_SECRET_KEY', STRIPE_SECRET_KEY: '' },
      () => {
        expect(() => deserializeSecrets(app, '')).toThrow(/unset or empty/);
      },
    );
  });

  test('secrets() returns a redacting SecretBox; it survives run() → stashSecrets → secrets() (the stash trap)', async () => {
    const app = secretApp();
    let box: SecretBox<string> | undefined;
    await withEnv(
      {
        // address-keyed pointer row + the user-provisioned platform var:
        COMPOSER_INGEST_STRIPEKEY: 'STRIPE_SECRET_KEY',
        STRIPE_SECRET_KEY: 'sk_live_trap',
        COMPOSER_INGEST_PORT: '',
        // address-free keys stashSecrets/stash (over)write — tracked so withEnv restores them:
        COMPOSER_STRIPEKEY: '',
        COMPOSER_PORT: '',
      },
      () =>
        app.run('ingest', async () => {
          box = app.secrets().stripeKey;
        }),
    );
    expect(box).toBeInstanceOf(SecretBox);
    expect(box?.expose()).toBe('sk_live_trap');
    // Redacted everywhere but expose() — if stashSecrets re-emitted the VALUE
    // instead of the POINTER, the address-free double-lookup would have thrown.
    expect(String(box)).toBe('[REDACTED]');
  });
});
