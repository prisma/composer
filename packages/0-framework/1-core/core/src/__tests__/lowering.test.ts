import { describe, expect, test } from 'bun:test';
import { blindCast } from '@internal/foundation/casts';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { Config, Params } from '../config.ts';
import { number, string } from '../config.ts';
import type { ExtensionDescriptor, PrismaAppConfig } from '../exports/app-config.ts';
import {
  type AlchemyStateLayer,
  type Artifact,
  type Bundle,
  buildConfig,
  joinDeployment,
  type LowerContext,
  LowerError,
  type LoweredResult,
  type LowerOptions,
  lower,
  lowering,
  mergedProviders,
  type Outputs,
  type ProvisionEdge,
  type ProvisionerDescriptor,
  resolveStateLayer,
  type ServiceLowering,
} from '../exports/deploy.ts';
import { Load } from '../graph.ts';
import {
  type BuildAdapter,
  type Deps,
  dependency,
  isParamSource,
  module,
  paramSource,
  provisionNeed,
  resource,
  service,
} from '../node.ts';
import { conn, providerContract } from './helpers.ts';

const dbResource = () =>
  resource({
    name: 'db',
    extension: 'test/pack',
    provides: providerContract('fake/db', { url: '' }),
  });
const dbEnd = () =>
  dependency({
    name: 'db',
    type: 'fake/db',
    connection: conn({ url: string() }, () => ({})),
    required: providerContract('fake/db', { url: '' }),
  });
const httpEnd = () =>
  dependency({ type: 'fake/http', connection: conn({ url: string() }, () => ({})) });

const defaultBuild: BuildAdapter = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const app = <D extends Deps, P extends Params = Record<never, never>>(
  type: string,
  inputs: D,
  params: P = blindCast<
    P,
    'test helper default; the empty map satisfies every P callers actually pass'
  >({}),
  build: BuildAdapter = defaultBuild,
) =>
  service({
    name: 'test-service',
    extension: 'test/pack',
    type,
    inputs,
    params,
    build,
  });

const stateSentinel = (tag: string): AlchemyStateLayer =>
  ({ __sentinel: tag }) as unknown as AlchemyStateLayer;

const opts = (extra: Partial<LowerOptions> = {}): LowerOptions => ({
  name: 'hello',
  bundles: {},
  ...extra,
});

// ——— A fake extension that records every call it receives, instead of driving
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

// The fake 'fake/compute' descriptor's own intra-node handoff types — stand-
// ins for a real extension's descriptor-owned provision/serialize products.
interface FakeProvisioned {
  readonly serviceId: string;
  readonly projectId: string;
}
interface FakeSerialized {
  readonly environment: ReadonlyArray<{ input: string; name: string; value: unknown }>;
}

function fakeExtension(opts: { provisions?: ReadonlyMap<symbol, ProvisionerDescriptor> } = {}) {
  const calls: Call[] = [];
  const descriptor: ExtensionDescriptor = {
    id: 'test/pack',
    providers: () => {
      throw new Error('providers() must not be called by lowering()');
    },
    ...(opts.provisions !== undefined ? { provisions: opts.provisions } : {}),
    application: {
      provision: (ctx) => {
        calls.push({ phase: 'application', id: ctx.id });
        return Effect.succeed({ projectId: `${ctx.id}#project` });
      },
    },
    nodes: {
      'fake/db': Object.assign(
        (ctx: LowerContext): Effect.Effect<LoweredResult, unknown, unknown> => {
          calls.push({ phase: 'resource', id: ctx.id, type: ctx.node.type });
          return Effect.succeed({
            outputs: { url: `db://${ctx.id}` },
            entities: [{ kind: 'fake-db', id: `${ctx.id}#db` }],
          });
        },
        { kind: 'resource' as const },
      ),
      'fake/compute': {
        kind: 'service' as const,
        provision: (ctx) => {
          calls.push({ phase: 'provision', id: ctx.id, address: ctx.address });
          // ctx.application is `unknown` by design — core never reads the
          // application hook's product. A real extension narrows it with its
          // own type guard; this fake asserts its own hook's shape.
          const application = ctx.application as { projectId: string };
          return Effect.succeed({
            serviceId: `${ctx.id}#svc`,
            projectId: application.projectId,
          });
        },
        serialize: (ctx, _provisioned, config) => {
          calls.push({ phase: 'serialize', id: ctx.id, address: ctx.address, config });
          // One "record" per Config leaf — mirrors the real extension's one
          // EnvironmentVariable per leaf, keyed by input+name.
          const records = Object.entries(config.inputs).flatMap(([input, values]) =>
            Object.entries(values).map(([name, value]) => ({ input, name, value })),
          );
          return Effect.succeed({ environment: records });
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
            environment: serialized.environment,
          });
          return Effect.succeed({
            outputs: { url: `https://${ctx.id}.example`, projectId: provisioned.projectId },
            entities: [
              { kind: 'fake-compute', id: provisioned.serviceId, url: `https://${ctx.id}.example` },
            ],
          });
        },
      } satisfies { readonly kind: 'service' } & ServiceLowering<FakeProvisioned, FakeSerialized>,
    },
  };
  const config: PrismaAppConfig = {
    extensions: [descriptor],
    state: () => stateSentinel('config-default'),
  };
  return { descriptor, config, calls };
}

