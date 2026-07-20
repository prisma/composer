import { describe, expect, test } from 'bun:test';
import { number, string } from '../config.ts';
import type { BuildAdapter, RunnableServiceNode } from '../node.ts';
import { dependency, service } from '../node.ts';
import { mockService } from '../testing.ts';
import { conn } from './helpers.ts';

const build: BuildAdapter = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

interface Verify {
  verify(input: { token: string }): Promise<{ ok: boolean }>;
}

const authDep = () =>
  dependency<{ url: ReturnType<typeof string> }, Verify>({
    type: 'fake/rpc',
    connection: conn(
      { url: string() },
      (): Verify => ({
        verify: async () => ({ ok: false }),
      }),
    ),
  });

type ConsumerDeps = { auth: ReturnType<typeof authDep> };
type ConsumerParams = { port: ReturnType<typeof number> };

/** A RunnableServiceNode fixture whose own run()/load()/config() must never actually run — mockService replaces them entirely, and run() is never called under a stub. */
const consumer = (): RunnableServiceNode<ConsumerDeps, ConsumerParams> =>
  Object.freeze({
    ...service({
      name: 'consumer',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: { auth: authDep() },
      params: { port: number({ default: 3000 }) },
      build,
    }),
    async run(): Promise<unknown> {
      throw new Error('consumer.run() should never be called under mockService.');
    },
    load() {
      throw new Error(
        'consumer.load() should never be reached — mockService replaces it entirely.',
      );
    },
    config() {
      throw new Error(
        'consumer.config() should never be reached — mockService replaces it entirely.',
      );
    },
    secrets() {
      throw new Error(
        'consumer.secrets() should never be reached — mockService replaces it entirely.',
      );
    },
  });

describe('mockService', () => {
  test('load() yields the dependency doubles; config() yields the param defaults', async () => {
    const stub = mockService(consumer(), {
      auth: { verify: async ({ token }) => ({ ok: token.length > 0 }) },
    });

    const { auth } = stub.load();
    expect(stub.config().port).toBe(3000);
    expect(await auth.verify({ token: 'x' })).toEqual({ ok: true });
  });

  test('an overridden param wins over the default', () => {
    const stub = mockService(consumer(), {
      auth: { verify: async () => ({ ok: true }) },
      port: 8080,
    });

    expect(stub.config().port).toBe(8080);
  });

  test('load()/config() each return the same object on every call', () => {
    const stub = mockService(consumer(), { auth: { verify: async () => ({ ok: true }) } });
    expect(stub.load()).toBe(stub.load());
    expect(stub.config()).toBe(stub.config());
  });

  test('run() throws, naming the service', () => {
    const stub = mockService(consumer(), { auth: { verify: async () => ({ ok: true }) } });
    expect(() => stub.run('addr', async () => undefined)).toThrow(/"consumer".*mock/);
  });

  test('deps/params/build/name pass through unchanged', () => {
    const original = consumer();
    const stub = mockService(original, { auth: { verify: async () => ({ ok: true }) } });
    expect(stub.inputs).toBe(original.inputs);
    expect(stub.params).toBe(original.params);
    expect(stub.build).toBe(original.build);
    expect(stub.name).toBe(original.name);
  });
});
