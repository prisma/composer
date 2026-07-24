import { describe, expect, test } from 'bun:test';
import { configOf, inputManifest, number, string } from '../config.ts';
import { Load } from '../graph.ts';
import { dependency, module, provisionNeed, secretSource, service } from '../node.ts';
import { anyInputSchema, conn, scalarDeclaration } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

describe('configOf', () => {
  test('enumerates input params then service params — semantic, no platform keys', () => {
    const root = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn({ url: string(), schema: string({ optional: true }) }, () => ({})),
        }),
      },
      params: { port: number({ default: 3000 }) },
      build,
    });

    expect(configOf(root)).toEqual([
      scalarDeclaration({ input: 'db' }, 'url'),
      scalarDeclaration({ input: 'db' }, 'schema', { optional: true }),
      scalarDeclaration('service', 'port', { default: 3000 }),
    ]);
  });

  test('owner discriminates service vs input params — same name cannot collide', () => {
    const root = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {
        cache: dependency({
          name: 'cache',
          type: 'fake/cache',
          connection: conn({ port: number() }, () => ({})),
        }),
      },
      params: { port: number({ default: 3000 }) },
      build,
    });

    const owners = configOf(root).map((e) => ({ owner: e.owner, name: e.name }));
    expect(owners).toEqual([
      { owner: { input: 'cache' }, name: 'port' },
      { owner: 'service', name: 'port' },
    ]);
  });

  test('a dep-less service enumerates only its own params', () => {
    const root = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: { port: number({ default: 3000 }) },
      build,
    });

    expect(configOf(root)).toEqual([scalarDeclaration('service', 'port', { default: 3000 })]);
  });

  test('executes nothing — configOf never calls a connection hydrate', () => {
    let hydrateCalls = 0;
    const root = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn({ url: string() }, () => {
            hydrateCalls += 1;
            return {};
          }),
        }),
      },
      params: {},
      build,
    });

    configOf(root);

    expect(hydrateCalls).toBe(0);
  });

  test('the input schema is NOT a config param — configOf never reports it', () => {
    const root = service({
      name: 'ingest',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: { port: number({ default: 3000 }) },
      input: anyInputSchema,
      build,
    });

    expect(configOf(root)).toEqual([scalarDeclaration('service', 'port', { default: 3000 })]);
  });
});

describe('inputManifest', () => {
  test('aggregates the provision-time input bindings across the graph (ADR-0042)', () => {
    const ingest = service({
      name: 'ingest',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: {},
      input: anyInputSchema,
      build,
    });
    const web = service({
      name: 'web',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: {},
      input: anyInputSchema,
      build,
    });
    const ingestBinding = { stripeKey: secretSource('STRIPE_SECRET_KEY') };
    const webBinding = { sendgrid: secretSource('SENDGRID_API_KEY') };
    const graph = Load(
      module('app', ({ provision }) => {
        provision(ingest, { id: 'ingest', input: ingestBinding });
        provision(web, { id: 'web', input: webBinding });
      }),
    );

    // Core records the binding per service address as opaque plain data; the
    // leaves' payloads (env-var names) are the target's, which core never reads.
    const manifest = inputManifest(graph);
    expect(manifest).toHaveLength(2);
    expect(manifest).toContainEqual({ serviceAddress: 'ingest', binding: ingestBinding });
    expect(manifest).toContainEqual({ serviceAddress: 'web', binding: webBinding });
  });

  test('is empty when no service declares an input schema', () => {
    const svc = service({
      name: 'x',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: { port: number({ default: 3000 }) },
      build,
    });
    const graph = Load(
      module('app', ({ provision }) => {
        provision(svc, { id: 'x' });
      }),
    );

    expect(inputManifest(graph)).toEqual([]);
  });
});

describe('provision need (ADR-0031) — opaque to core, carried through by string()/number()/param()', () => {
  test('is absent by default — no key on the returned ConfigParam', () => {
    expect(string()).not.toHaveProperty('provision');
    expect(number()).not.toHaveProperty('provision');
  });

  test('string({ provision }) carries the need through to the ConfigParam', () => {
    const need = provisionNeed(Symbol('test-need'));
    const param = string({ optional: true, provision: need });

    expect(param.provision).toBe(need);
    expect(param.optional).toBe(true);
  });

  test('configOf never surfaces provision — it is not part of the enumerable ConfigDeclaration shape', () => {
    const root = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {
        auth: dependency({
          name: 'auth',
          type: 'fake/rpc',
          connection: conn(
            {
              serviceKey: string({ optional: true, provision: provisionNeed(Symbol('test-need')) }),
            },
            () => ({}),
          ),
        }),
      },
      params: {},
      build,
    });

    expect(JSON.stringify(configOf(root))).not.toContain('provision');
  });
});
