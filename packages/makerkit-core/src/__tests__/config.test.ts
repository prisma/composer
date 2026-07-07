import { describe, expect, test } from 'bun:test';
import { configOf } from '../config.ts';
import { resource, service } from '../node.ts';
import { conn, memoryAdapter } from './helpers.ts';

const adapter = memoryAdapter({});

describe('configOf', () => {
  test('enumerates input params then service params — semantic, no platform keys', () => {
    const root = service({
      type: 'fake/app',
      inputs: {
        db: resource({
          type: 'fake/db',
          connection: conn(
            { url: { type: 'string', secret: true }, schema: { type: 'string', optional: true } },
            () => ({}),
          ),
        }),
      },
      params: { port: { type: 'number', default: 3000 } },
      config: adapter,
      handler: () => null,
    });

    expect(configOf(root)).toEqual([
      { owner: { input: 'db' }, name: 'url', type: 'string', secret: true, optional: false },
      { owner: { input: 'db' }, name: 'schema', type: 'string', secret: false, optional: true },
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
      type: 'fake/app',
      inputs: {
        cache: resource({
          type: 'fake/cache',
          connection: conn({ port: { type: 'number' } }, () => ({})),
        }),
      },
      params: { port: { type: 'number', default: 3000 } },
      config: adapter,
      handler: () => null,
    });

    const owners = configOf(root).map((e) => ({ owner: e.owner, name: e.name }));
    expect(owners).toEqual([
      { owner: { input: 'cache' }, name: 'port' },
      { owner: 'service', name: 'port' },
    ]);
  });

  test('a dep-less service enumerates only its own params', () => {
    const root = service({
      type: 'fake/app',
      inputs: {},
      params: { port: { type: 'number', default: 3000 } },
      config: adapter,
      handler: () => null,
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

  test('executes nothing — no handler, no hydrate, no adapter', () => {
    let handlerCalls = 0;
    let hydrateCalls = 0;
    const root = service({
      type: 'fake/app',
      inputs: {
        db: resource({
          type: 'fake/db',
          connection: conn({ url: { type: 'string' } }, () => {
            hydrateCalls += 1;
            return {};
          }),
        }),
      },
      params: {},
      config: adapter,
      handler: () => {
        handlerCalls += 1;
        return null;
      },
    });

    configOf(root);

    expect(handlerCalls).toBe(0);
    expect(hydrateCalls).toBe(0);
    expect(adapter.requested.length).toBe(0);
  });
});
