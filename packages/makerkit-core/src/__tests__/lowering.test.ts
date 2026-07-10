import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import type { Config } from '../config.ts';
import {
  type AlchemyStateLayer,
  type Artifact,
  type Bundle,
  buildConfig,
  LowerError,
  type LoweredNode,
  type LowerOptions,
  lower,
  lowering,
  resolveStateLayer,
  type Target,
} from '../deploy.ts';
import { Load } from '../graph.ts';
import { type BuildAdapter, type Deps, dependency, hex, resource, service } from '../node.ts';
import { conn, providerContract } from './helpers.ts';

const dbResource = () =>
  resource({ name: 'db', pack: 'test/pack', provides: providerContract('fake/db', { url: '' }) });
const dbEnd = () =>
  dependency({
    name: 'db',
    type: 'fake/db',
    connection: conn({ url: { type: 'string' } }, () => ({})),
    required: providerContract('fake/db', { url: '' }),
  });
const httpEnd = () =>
  dependency({ type: 'fake/http', connection: conn({ url: { type: 'string' } }, () => ({})) });

const defaultBuild: BuildAdapter = {
  kind: 'node',
  pack: '@makerkit/node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const app = <D extends Deps>(
  type: string,
  inputs: D,
  params: Record<string, { type: 'number' | 'string'; default?: unknown }> = {},
  build: BuildAdapter = defaultBuild,
) =>
  service({
    name: 'test-service',
    pack: 'test/pack',
    type,
    inputs,
    params: params as never,
    build,
  });

const opts = (extra: Partial<LowerOptions> = {}): LowerOptions => ({
  name: 'hello',
  bundles: {},
  ...extra,
});

// ——— A fake target that records every call it receives, instead of driving
// real Alchemy resources — the same recording strategy the old single-phase
// suite used, extended to the phased SPI. Lets us assert the "environment
// edge" (serialize's records reaching deploy) by inspecting what was
// recorded, never by assuming call order.
type Call =
  | { readonly phase: 'application'; readonly id: string }
  | { readonly phase: 'resource'; readonly id: string; readonly type: string }
  | { readonly phase: 'provision'; readonly id: string; readonly address: string }
  | {
      readonly phase: 'serialize';
      readonly id: string;
      readonly address: string;
      readonly config: Config;
    }
  | {
      readonly phase: 'package';
      readonly id: string;
      readonly assembled: Bundle;
      readonly address: string;
    }
  | {
      readonly phase: 'deploy';
      readonly id: string;
      readonly artifact: Artifact;
      readonly environment: unknown;
    };

function fakeTarget() {
  const calls: Call[] = [];
  const target: Target = {
    name: 'fake',
    providers: () => {
      throw new Error('providers() must not be called by lowering()');
    },
    // Every target must supply a default state layer now (Target.state is
    // required); this fake's is a sentinel, never booted by these tests
    // (which drive `lowering()`, not `lower()`'s Alchemy.Stack wrapping).
    state: () => ({ __sentinel: 'fake-target-default' }) as unknown as AlchemyStateLayer,
    application: {
      provision: (ctx) => {
        calls.push({ phase: 'application', id: ctx.id });
        return Effect.succeed({ outputs: { projectId: `${ctx.id}#project` } });
      },
    },
    resources: {
      'fake/db': (ctx) => {
        calls.push({ phase: 'resource', id: ctx.id, type: ctx.node.type });
        return Effect.succeed({ outputs: { url: `db://${ctx.id}` } });
      },
    },
    services: {
      'fake/compute': {
        provision: (ctx) => {
          calls.push({ phase: 'provision', id: ctx.id, address: ctx.address });
          return Effect.succeed({
            outputs: {
              serviceId: `${ctx.id}#svc`,
              projectId: ctx.application.outputs['projectId'],
            },
          });
        },
        serialize: (ctx, _provisioned, config) => {
          calls.push({ phase: 'serialize', id: ctx.id, address: ctx.address, config });
          // One "record" per Config leaf — mirrors the real pack's one
          // EnvironmentVariable per leaf, keyed by input+name.
          const records = Object.entries(config.inputs).flatMap(([input, values]) =>
            Object.entries(values).map(([name, value]) => ({ input, name, value })),
          );
          return Effect.succeed({ outputs: { environment: records } });
        },
        package: (ctx, input) => {
          calls.push({
            phase: 'package',
            id: ctx.id,
            assembled: input.assembled,
            address: input.address,
          });
          return Effect.succeed({ path: `/tmp/${ctx.id}.tar.gz`, sha256: `sha-${ctx.id}` });
        },
        deploy: (ctx, provisioned, artifact, serialized) => {
          calls.push({
            phase: 'deploy',
            id: ctx.id,
            artifact,
            environment: serialized.outputs['environment'],
          });
          return Effect.succeed({
            outputs: {
              url: `https://${ctx.id}.example`,
              projectId: provisioned.outputs['projectId'],
            },
          });
        },
      },
    },
  };
  return { target, calls };
}