const run = (eff: ReturnType<typeof lowering>): undefined =>
  Effect.runSync(eff as Effect.Effect<undefined, LowerError>);
const runError = (eff: ReturnType<typeof lowering>): LowerError =>
  Effect.runSync(Effect.flip(eff as Effect.Effect<undefined, LowerError>));

describe('buildConfig', () => {
  test("matches a dependency input's params by name to the wired producer's lowered outputs, via its dependency edge", () => {
    const auth = app('fake/compute', { db: dbEnd() }, { port: number({ default: 3000 }) });
    const root = module('shop', {}, (h) => {
      const db = h.provision(dbResource(), { id: 'db' });
      h.provision(auth, { id: 'auth', deps: { db } });
      return {};
    });
    const graph = Load(root);
    const lowered = new Map<string, Outputs>([['db', { url: 'db://db' }]]);

    expect(buildConfig(auth, 'auth', graph, lowered, new Map())).toEqual({
      service: { port: 3000 },
      inputs: { db: { url: 'db://db' } },
    });
  });

  // ——— The connection contract (S2). The consumer's connection declaration IS the
  // contract (ADR-0033): core resolves each declared param by name against the
  // producer's outputs. A producer that under-delivers used to hand the
  // consumer a silent `undefined`, which serialized into its environment and
  // failed at the consumer's boot — far from the mistake. It now fails the
  // deploy, naming the edge.

  test('a producer that omits a declared required param fails the deploy, naming the edge, the param, the producer, and what the producer DID supply', () => {
    const auth = app('fake/compute', { db: dbEnd() });
    const root = module('shop', {}, (h) => {
      const db = h.provision(dbResource(), { id: 'db' });
      h.provision(auth, { id: 'auth', deps: { db } });
      return {};
    });
    const graph = Load(root);
    // The producer lowered, but its outputs carry no `url` — the exact
    // param `dbEnd()`'s connection declares and does not mark optional.
    const lowered = new Map<string, Outputs>([['db', { host: 'db.internal' }]]);

    const build = () => buildConfig(auth, 'auth', graph, lowered, new Map());

    expect(build).toThrow(LowerError);
    expect(build).toThrow(/"auth\.db"/); // the edge id
    expect(build).toThrow(/"url"/); // the param
    expect(build).toThrow(/"db"/); // the producer
    expect(build).toThrow(/host/); // the producer's actual key list
  });

  test('a producer supplying nothing at all names an empty key list, not a confusing blank', () => {
    const auth = app('fake/compute', { db: dbEnd() });
    const root = module('shop', {}, (h) => {
      const db = h.provision(dbResource(), { id: 'db' });
      h.provision(auth, { id: 'auth', deps: { db } });
      return {};
    });
    const graph = Load(root);

    // `lowered` empty: the producer is wired but produced no outputs.
    expect(() => buildConfig(auth, 'auth', graph, new Map(), new Map())).toThrow(/nothing/);
  });

  test('a declared param the consumer marked optional is exempt — absent stays undefined, no error', () => {
    const optionalDbEnd = () =>
      dependency({
        name: 'db',
        type: 'fake/db',
        connection: conn({ url: string({ optional: true }) }, () => ({})),
        required: providerContract('fake/db', { url: '' }),
      });
    const auth = app('fake/compute', { db: optionalDbEnd() });
    const root = module('shop', {}, (h) => {
      const db = h.provision(dbResource(), { id: 'db' });
      h.provision(auth, { id: 'auth', deps: { db } });
      return {};
    });
    const graph = Load(root);

    // The consumer said absent is legal, so the producer under-delivering is
    // not a contract breach — boot's coerce() reads a missing var as absent.
    expect(buildConfig(auth, 'auth', graph, new Map(), new Map())).toEqual({
      service: {},
      inputs: { db: { url: undefined } },
    });
  });

  test('an unwired input (no dependency edge) keeps resolving to undefined — the guard only judges a producer that exists', () => {
    const auth = app('fake/compute', { db: dbEnd() });
    const root = module('shop', {}, (h) => {
      const db = h.provision(dbResource(), { id: 'db' });
      h.provision(auth, { id: 'auth', deps: { db } });
      return {};
    });
    // The authoring API will not let a declared input go unwired —
    // `h.provision(auth, { id: 'auth' })` does not type-check — so `db` is
    // wired here and its edge then dropped. That reaches buildConfig's
    // `edge === undefined` branch, which is defensive rather than authorable.
    // With no edge there is no producer to hold to the contract, so the guard
    // must stay out of it: an unwired input is a graph-construction concern.
    const graph = Load(root);
    const withoutEdges = { ...graph, edges: graph.edges.filter((e) => e.kind !== 'dependency') };

    expect(buildConfig(auth, 'auth', withoutEdges, new Map(), new Map())).toEqual({
      service: {},
      inputs: { db: { url: undefined } },
    });
  });

  test("a param carrying a provision need sources its value from `provisioned` (keyed by edge id), not the producer's outputs", () => {
    const BRAND = Symbol('test-provision-brand');
    const tokenEnd = () =>
      dependency({
        name: 'auth',
        type: 'fake/rpc',
        connection: conn(
          { token: string({ optional: true, provision: provisionNeed(BRAND) }) },
          () => ({}),
        ),
      });
    const consumer = app('fake/compute', { auth: tokenEnd() });
    const root = module('shop', {}, (h) => {
      const authRef = h.provision(app('fake/compute', {}), { id: 'auth' });
      h.provision(consumer, { id: 'consumer', deps: { auth: authRef } });
      return {};
    });
    const graph = Load(root);
    // The producer IS lowered (with some unrelated output), but a provisioned
    // param must ignore it entirely — its value comes only from `provisioned`.
    const lowered = new Map<string, Outputs>([['auth', { token: 'wrong-value' }]]);
    const provisioned = new Map<string, unknown>([['consumer.auth', 'minted-value']]);

    expect(buildConfig(consumer, 'consumer', graph, lowered, provisioned)).toEqual({
      service: {},
      inputs: { auth: { token: 'minted-value' } },
    });
  });

  test('a REQUIRED provisioned param is exempt from the connection contract — the mint supplies it, the producer hands nothing over (ADR-0031)', () => {
    const BRAND = Symbol('test-provision-brand');
    // Deliberately NOT optional: this pins that the provision branch is exempt
    // on its own, rather than incidentally passing because it was optional.
    const tokenEnd = () =>
      dependency({
        name: 'auth',
        type: 'fake/rpc',
        connection: conn({ token: string({ provision: provisionNeed(BRAND) }) }, () => ({})),
      });
    const consumer = app('fake/compute', { auth: tokenEnd() });
    const root = module('shop', {}, (h) => {
      const authRef = h.provision(app('fake/compute', {}), { id: 'auth' });
      h.provision(consumer, { id: 'consumer', deps: { auth: authRef } });
      return {};
    });
    const graph = Load(root);
    // The producer supplies NOTHING — which for a non-provisioned required
    // param would now be a LowerError. Here the mint is the source.
    const provisioned = new Map<string, unknown>([['consumer.auth', 'minted-value']]);

    expect(buildConfig(consumer, 'consumer', graph, new Map(), provisioned)).toEqual({
      service: {},
      inputs: { auth: { token: 'minted-value' } },
    });
  });
});

