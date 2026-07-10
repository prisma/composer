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
import { type BuildAdapter, connectionEnd, hex, resource, service } from '../node.ts';
import { conn } from './helpers.ts';

const db = () =>
  resource({
    name: 'test-resource',
    pack: 'test/pack',
    type: 'fake/db',
    connection: conn({ url: { type: 'string' } }, () => ({})),
  });
const httpEnd = () =>
  connectionEnd({ type: 'fake/http', connection: conn({ url: { type: 'string' } }, () => ({})) });

const defaultBuild: BuildAdapter = {
  kind: 'node',
  pack: '@makerkit/node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const app = (
  type: string,
  inputs: Record<string, ReturnType<typeof db> | ReturnType<typeof httpEnd>>,
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
  test("matches each input's params by name to its lowered outputs, plus service-param defaults", () => {
    const root = app('fake/compute', { db: db() }, { port: { type: 'number', default: 3000 } });
    const graph = Load(root, { id: 'hello' });
    const lowered = new Map<string, LoweredNode>([
      ['hello.db', { outputs: { url: 'db://hello.db' } }],
    ]);

    expect(buildConfig(root, 'hello', graph, lowered)).toEqual({
      service: { port: 3000 },
      inputs: { db: { url: 'db://hello.db' } },
    });
  });

  test('a param the graph declares but the lowered outputs never produced resolves to undefined', () => {
    const root = app('fake/compute', { db: db() });
    const graph = Load(root, { id: 'hello' });

    expect(buildConfig(root, 'hello', graph, new Map())).toEqual({
      service: {},
      inputs: { db: { url: undefined } },
    });
  });
});

const singleServiceHex = (
  type: string,
  inputs: Record<string, ReturnType<typeof db> | ReturnType<typeof httpEnd>>,
  params: Record<string, { type: 'number' | 'string'; default?: unknown }> = {},
  build: BuildAdapter = defaultBuild,
) =>
  hex('hello', (h) => {
    h.provision('svc', app(type, inputs, params, build));
  });

