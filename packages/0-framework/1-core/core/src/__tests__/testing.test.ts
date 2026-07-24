import { describe, expect, test } from 'bun:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { number, string } from '../config.ts';
import type { BuildAdapter, Expose, RunnableServiceNode } from '../node.ts';
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
interface ConsumerInput {
  greeting: string;
}
const consumerSchema: StandardSchemaV1<unknown, ConsumerInput> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => ({ value: value as ConsumerInput }),
  },
};

/** A RunnableServiceNode fixture whose own run()/load()/input() must never actually run — mockService replaces them entirely, and run() is never called under a stub. */
const consumer = (): RunnableServiceNode<
  ConsumerDeps,
  ConsumerParams,
  Expose,
  typeof consumerSchema
> =>
  Object.freeze({
    ...service({
      name: 'consumer',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: { auth: authDep() },
      params: { port: number({ default: 3000 }) },
      input: consumerSchema,
      build,
    }),
    async run(): Promise<unknown> {
      throw new Error('consumer.run() should never be called under mockService.');
    },
    load(): never {
      throw new Error(
        'consumer.load() should never be reached — mockService replaces it entirely.',
      );
    },
    input(): never {
      throw new Error(
        'consumer.input() should never be reached — mockService replaces it entirely.',
      );
    },
  });

describe('mockService', () => {
  test('load() yields the dependency doubles; input() yields the given input object', async () => {
    const stub = mockService(consumer(), {
      auth: { verify: async ({ token }) => ({ ok: token.length > 0 }) },
      input: { greeting: 'hello' },
    });

    const { auth } = stub.load();
    expect(stub.input().greeting).toBe('hello');
    expect(await auth.verify({ token: 'x' })).toEqual({ ok: true });
  });

  test('load()/input() each return the same object on every call', () => {
    const stub = mockService(consumer(), {
      auth: { verify: async () => ({ ok: true }) },
      input: { greeting: 'hi' },
    });
    expect(stub.load()).toBe(stub.load());
    expect(stub.input()).toBe(stub.input());
  });

  test('run() throws, naming the service', () => {
    const stub = mockService(consumer(), {
      auth: { verify: async () => ({ ok: true }) },
      input: { greeting: 'hi' },
    });
    expect(() => stub.run('addr', async () => undefined)).toThrow(/"consumer".*mock/);
  });

  test('deps/inputSchema/build/name pass through unchanged', () => {
    const original = consumer();
    const stub = mockService(original, {
      auth: { verify: async () => ({ ok: true }) },
      input: { greeting: 'hi' },
    });
    expect(stub.inputs).toBe(original.inputs);
    expect(stub.inputSchema).toBe(original.inputSchema);
    expect(stub.build).toBe(original.build);
    expect(stub.name).toBe(original.name);
  });
});