describe('buildConfig — provision-time param binding', () => {
  test('a provision-time literal overrides the param default', () => {
    const auth = app('fake/compute', {}, { port: number({ default: 3000 }) });
    const root = module('shop', {}, (h) => {
      h.provision(auth, { id: 'auth', params: { port: 8080 } });
      return {};
    });
    const graph = Load(root);

    expect(buildConfig(auth, 'auth', graph, new Map(), new Map())).toEqual({
      service: { port: 8080 },
      inputs: {},
    });
  });

  test('an unbound param falls back to its default', () => {
    const auth = app('fake/compute', {}, { port: number({ default: 3000 }) });
    const root = module('shop', {}, (h) => {
      h.provision(auth, { id: 'auth' });
      return {};
    });
    const graph = Load(root);

    expect(buildConfig(auth, 'auth', graph, new Map(), new Map())).toEqual({
      service: { port: 3000 },
      inputs: {},
    });
  });

  test('a param with no default, not optional, and never bound fails loudly, naming the param and the service', () => {
    const auth = app('fake/compute', {}, { origin: string() });
    const root = module('shop', {}, (h) => {
      h.provision(auth, { id: 'auth' });
      return {};
    });
    const graph = Load(root);

    expect(() => buildConfig(auth, 'auth', graph, new Map(), new Map())).toThrow(LowerError);
    expect(() => buildConfig(auth, 'auth', graph, new Map(), new Map())).toThrow(/"origin"/);
    expect(() => buildConfig(auth, 'auth', graph, new Map(), new Map())).toThrow(/"auth"/);
  });

  test('an optional param with no default and never bound resolves to absent, not an error', () => {
    const auth = app('fake/compute', {}, { origin: string({ optional: true }) });
    const root = module('shop', {}, (h) => {
      h.provision(auth, { id: 'auth' });
      return {};
    });
    const graph = Load(root);

    expect(buildConfig(auth, 'auth', graph, new Map(), new Map())).toEqual({
      service: {},
      inputs: {},
    });
  });

  test('a ParamSource binding flows through to Config.service opaquely — buildConfig never validates it against the schema (the target resolves and validates at boot)', () => {
    const auth = app('fake/compute', {}, { origin: string() });
    const source = paramSource('APP_ORIGIN');
    const root = module('shop', {}, (h) => {
      h.provision(auth, { id: 'auth', params: { origin: source } });
      return {};
    });
    const graph = Load(root);

    const config = buildConfig(auth, 'auth', graph, new Map(), new Map());
    expect(isParamSource(config.service['origin'])).toBe(true);
    expect(config.service['origin']).toBe(source);
  });

  test('a literal that fails the param schema is a LowerError naming the param, the service, and the schema issue', () => {
    const auth = app('fake/compute', {}, { port: number({ default: 3000 }) });
    const root = module('shop', {}, (h) => {
      // @ts-expect-error a number param rejects a string literal
      h.provision(auth, { id: 'auth', params: { port: 'not-a-number' } });
      return {};
    });
    const graph = Load(root);

    expect(() => buildConfig(auth, 'auth', graph, new Map(), new Map())).toThrow(LowerError);
    expect(() => buildConfig(auth, 'auth', graph, new Map(), new Map())).toThrow(/"port"/);
  });

  test('a param claiming BOTH a provision need and a provision-time binding is a LowerError naming the param and both sources', () => {
    const brand = Symbol.for('test:both-sources');
    const auth = app('fake/compute', {}, { token: string({ provision: provisionNeed(brand) }) });
    const asSource = module('shop', {}, (h) => {
      h.provision(auth, { id: 'auth', params: { token: paramSource('TOKEN_VAR') } });
      return {};
    });
    const asLiteral = module('shop', {}, (h) => {
      h.provision(auth, { id: 'auth', params: { token: 'literal-token' } });
      return {};
    });

    const sourceGraph = Load(asSource);
    expect(() => buildConfig(auth, 'auth', sourceGraph, new Map(), new Map())).toThrow(LowerError);
    expect(() => buildConfig(auth, 'auth', sourceGraph, new Map(), new Map())).toThrow(
      /"token".*two sources.*a param source.*test:both-sources/,
    );

    const literalGraph = Load(asLiteral);
    expect(() => buildConfig(auth, 'auth', literalGraph, new Map(), new Map())).toThrow(
      /"token".*two sources.*a literal value.*test:both-sources/,
    );
  });
});