const run = (eff: ReturnType<typeof lowering>): LoweredNode =>
  Effect.runSync(eff as Effect.Effect<LoweredNode, LowerError>);
const runError = (eff: ReturnType<typeof lowering>): LowerError =>
  Effect.runSync(Effect.flip(eff as Effect.Effect<LoweredNode, LowerError>));

describe('buildConfig', () => {
  test("matches a dependency input's params by name to the wired producer's lowered outputs, via its dependency edge", () => {
    const auth = app('fake/compute', { db: dbEnd() }, { port: { type: 'number', default: 3000 } });
    const root = hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      h.provision('auth', auth, { db });
    });
    const graph = Load(root);
    const lowered = new Map<string, LoweredNode>([['db', { outputs: { url: 'db://db' } }]]);

    expect(buildConfig(auth, 'auth', graph, lowered)).toEqual({
      service: { port: 3000 },
      inputs: { db: { url: 'db://db' } },
    });
  });

  test('a param the graph declares but the lowered outputs never produced resolves to undefined', () => {
    const auth = app('fake/compute', { db: dbEnd() });
    const root = hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      h.provision('auth', auth, { db });
    });
    const graph = Load(root);

    expect(buildConfig(auth, 'auth', graph, new Map())).toEqual({
      service: {},
      inputs: { db: { url: undefined } },
    });
  });
});

const singleServiceHex = (
  type: string,
  params: Record<string, { type: 'number' | 'string'; default?: unknown }> = {},
  build: BuildAdapter = defaultBuild,
) =>
  hex('hello', (h) => {
    h.provision('svc', app(type, {}, params, build));
  });

// A single service whose one dependency is a hex-provisioned db resource â
// the resource model's minimal shape: a service never embeds a resource; the
// hex provisions it and wires the slot.
const singleServiceWithDbHex = (
  params: Record<string, { type: 'number' | 'string'; default?: unknown }> = {},
) =>
  hex('hello', (h) => {
    const db = h.provision('db', dbResource());
    h.provision('svc', app('fake/compute', { db: dbEnd() }, params), { db });
  });

const svcBundles = { bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } };

describe('lowering a hex root â a single service', () => {
  test('a dependency-less service sequences application → provision → serialize → package → deploy; nothing is auto-provisioned', () => {
    const { target, calls } = fakeTarget();
    const root = singleServiceHex('fake/compute');

    const result = run(lowering(root, target, opts(svcBundles)));

    expect(calls.map((c) => c.phase)).toEqual([
      'application',
      'provision',
      'serialize',
      'package',
      'deploy',
    ]);
    // The root is always a hex — its own lowering has no outputs yet
    // (boundary ports are future work); see the two-service suite below.
    expect(result).toEqual({ outputs: {} });
  });

  test('a hex-provisioned resource lowers before the service that consumes it', () => {
    const { target, calls } = fakeTarget();
    const root = singleServiceWithDbHex();

    run(lowering(root, target, opts(svcBundles)));

    expect(calls.map((c) => c.phase)).toEqual([
      'application',
      'resource',
      'provision',
      'serialize',
      'package',
      'deploy',
    ]);
  });

  test("buildConfig is fed to serialize with the resource's real lowered output", () => {
    const { target, calls } = fakeTarget();
    const root = singleServiceWithDbHex({ port: { type: 'number', default: 3000 } });

    run(lowering(root, target, opts(svcBundles)));

    const serialize = calls.find((c) => c.phase === 'serialize');
    expect(serialize).toMatchObject({
      config: { service: { port: 3000 }, inputs: { db: { url: 'db://db' } } },
    });
  });

  test('package receives the build adapter output dir/entry and the same address serialize used', () => {
    const { target, calls } = fakeTarget();
    const root = singleServiceHex('fake/compute');
    const bundle: Bundle = { dir: 'dist/bundle', entry: 'main.mjs' };

    run(lowering(root, target, opts({ bundles: { svc: bundle } })));

    const pkg = calls.find((c) => c.phase === 'package');
    expect(pkg).toMatchObject({ assembled: bundle, address: 'svc' });
  });

  test("the environment edge: deploy's `environment` IS serialize's returned records (by recording, not order)", () => {
    const { target, calls } = fakeTarget();
    const root = singleServiceWithDbHex();

    run(lowering(root, target, opts(svcBundles)));

    const serialize = calls.find((c) => c.phase === 'serialize');
    const deploy = calls.find((c) => c.phase === 'deploy');
    expect(serialize).toBeDefined();
    expect(deploy).toBeDefined();
    if (serialize?.phase !== 'serialize' || deploy?.phase !== 'deploy')
      throw new Error('unreachable');
    expect(deploy.environment).toEqual([{ input: 'db', name: 'url', value: 'db://db' }]);
    // Same records the serialize call's own return produced (identity, not
    // a coincidental re-derivation) — the fake target only ever returns them
    // once, from serialize, and threads them through to deploy's argument.
  });

  test('the build descriptor is inert to lowering — any kind/entry lowers identically', () => {
    const { target } = fakeTarget();
    const root = singleServiceHex(
      'fake/compute',
      {},
      {
        kind: 'nonsense',
        pack: '@fake/adapter',
        module: 'file:///test/service.ts',
        entry: 'whatever.js',
      },
    );

    const result = run(lowering(root, target, opts(svcBundles)));

    expect(result).toEqual({ outputs: {} });
  });

  test('missing a bundle for a single-service hex is a LowerError naming it', () => {
    const { target } = fakeTarget();
    const root = singleServiceHex('fake/compute');

    const error = runError(lowering(root, target, opts()));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('opts.bundles["svc"]');
  });

  test('fails with LowerError naming the type and the known types on an unknown service type', () => {
    const { target } = fakeTarget();
    const root = singleServiceHex('fake/other-compute');

    const error = runError(lowering(root, target, opts(svcBundles)));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('fake/other-compute');
    expect(error.message).toContain('fake/compute');
  });
});

