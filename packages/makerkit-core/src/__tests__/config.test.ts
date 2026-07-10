import { describe, expect, test } from 'bun:test';
import { configOf } from '../config.ts';
import { dependency, service } from '../node.ts';
import { conn } from './helpers.ts';

const build = {
  kind: 'node',
  pack: '@makerkit/node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

describe('configOf', () => {
  test('enumerates input params then service params — semantic, no platform keys', () => {
    const root = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn(
            { url: { type: 'string', secret: true }, schema: { type: 'string', optional: true } },
            () => ({}),
          ),
        }),
      },
      params: { port: { type: 'number', default: 3000 } },
      build,
    });

    expect(configOf(root)).toEqual([
      {
        owner: { input: 'db' },
        name: 'url',
        type: 'string',
        secret: true,
        optional: false,
        default: undefined,
      },
      {
        owner: { input: 'db' },
        name: 'schema',
        type: 'string',
        secret: false,
        optional: true,
        default: undefined,
      },
      {
        owner: 'service',
        name: 'port',
        type: 'number',
        secret: false,
        optional: false,
        default: 3000,
      },
    ]);
  });

  test('owner discriminates service vs input params — same name cannot collide', () => {
    const root = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {
        cache: dependency({
          name: 'cache',
          type: 'fake/cache',
          connection: conn({ port: { type: 'number' } }, () => ({})),
        }),
      },
      params: { port: { type: 'number', default: 3000 } },
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
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: { port: { type: 'number', default: 3000 } },
      build,
    });

    expect(configOf(root)).toEqual([
      {
        owner: 'service',
        name: 'port',
        type: 'number',
        secret: false,
        optional: false,
        default: 3000,
      },
    ]);
  });

  test('executes nothing — configOf never calls a connection hydrate', () => {
    let hydrateCalls = 0;
    const root = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn({ url: { type: 'string' } }, () => {
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
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn({ url: { type: 'string', secret: true } }, () => ({})),
        }),
        auth: dependency({
          type: 'fake/http',
          connection: conn({ url: { type: 'string' } }, () => ({})),
        }),
      },
      params: { port: { type: 'number', default: 3000 } },
      build,
    });

    expect(configOf(root)).toEqual([
      {
        owner: { input: 'db' },
        name: 'url',
        type: 'string',
        secret: true,
        optional: false,
        default: undefined,
      },
      {
        owner: { input: 'auth' },
        name: 'url',
        type: 'string',
        secret: false,
        optional: false,
        default: undefined,
      },
      {
        owner: 'service',
        name: 'port',
        type: 'number',
        secret: false,
        optional: false,
        default: 3000,
      },
    ]);
  });
});