const singleServiceModule = (
  type: string,
  params: Params = {},
  build: BuildAdapter = defaultBuild,
) =>
  module('hello', {}, (h) => {
    h.provision(app(type, {}, params, build), { id: 'svc' });
    return {};
  });

// A single service whose one dependency is a module-provisioned db resource —
// the resource model's minimal shape: a service never embeds a resource; the
// module provisions it and wires the slot.
const singleServiceWithDbModule = (params: Params = {}) =>
  module('hello', {}, (h) => {
    const db = h.provision(dbResource(), { id: 'db' });
    h.provision(app('fake/compute', { db: dbEnd() }, params), { id: 'svc', deps: { db } });
    return {};
  });

const svcBundles = { bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } };

describe('lowering a module root — a single service', () => {
  test('a dependency-less service sequences application → provision → serialize → package → deploy; nothing is auto-provisioned', () => {
    const { config, calls } = fakeExtension();
    const root = singleServiceModule('fake/compute');

    const result = run(lowering(root, config, opts(svcBundles)));

    expect(calls.map((c) => c.phase)).toEqual([
      'application',
      'provision',
      'serialize',
      'package',
      'deploy',
    ]);
    // The root is always a module — its own lowering has no outputs yet
    // (boundary ports are future work); see the two-service suite below.
    expect(result).toBeUndefined();
  });

  test('the lowering effect resolves to undefined — S1 kills the stack-output dump for good', () => {
    const { config } = fakeExtension();
    const root = singleServiceModule('fake/compute');

    const result = Effect.runSync(
      lowering(root, config, opts(svcBundles)) as Effect.Effect<undefined, LowerError>,
    );

    expect(result).toBe(undefined);
  });

  test('a module-provisioned resource lowers before the service that consumes it', () => {
    const { config, calls } = fakeExtension();
    const root = singleServiceWithDbModule();

    run(lowering(root, config, opts(svcBundles)));

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
    const { config, calls } = fakeExtension();
    const root = singleServiceWithDbModule({ port: number({ default: 3000 }) });

    run(lowering(root, config, opts(svcBundles)));

    const serialize = calls.find((c) => c.phase === 'serialize');
    expect(serialize).toMatchObject({
      config: { service: { port: 3000 }, inputs: { db: { url: 'db://db' } } },
    });
  });

  test('package receives the build adapter output dir/entry and the same address serialize used', () => {
    const { config, calls } = fakeExtension();
    const root = singleServiceModule('fake/compute');
    const bundle: Bundle = { dir: 'dist/bundle', entry: 'main.mjs' };

    run(lowering(root, config, opts({ bundles: { svc: bundle } })));

    const pkg = calls.find((c) => c.phase === 'package');
    expect(pkg).toMatchObject({ assembled: bundle, address: 'svc' });
  });

  test("the environment edge: deploy's `environment` IS serialize's returned records (by recording, not order)", () => {
    const { config, calls } = fakeExtension();
    const root = singleServiceWithDbModule();

    run(lowering(root, config, opts(svcBundles)));

    const serialize = calls.find((c) => c.phase === 'serialize');
    const deploy = calls.find((c) => c.phase === 'deploy');
    expect(serialize).toBeDefined();
    expect(deploy).toBeDefined();
    if (serialize?.phase !== 'serialize' || deploy?.phase !== 'deploy')
      throw new Error('unreachable');
    expect(deploy.environment).toEqual([{ input: 'db', name: 'url', value: 'db://db' }]);
    // Same records the serialize call's own return produced (identity, not
    // a coincidental re-derivation) — the fake extension only ever returns
    // them once, from serialize, and threads them through to deploy's
    // argument.
  });

  test('the build descriptor is inert to lowering — any build extension/type/entry lowers identically', () => {
    const { config } = fakeExtension();
    const root = singleServiceModule(
      'fake/compute',
      {},
      {
        extension: '@fake/adapter',
        type: 'nonsense',
        module: 'file:///test/service.ts',
        entry: 'whatever.js',
      },
    );

    const result = run(lowering(root, config, opts(svcBundles)));

    expect(result).toBeUndefined();
  });

  test('missing a bundle for a single-service module is a LowerError naming it', () => {
    const { config } = fakeExtension();
    const root = singleServiceModule('fake/compute');

    const error = runError(lowering(root, config, opts()));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('opts.bundles["svc"]');
  });

  test('fails with LowerError naming the type and the known types on an unknown service type', () => {
    const { config } = fakeExtension();
    const root = singleServiceModule('fake/other-compute');

    const error = runError(lowering(root, config, opts(svcBundles)));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('fake/other-compute');
    expect(error.message).toContain('fake/compute');
  });

  test('fails with LowerError naming the extension and the config fix when no configured extension matches', () => {
    const { config } = fakeExtension();
    const root = module('hello', {}, (h) => {
      h.provision(
        service({
          name: 'other',
          extension: '@acme/other-cloud',
          type: 'fake/compute',
          inputs: {},
          params: {},
          build: defaultBuild,
        }),
        { id: 'svc' },
      );
      return {};
    });

    const error = runError(lowering(root, config, opts(svcBundles)));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('@acme/other-cloud');
    expect(error.message).toContain('prisma-composer.config.ts');
  });

  test('a resource node routed to a service descriptor is a LowerError naming (extension, type, expected kind)', () => {
    const { config } = fakeExtension();
    const root = module('hello', {}, (h) => {
      h.provision(
        resource({
          name: 'db',
          extension: 'test/pack',
          // The registry's 'fake/compute' entry is a service descriptor.
          provides: providerContract('fake/compute', { url: '' }),
        }),
        { id: 'db' },
      );
      return {};
    });

    const error = runError(lowering(root, config, opts()));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('test/pack');
    expect(error.message).toContain('fake/compute');
    expect(error.message).toContain('"resource" descriptor');
  });
});