describe('lowering a hex root — a provisioned resource and two connected services', () => {
  const authService = () => app('fake/compute', { db: dbEnd() });
  const storefrontService = () => app('fake/compute', { auth: httpEnd() });

  const twoServiceHex = () =>
    hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      const authRef = h.provision('auth', authService(), { db });
      h.provision('storefront', storefrontService(), { auth: authRef });
    });

  test("application provisions once; the resource and auth are FULLY deployed before storefront's serialize", () => {
    const { target, calls } = fakeTarget();

    run(
      lowering(twoServiceHex(), target, {
        name: 'shop',
        bundles: {
          auth: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'hexes/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    expect(calls.filter((c) => c.phase === 'application')).toHaveLength(1);

    const order = calls.map((c) => (c.phase === 'application' ? c.phase : `${c.phase}:${c.id}`));
    expect(order).toEqual([
      'application',
      'resource:db',
      'provision:auth',
      'serialize:auth',
      'package:auth',
      'deploy:auth',
      'provision:storefront',
      'serialize:storefront',
      'package:storefront',
      'deploy:storefront',
    ]);
  });

  test("each hex-provisioned service's address is its own provision id", () => {
    const { target, calls } = fakeTarget();

    run(
      lowering(twoServiceHex(), target, {
        name: 'shop',
        bundles: {
          auth: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'hexes/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    const authProvision = calls.find((c) => c.phase === 'provision' && c.id === 'auth');
    const storefrontProvision = calls.find((c) => c.phase === 'provision' && c.id === 'storefront');
    expect(authProvision).toMatchObject({ address: 'auth' });
    expect(storefrontProvision).toMatchObject({ address: 'storefront' });
  });

  test("auth's Config.inputs.db carries the hex-provisioned resource's lowered url", () => {
    const { target, calls } = fakeTarget();

    run(
      lowering(twoServiceHex(), target, {
        name: 'shop',
        bundles: {
          auth: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'hexes/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    const authSerialize = calls.find((c) => c.phase === 'serialize' && c.id === 'auth');
    expect(authSerialize).toMatchObject({
      config: { inputs: { db: { url: 'db://db' } } },
    });
  });

  test("storefront's Config.inputs.auth carries auth's REAL deploy-phase URL, not a placeholder", () => {
    const { target, calls } = fakeTarget();

    run(
      lowering(twoServiceHex(), target, {
        name: 'shop',
        bundles: {
          auth: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'hexes/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    const storefrontSerialize = calls.find((c) => c.phase === 'serialize' && c.id === 'storefront');
    expect(storefrontSerialize).toMatchObject({
      config: { inputs: { auth: { url: 'https://auth.example' } } },
    });
  });

  test("the environment edge: auth's deploy environment IS its serialize records, resource url included", () => {
    const { target, calls } = fakeTarget();

    run(
      lowering(twoServiceHex(), target, {
        name: 'shop',
        bundles: {
          auth: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'hexes/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    const authDeploy = calls.find((c) => c.phase === 'deploy' && c.id === 'auth');
    expect(authDeploy).toMatchObject({
      environment: [{ input: 'db', name: 'url', value: 'db://db' }],
    });
    // Same records the serialize call's own return produced (identity, not
    // a coincidental re-derivation) — the fake target only ever returns them
    // once, from serialize, and threads them through to deploy's argument.
  });

  test('topo sort: a hex authored consumer-before-producer (forged ref) still resolves real producer outputs at deploy', () => {
    // Mirrors the hex.test.ts graph-layer topo-sort test, but exercises the
    // consequence: before the sort, buildConfig read `lowered.get(edge.from)`
    // positionally, so a consumer walked before its producer saw undefined
    // outputs. With the sort, the producer is fully deployed first.
    const { target, calls } = fakeTarget();
    const root = hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      h.provision('storefront', storefrontService(), {
        auth: { id: 'auth' } as never,
      });
      h.provision('auth', authService(), { db });
    });

    run(
      lowering(root, target, {
        name: 'shop',
        bundles: {
          auth: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'hexes/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    const authDeploy = calls.findIndex((c) => c.phase === 'deploy' && c.id === 'auth');
    const storefrontSerializeIndex = calls.findIndex(
      (c) => c.phase === 'serialize' && c.id === 'storefront',
    );
    expect(authDeploy).toBeGreaterThanOrEqual(0);
    expect(authDeploy).toBeLessThan(storefrontSerializeIndex);

    const storefrontSerialize = calls.find((c) => c.phase === 'serialize' && c.id === 'storefront');
    expect(storefrontSerialize).toMatchObject({
      config: { inputs: { auth: { url: 'https://auth.example' } } },
    });
  });

  test('missing a bundle entry for one hex-provisioned service is a LowerError naming it', () => {
    const { target } = fakeTarget();

    const error = runError(
      lowering(twoServiceHex(), target, {
        name: 'shop',
        bundles: { auth: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' } },
      }),
    );

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('opts.bundles["storefront"]');
  });

  test("a hex root's own lowering has no outputs yet (boundary ports are future work)", () => {
    const { target } = fakeTarget();

    const result = run(
      lowering(twoServiceHex(), target, {
        name: 'shop',
        bundles: {
          auth: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'hexes/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    expect(result).toEqual({ outputs: {} });
  });

  test('fails with LowerError naming the type and the known types on an unknown resource type', () => {
    const { target } = fakeTarget();
    const root = hex('shop', (h) => {
      h.provision(
        'cache',
        resource({
          name: 'cache',
          pack: 'test/pack',
          provides: providerContract('fake/unknown', {}),
        }),
      );
    });

    const error = runError(lowering(root, target, { name: 'shop', bundles: {} }));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('fake/unknown');
    expect(error.message).toContain('fake/db');
  });
});

describe('lowering a hex root — one resource shared by two consumers', () => {
  const sharedHex = () =>
    hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      h.provision('auth', app('fake/compute', { authDb: dbEnd() }), { authDb: db });
      h.provision('billing', app('fake/compute', { billingDb: dbEnd() }), { billingDb: db });
    });

  const sharedOpts = {
    name: 'shop',
    bundles: {
      auth: { dir: 'hexes/auth/dist/bundle', entry: 'server.js' },
      billing: { dir: 'hexes/billing/dist/bundle', entry: 'server.js' },
    },
  };

  test('the resource is lowered exactly once, regardless of consumer count', () => {
    const { target, calls } = fakeTarget();

    run(lowering(sharedHex(), target, sharedOpts));

    expect(calls.filter((c) => c.phase === 'resource')).toEqual([
      { phase: 'resource', id: 'db', type: 'fake/db' },
    ]);
  });

  test("both consumers' Configs receive the ONE resource's outputs, each under its own dep key", () => {
    const { target, calls } = fakeTarget();

    run(lowering(sharedHex(), target, sharedOpts));

    const authSerialize = calls.find((c) => c.phase === 'serialize' && c.id === 'auth');
    const billingSerialize = calls.find((c) => c.phase === 'serialize' && c.id === 'billing');
    expect(authSerialize).toMatchObject({
      config: { inputs: { authDb: { url: 'db://db' } } },
    });
    expect(billingSerialize).toMatchObject({
      config: { inputs: { billingDb: { url: 'db://db' } } },
    });
  });
});

describe('lower()', () => {
  test('builds an Alchemy Stack wrapping the same lowering', () => {
    // Unlike lowering(), lower() DOES call target.providers() eagerly (to
    // hand it to Alchemy.Stack) — a different fake target than the
    // lowering()-only suite above, which asserts the opposite.
    const target: Target = { ...fakeTarget().target, providers: () => ({}) as never };
    const root = singleServiceHex('fake/compute', {});

    const stack = lower(
      root,
      target,
      opts({ bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } }),
    );

    expect(stack).toBeDefined();
  });
});

describe('resolveStateLayer', () => {
  // Sentinel objects, not real Alchemy Layers — resolveStateLayer is a pure
  // selector, so identity comparison against sentinels proves precedence
  // without booting Alchemy.
  const sentinel = (tag: string): AlchemyStateLayer =>
    ({ __sentinel: tag }) as unknown as AlchemyStateLayer;

  test('opts.state wins over target.state', () => {
    const optsState = sentinel('opts');
    const target: Target = { ...fakeTarget().target, state: () => sentinel('target') };

    expect(resolveStateLayer(opts({ state: optsState }), target)).toBe(optsState);
  });

  test('target.state is used when opts.state is absent — every target must supply one', () => {
    const targetState = sentinel('target');
    const target: Target = { ...fakeTarget().target, state: () => targetState };

    expect(resolveStateLayer(opts(), target)).toBe(targetState);
  });
});
