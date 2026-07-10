import { describe, expect, test } from 'bun:test';
import { hydrate, hydrateSync } from '../hydrate.ts';
import { dependency, service } from '../node.ts';
import { conn } from './helpers.ts';

const build = {
  kind: 'node',
  pack: '@makerkit/node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const dbEnd = (record?: (values: { url: string }) => void) =>
  dependency({
    name: 'db',
    type: 'fake/db',
    connection: conn({ url: { type: 'string', secret: true } }, (v) => {
      record?.(v);
      return { client: v.url };
    }),
  });

const portParams = { port: { type: 'number', default: 3000 } } as const;

describe('hydrate', () => {
  test("calls each input's connection.hydrate with its typed Config slice", async () => {
    const made: unknown[] = [];
    const root = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: { db: dbEnd((v) => made.push(v)) },
      params: portParams,
      build,
    });

    const deps = await hydrate(root, {
      service: { port: 8080 },
      inputs: { db: { url: 'postgres://x' } },
    });

    expect(made).toEqual([{ url: 'postgres://x' }]);
    expect(deps).toEqual({ db: { client: 'postgres://x' } });
  });

  test('every dependency hydrates through identical machinery — the app cannot tell producers apart', async () => {
    const root = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {
        auth: dependency({
          type: 'fake/http',
          connection: conn({ url: { type: 'string' } }, (v) => ({ fetchBase: v.url })),
        }),
      },
      params: {},
      build,
    });

    const deps = await hydrate(root, {
      service: {},
      inputs: { auth: { url: 'https://auth.example' } },
    });

    expect(deps).toEqual({ auth: { fetchBase: 'https://auth.example' } });
  });

  test('async hydrate is awaited', async () => {
    const root = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn({ url: { type: 'string' } }, async (v) => {
            await Promise.resolve();
            return { asyncClient: v.url };
          }),
        }),
      },
      params: {},
      build,
    });

    const deps = await hydrate(root, { service: {}, inputs: { db: { url: 'postgres://x' } } });

    expect(deps).toEqual({ db: { asyncClient: 'postgres://x' } });
  });

  test('a dep-less service hydrates to an empty deps object', async () => {
    const root = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {},
      params: portParams,
      build,
    });

    expect(await hydrate(root, { service: { port: 3000 }, inputs: {} })).toEqual({});
  });
});

describe('hydrateSync', () => {
  test('hydrates every input synchronously — no await required', () => {
    const made: unknown[] = [];
    const root = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: { db: dbEnd((v) => made.push(v)) },
      params: portParams,
      build,
    });

    const deps = hydrateSync(root, {
      service: { port: 8080 },
      inputs: { db: { url: 'postgres://x' } },
    });

    expect(made).toEqual([{ url: 'postgres://x' }]);
    expect(deps).toEqual({ db: { client: 'postgres://x' } });
  });

  test('throws, naming the input, when a connection hydrate returns a Promise', () => {
    const root = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/app',
      inputs: {
        db: dependency({
          name: 'db',
          type: 'fake/db',
          connection: conn({ url: { type: 'string' } }, async (v) => ({ asyncClient: v.url })),
        }),
      },
      params: {},
      build,
    });

    expect(() =>
      hydrateSync(root, { service: {}, inputs: { db: { url: 'postgres://x' } } }),
    ).toThrow(/db/);
  });
});