describe('lowering a module root — a provisioned resource and two connected services', () => {
  const authService = () => app('fake/compute', { db: dbEnd() });
  const storefrontService = () => app('fake/compute', { auth: httpEnd() });

  const twoServiceModule = () =>
    module('shop', {}, (h) => {
      const db = h.provision(dbResource(), { id: 'db' });
      const authRef = h.provision(authService(), { id: 'auth', deps: { db } });
      h.provision(storefrontService(), { id: 'storefront', deps: { auth: authRef } });
      return {};
    });

  test("application provisions once; the resource and auth are FULLY deployed before storefront's serialize", () => {
    const { config, calls } = fakeExtension();

    run(
      lowering(twoServiceModule(), config, {
        name: 'shop',
        bundles: {
          auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'modules/storefront/dist/bundle', entry: 'server.js' },
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

  test("each module-provisioned service's address is its own provision id", () => {
    const { config, calls } = fakeExtension();

    run(
      lowering(twoServiceModule(), config, {
        name: 'shop',
        bundles: {
          auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'modules/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    const authProvision = calls.find((c) => c.phase === 'provision' && c.id === 'auth');
    const storefrontProvision = calls.find((c) => c.phase === 'provision' && c.id === 'storefront');
    expect(authProvision).toMatchObject({ address: 'auth' });
    expect(storefrontProvision).toMatchObject({ address: 'storefront' });
  });

  test("auth's Config.inputs.db carries the module-provisioned resource's lowered url", () => {
    const { config, calls } = fakeExtension();

    run(
      lowering(twoServiceModule(), config, {
        name: 'shop',
        bundles: {
          auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'modules/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    const authSerialize = calls.find((c) => c.phase === 'serialize' && c.id === 'auth');
    expect(authSerialize).toMatchObject({
      config: { inputs: { db: { url: 'db://db' } } },
    });
  });

  test("storefront's Config.inputs.auth carries auth's REAL deploy-phase URL, not a placeholder", () => {
    const { config, calls } = fakeExtension();

    run(
      lowering(twoServiceModule(), config, {
        name: 'shop',
        bundles: {
          auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'modules/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    const storefrontSerialize = calls.find((c) => c.phase === 'serialize' && c.id === 'storefront');
    expect(storefrontSerialize).toMatchObject({
      config: { inputs: { auth: { url: 'https://auth.example' } } },
    });
  });

  test("the environment edge: auth's deploy environment IS its serialize records, resource url included", () => {
    const { config, calls } = fakeExtension();

    run(
      lowering(twoServiceModule(), config, {
        name: 'shop',
        bundles: {
          auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'modules/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    const authDeploy = calls.find((c) => c.phase === 'deploy' && c.id === 'auth');
    expect(authDeploy).toMatchObject({
      environment: [{ input: 'db', name: 'url', value: 'db://db' }],
    });
    // Same records the serialize call's own return produced (identity, not
    // a coincidental re-derivation) — the fake extension only ever returns
    // them once, from serialize, and threads them through to deploy's
    // argument.
  });

  test('topo sort: a module authored consumer-before-producer (forged ref) still resolves real producer outputs at deploy', () => {
    // Mirrors the module.test.ts graph-layer topo-sort test, but exercises the
    // consequence: before the sort, buildConfig read `lowered.get(edge.from)`
    // positionally, so a consumer walked before its producer saw undefined
    // outputs. With the sort, the producer is fully deployed first.
    const { config, calls } = fakeExtension();
    const root = module('shop', {}, (h) => {
      const db = h.provision(dbResource(), { id: 'db' });
      h.provision(storefrontService(), {
        id: 'storefront',
        deps: {
          auth: { id: 'auth' } as never,
        },
      });
      h.provision(authService(), { id: 'auth', deps: { db } });
      return {};
    });

    run(
      lowering(root, config, {
        name: 'shop',
        bundles: {
          auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'modules/storefront/dist/bundle', entry: 'server.js' },
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

  test('missing a bundle entry for one module-provisioned service is a LowerError naming it', () => {
    const { config } = fakeExtension();

    const error = runError(
      lowering(twoServiceModule(), config, {
        name: 'shop',
        bundles: { auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' } },
      }),
    );

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('opts.bundles["storefront"]');
  });

  test("a module root's own lowering has no outputs yet (boundary ports are future work)", () => {
    const { config } = fakeExtension();

    const result = run(
      lowering(twoServiceModule(), config, {
        name: 'shop',
        bundles: {
          auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: 'modules/storefront/dist/bundle', entry: 'server.js' },
        },
      }),
    );

    expect(result).toBeUndefined();
  });

  test('fails with LowerError naming the type and the known types on an unknown resource type', () => {
    const { config } = fakeExtension();
    const root = module('shop', {}, (h) => {
      h.provision(
        resource({
          name: 'cache',
          extension: 'test/pack',
          provides: providerContract('fake/unknown', {}),
        }),
        { id: 'cache' },
      );
      return {};
    });

    const error = runError(lowering(root, config, { name: 'shop', bundles: {} }));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('fake/unknown');
    expect(error.message).toContain('fake/db');
  });
});

describe('lowering a module root — one resource shared by two consumers', () => {
  const sharedModule = () =>
    module('shop', {}, (h) => {
      const db = h.provision(dbResource(), { id: 'db' });
      h.provision(app('fake/compute', { authDb: dbEnd() }), { id: 'auth', deps: { authDb: db } });
      h.provision(app('fake/compute', { billingDb: dbEnd() }), {
        id: 'billing',
        deps: { billingDb: db },
      });
      return {};
    });

  const sharedOpts = {
    name: 'shop',
    bundles: {
      auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
      billing: { dir: 'modules/billing/dist/bundle', entry: 'server.js' },
    },
  };

  test('the resource is lowered exactly once, regardless of consumer count', () => {
    const { config, calls } = fakeExtension();

    run(lowering(sharedModule(), config, sharedOpts));

    expect(calls.filter((c) => c.phase === 'resource')).toEqual([
      { phase: 'resource', id: 'db', type: 'fake/db' },
    ]);
  });

  test("both consumers' Configs receive the ONE resource's outputs, each under its own dep key", () => {
    const { config, calls } = fakeExtension();

    run(lowering(sharedModule(), config, sharedOpts));

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

describe('provision phase (ADR-0031): resolving a provisioned param against the consumer extension', () => {
  const PROVISION_BRAND = Symbol('test-provision-brand');

  const tokenEnd = (brand: symbol = PROVISION_BRAND) =>
    dependency({
      name: 'auth',
      type: 'fake/rpc',
      connection: conn(
        { token: string({ optional: true, provision: provisionNeed(brand) }) },
        () => ({}),
      ),
    });

  function fakeProvisioner(mint: (edge: ProvisionEdge) => unknown) {
    const calls: ProvisionEdge[] = [];
    const descriptor: ProvisionerDescriptor = {
      provision: (edge) => {
        calls.push(edge);
        return Effect.succeed(mint(edge));
      },
    };
    return { descriptor, calls };
  }

  const provisionBundles = {
    name: 'shop',
    bundles: {
      auth: { dir: 'modules/auth/dist/bundle', entry: 'server.js' },
      consumer: { dir: 'modules/consumer/dist/bundle', entry: 'server.js' },
    },
  };

  test("a resolved edge mints once and fills the consumer's param in buildConfig", () => {
    const provisioner = fakeProvisioner((edge) => `minted:${edge.edgeId}`);
    const { config, calls } = fakeExtension({
      provisions: new Map([[PROVISION_BRAND, provisioner.descriptor]]),
    });
    const root = module('shop', {}, (h) => {
      const authRef = h.provision(app('fake/compute', {}), { id: 'auth' });
      h.provision(app('fake/compute', { auth: tokenEnd() }), {
        id: 'consumer',
        deps: { auth: authRef },
      });
      return {};
    });

    run(lowering(root, config, provisionBundles));

    expect(provisioner.calls).toHaveLength(1);
    expect(provisioner.calls[0]).toMatchObject({
      edgeId: 'consumer.auth',
      consumerAddress: 'consumer',
      providerAddress: 'auth',
      input: 'auth',
    });
    expect(provisioner.calls[0]?.need.brand).toBe(PROVISION_BRAND);

    const consumerSerialize = calls.find((c) => c.phase === 'serialize' && c.id === 'consumer');
    expect(consumerSerialize).toMatchObject({
      config: { inputs: { auth: { token: 'minted:consumer.auth' } } },
    });
  });

  test('an unregistered brand fails the deploy with a LowerError naming the brand and the edge', () => {
    const { config } = fakeExtension(); // no provisions map
    const root = module('shop', {}, (h) => {
      const authRef = h.provision(app('fake/compute', {}), { id: 'auth' });
      h.provision(app('fake/compute', { auth: tokenEnd() }), {
        id: 'consumer',
        deps: { auth: authRef },
      });
      return {};
    });

    const error = runError(lowering(root, config, provisionBundles));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('consumer.auth');
    expect(error.message).toContain(String(PROVISION_BRAND));
  });

  test('a provisioned edge spanning two extensions fails with a LowerError naming the edge', () => {
    const provisioner = fakeProvisioner(() => 'unused');
    const { config } = fakeExtension({
      provisions: new Map([[PROVISION_BRAND, provisioner.descriptor]]),
    });
    const otherExtensionProducer = service({
      name: 'auth',
      extension: 'test/other-pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build: defaultBuild,
    });
    const root = module('shop', {}, (h) => {
      const authRef = h.provision(otherExtensionProducer, { id: 'auth' });
      h.provision(app('fake/compute', { auth: tokenEnd() }), {
        id: 'consumer',
        deps: { auth: authRef },
      });
      return {};
    });

    const error = runError(lowering(root, config, provisionBundles));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('consumer.auth');
    expect(error.message).toContain('cross-extension');
    expect(provisioner.calls).toHaveLength(0);
  });

  test("a connection declaring two provisioned params fails with a LowerError naming both — one edge mints one value, so a second need would silently take the first's", () => {
    const provisioner = fakeProvisioner(() => 'unused');
    const { config } = fakeExtension({
      provisions: new Map([[PROVISION_BRAND, provisioner.descriptor]]),
    });
    const twoNeedsEnd = () =>
      dependency({
        name: 'auth',
        type: 'fake/rpc',
        connection: conn(
          {
            token: string({ optional: true, provision: provisionNeed(PROVISION_BRAND) }),
            secondToken: string({ optional: true, provision: provisionNeed(Symbol('other')) }),
          },
          () => ({}),
        ),
      });
    const root = module('shop', {}, (h) => {
      const authRef = h.provision(app('fake/compute', {}), { id: 'auth' });
      h.provision(app('fake/compute', { auth: twoNeedsEnd() }), {
        id: 'consumer',
        deps: { auth: authRef },
      });
      return {};
    });

    const error = runError(lowering(root, config, provisionBundles));

    expect(error).toBeInstanceOf(LowerError);
    expect(error.message).toContain('consumer.auth');
    expect(error.message).toContain('token');
    expect(error.message).toContain('secondToken');
    // Nothing is minted — the deploy fails before any provisioner runs.
    expect(provisioner.calls).toHaveLength(0);
  });
});

describe('joinDeployment', () => {
  // The Action's input carries addresses + plain entities only — never graph
  // nodes, because the plan hashes the resolved input and a node holds
  // functions and Standard Schemas. This join is what puts the node back,
  // reading it from the graph the runner holds by closure.
  const twoNodeGraph = () => {
    const root = module('shop', {}, (h) => {
      const db = h.provision(dbResource(), { id: 'db' });
      h.provision(app('fake/compute', { db: dbEnd() }), { id: 'auth', deps: { db } });
      return {};
    });
    return Load(root);
  };

  test('puts each entry back together with its graph node, preserving entry order', () => {
    const graph = twoNodeGraph();
    const entries = [
      { address: 'db', entities: [{ kind: 'fake-db', id: 'db#1' }] },
      { address: 'auth', entities: [{ kind: 'fake-compute', id: 'svc#1', url: 'https://a' }] },
    ];

    const results = joinDeployment(graph, entries);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.address)).toEqual(['db', 'auth']);
    expect(results[0]?.node.name).toBe('db');
    expect(results[1]?.node.name).toBe('test-service');
    expect(results[1]?.entities).toEqual([{ kind: 'fake-compute', id: 'svc#1', url: 'https://a' }]);
  });

  test('skips an address the graph no longer holds — entries are data, the graph is truth', () => {
    const graph = twoNodeGraph();
    const entries = [
      { address: 'db', entities: [] },
      { address: 'ghost', entities: [{ kind: 'fake-compute', id: 'gone#1' }] },
    ];

    const results = joinDeployment(graph, entries);

    expect(results.map((r) => r.address)).toEqual(['db']);
  });

  test('a node that reported no entities still yields a result — it deployed, it just published nothing', () => {
    const graph = twoNodeGraph();

    const results = joinDeployment(graph, [{ address: 'auth', entities: [] }]);

    expect(results).toHaveLength(1);
    expect(results[0]?.entities).toEqual([]);
  });

  test('no entries yields no results', () => {
    expect(joinDeployment(twoNodeGraph(), [])).toEqual([]);
  });
});

describe('lowering() — the report path', () => {
  test('without opts.report, lowering declares no action and stays sync-runnable', () => {
    const { config } = fakeExtension();
    const root = singleServiceWithDbModule();

    // The assertion IS that this runs synchronously: constructing the Action
    // would drag alchemy's Stack context into the requirements and runSync
    // would die. `run()` is Effect.runSync.
    expect(run(lowering(root, config, opts(svcBundles)))).toBeUndefined();
  });
});

describe('lower()', () => {
  test('builds an Alchemy Stack wrapping the same lowering', () => {
    // Unlike lowering(), lower() DOES merge the extensions' providers eagerly
    // (to hand them to Alchemy.Stack) — a different fake than the
    // lowering()-only suite above, which asserts the opposite.
    const { descriptor } = fakeExtension();
    const config: PrismaAppConfig = {
      extensions: [{ ...descriptor, providers: () => Layer.empty }],
      state: () => stateSentinel('config-default'),
    };
    const root = singleServiceModule('fake/compute', {});

    const stack = lower(
      root,
      config,
      opts({ bundles: { svc: { dir: 'dist/bundle', entry: 'server.js' } } }),
    );

    expect(stack).toBeDefined();
  });
});

describe('lowering a nested module — dotted addresses (H1: module-composition)', () => {
  test('a service provisioned by a module nested inside another module gets a dotted address, and lowering() finds its bundle by that full id', () => {
    const { config } = fakeExtension();
    const inner = module('auth', {}, (h) => {
      h.provision(app('fake/compute', {}), { id: 'api' });
      return {};
    });
    const root = module('shop', {}, (h) => {
      h.provision(inner, { id: 'auth' });
      return {};
    });
    const graph = Load(root);

    expect(graph.nodes.some((n) => n.id === 'auth.api')).toBe(true);

    const result = run(
      lowering(
        root,
        config,
        opts({ bundles: { 'auth.api': { dir: 'dist/bundle', entry: 'server.js' } } }),
      ),
    );

    expect(result).toBeUndefined();
  });
});

describe('resolveStateLayer', () => {
  // Sentinel objects, not real Alchemy Layers — resolveStateLayer is a pure
  // selector, so identity comparison against sentinels proves precedence
  // without booting Alchemy.
  test("opts.state wins over the config's state", () => {
    const optsState = stateSentinel('opts');
    const { descriptor } = fakeExtension();
    const config: PrismaAppConfig = {
      extensions: [descriptor],
      state: () => stateSentinel('config'),
    };

    expect(resolveStateLayer(opts({ state: optsState }), config)).toBe(optsState);
  });

  test("the config's state is used when opts.state is absent — PrismaAppConfig.state is required", () => {
    const configState = stateSentinel('config');
    const { descriptor } = fakeExtension();
    const config: PrismaAppConfig = { extensions: [descriptor], state: () => configState };

    expect(resolveStateLayer(opts(), config)).toBe(configState);
  });
});

describe('mergedProviders', () => {
  test('an extension without providers is skipped; none at all yields the empty layer', () => {
    const { descriptor } = fakeExtension();
    const { providers: _dropped, ...bare } = descriptor;
    const config: PrismaAppConfig = {
      extensions: [bare],
      state: () => stateSentinel('config'),
    };

    expect(mergedProviders(config)).toBe(Layer.empty);
  });

  test('a single providers() layer passes through merged', () => {
    const { descriptor } = fakeExtension();
    const config: PrismaAppConfig = {
      extensions: [{ ...descriptor, providers: () => Layer.empty }],
      state: () => stateSentinel('config'),
    };

    expect(mergedProviders(config)).toBeDefined();
  });
});
