import { describe, expect, test } from 'bun:test';
import { configOf, number, provisionManifest, string } from '../config.ts';
import { Load } from '../graph.ts';
import { dependency, module, provisionNeed, secret, secretSource, service } from '../node.ts';
import { conn, scalarDeclaration } from './helpers.ts';

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

  test('a secret slot is NOT a config param — configOf never reports it', () => {
    const root = service({
      name: 'ingest',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: { port: number({ default: 3000 }) },
      secrets: { stripeKey: secret() },
      build,
    });

    expect(configOf(root)).toEqual([scalarDeclaration('service', 'port', { default: 3000 })]);
  });
});

describe('provisionManifest', () => {
  test('aggregates the root-bound secret names across the graph', () => {
    const ingest = service({
      name: 'ingest',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: {},
      secrets: { stripeKey: secret() },
      build,
    });
    const web = service({
      name: 'web',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: {},
      secrets: { sendgrid: secret() },
      build,
    });
    const graph = Load(
      module('app', ({ provision }) => {
        provision(ingest, {
          id: 'ingest',
          secrets: { stripeKey: secretSource('STRIPE_SECRET_KEY') },
        });
        provision(web, { id: 'web', secrets: { sendgrid: secretSource('SENDGRID_API_KEY') } });
      }),
    );

    const manifest = provisionManifest(graph);
    // Core records the binding per (service, slot) with an opaque source; the
    // env-var name lives in the target's payload, which core never reads.
    expect(manifest).toHaveLength(2);
    expect(manifest).toContainEqual(
      expect.objectContaining({ serviceAddress: 'ingest', slot: 'stripeKey' }),
    );
    expect(manifest).toContainEqual(
      expect.objectContaining({ serviceAddress: 'web', slot: 'sendgrid' }),
    );
  });

  test('is empty when no service declares a secret slot', () => {
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

    expect(provisionManifest(graph)).toEqual([]);
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