describe('lowering a hex root — a single service', () => {
  test('sequences application once, then resources → provision → serialize → package → deploy', () => {
    const { target, calls } = fakeTarget();
    const root = singleServiceHex('fake/compute', { db: db() });

    const result = run(
      lowering(
        root,
        target,
        opts({ bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } }),
      ),
    );

    expect(calls.map((c) => c.phase)).toEqual([
      'application',
      'resource',
      'provision',
      'serialize',
      'package',
      'deploy',
    ]);
    // The root is always a hex — its own lowering has no outputs yet
    // (boundary ports are future work); see the two-service suite below.
    expect(result).toEqual({ outputs: {} });
  });

  test("buildConfig is fed to serialize with the resource's real lowered output", () => {
    const { target, calls } = fakeTarget();
    const root = singleServiceHex(
      'fake/compute',
      { db: db() },
      { port: { type: 'number', default: 3000 } },
    );

    run(
      lowering(
        root,
        target,
        opts({ bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } }),
      ),
    );

    const serialize = calls.find((c) => c.phase === 'serialize');
    expect(serialize).toMatchObject({
      config: { service: { port: 3000 }, inputs: { db: { url: 'db://svc.db' } } },
    });
  });

  test('package receives the build adapter output dir/entry and the same address serialize used', () => {
    const { target, calls } = fakeTarget();
    const root = singleServiceHex('fake/compute', {});
    const bundle: Bundle = { dir: 'dist/bundle', entry: 'main.mjs' };

    run(lowering(root, target, opts({ bundles: { svc: bundle } })));

    const pkg = calls.find((c) => c.phase === 'package');
    expect(pkg).toMatchObject({ assembled: bundle, address: 'svc' });
  });

  test("the environment edge: deploy's `environment` IS serialize's returned records (by recording, not order)", () => {
    const { target, calls } = fakeTarget();
    const root = singleServiceHex('fake/compute', { db: db() });

    run(
      lowering(
        root,
        target,
        opts({ bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } }),
      ),
    );

    const serialize = calls.find((c) => c.phase === 'serialize');
    const deploy = calls.find((c) => c.phase === 'deploy');
    expect(serialize).toBeDefined();
    expect(deploy).toBeDefined();
    if (serialize?.phase !== 'serialize' || deploy?.phase !== 'deploy')
      throw new Error('unreachable');
    expect(deploy.environment).toEqual([{ input: 'db', name: 'url', value: 'db://svc.db' }]);
    // Same records the serialize call's own return produced (identity, not
    // a coincidental re-derivation) — the fake target only ever returns them
    // once, from serialize, and threads them through to deploy's argument.
  });

  test('the build descriptor is inert to lowering — any kind/entry lowers identically', () => {
    const { target } = fakeTarget();
    const root = singleServiceHex(
      'fake/compute',
      { db: db() },
      {},
      {
        kind: 'nonsense',
        pack: '@fake/adapter',
        module: 'file:///test/service.ts',
        entry: 'whatever.js',
      },
    );

    const result = run(
      lowering(
        root,
        target,
        opts({ bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } }),
      ),
    );

    expect(result).toEqual({ outputs: {} });
  });

  test('missing a bundle for a single-service hex is a LowerError naming it', () => {
    const { target } = fakeTarget();
    const root = singleServiceHex('fake/compute', {});

    const error = runError(lowering(root, target, opts()));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('opts.bundles["svc"]');
  });

  test('fails with LowerError naming the type and the known types on an unknown resource type', () => {
    const { target } = fakeTarget();
    const root = singleServiceHex('fake/compute', {
      cache: resource({
        name: 'test-resource',
        pack: 'test/pack',
        type: 'fake/unknown',
        connection: conn({}, () => ({})),
      }),
    });

    const error = runError(
      lowering(
        root,
        target,
        opts({ bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } }),
      ),
    );

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('fake/unknown');
    expect(error.message).toContain('fake/db');
  });

  test('fails with LowerError naming the type and the known types on an unknown service type', () => {
    const { target } = fakeTarget();
    const root = singleServiceHex('fake/other-compute', {});

    const error = runError(
      lowering(
        root,
        target,
        opts({ bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } }),
      ),
    );

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('fake/other-compute');
    expect(error.message).toContain('fake/compute');
  });
});

describe('lowering a hex root — two connected services', () => {
  const authService = () => app('fake/compute', { db: db() });
  const storefrontService = () => app('fake/compute', { auth: httpEnd() });

  const twoServiceHex = () =>
    hex('shop', (h) => {
      const authRef = h.provision('auth', authService());
      h.provision('storefront', storefrontService(), { auth: authRef });
    });

  test("application provisions once; auth is FULLY deployed before storefront's serialize", () => {
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
      'resource:auth.db',
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

  test("the environment edge holds for the hex too: storefront's deploy environment IS its serialize records", () => {
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

    const storefrontDeploy = calls.find((c) => c.phase === 'deploy' && c.id === 'storefront');
    expect(storefrontDeploy).toMatchObject({
      environment: [{ input: 'auth', name: 'url', value: 'https://auth.example' }],
    });
  });

  test('topo sort: a hex authored consumer-before-producer (forged ref) still resolves real producer outputs at deploy', () => {
    // Mirrors the hex.test.ts graph-layer topo-sort test, but exercises the
    // consequence: before the sort, buildConfig read `lowered.get(edge.from)`
    // positionally, so a consumer walked before its producer saw undefined
    // outputs. With the sort, the producer is fully deployed first.
    const { target, calls } = fakeTarget();
    const root = hex('shop', (h) => {
      h.provision('storefront', storefrontService(), {
        auth: { id: 'auth' } as never,
      });
      h.provision('auth', authService());
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
