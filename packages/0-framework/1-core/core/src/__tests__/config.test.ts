import { describe, expect, test } from 'bun:test';
import { configOf, number, string } from '../config.ts';
import { dependency, service } from '../node.ts';
import { conn, scalarDeclaration } from './helpers.ts';

const build = {
  extension: '@prisma/compose/node',
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
          connection: conn(
            { url: string({ secret: true }), schema: string({ optional: true }) },
            () => ({}),
          ),
        }),
      },
      params: { port: number({ default: 3000 }) },
      build,
    });

    expect(configOf(root)).toEqual([
      scalarDeclaration({ input: 'db' }, 'url', { secret: true }),
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
});

describe('configOf over dependency inputs', () => {
  test('every dependency input appears with owner { input }, whatever it will be wired to', () => {
    const root = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn({ url: string({ secret: true }) }, () => ({})),
        }),
        auth: dependency({
          type: 'fake/http',
          connection: conn({ url: string() }, () => ({})),
        }),
      },
      params: { port: number({ default: 3000 }) },
      build,
    });

    expect(configOf(root)).toEqual([
      scalarDeclaration({ input: 'db' }, 'url', { secret: true }),
      scalarDeclaration({ input: 'auth' }, 'url'),
      scalarDeclaration('service', 'port', { default: 3000 }),
    ]);
  });
});
