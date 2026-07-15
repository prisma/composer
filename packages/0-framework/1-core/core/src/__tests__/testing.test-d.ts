/**
 * `mockService`'s override argument is typed against the service's own `deps`
 * (`HydratedDeps<D>`) and `params` (`Partial<Values<P>>`) — a double that
 * doesn't satisfy a dep's hydrated shape, or a param of the wrong type, must
 * fail to compile. Type-only (vitest `--typecheck`, never executed): see
 * testing.test.ts for the runtime behavior.
 */
import { expectTypeOf, test } from 'vitest';
import { number, string } from '../config.ts';
import type { BuildAdapter, RunnableServiceNode } from '../node.ts';
import { dependency, service } from '../node.ts';
import { mockService } from '../testing.ts';
import { conn } from './helpers.ts';

const build: BuildAdapter = {
  extension: '@prisma/compose/node',
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
      throw new Error('unused — type-only file, never executed');
    },
    load() {
      throw new Error('unused — type-only file, never executed');
    },
    config() {
      throw new Error('unused — type-only file, never executed');
    },
    secrets() {
      throw new Error('unused — type-only file, never executed');
    },
  });

test('a correctly-shaped double, with or without the optional param override, compiles', () => {
  const withoutParam = mockService(consumer(), {
    auth: { verify: async ({ token }: { token: string }) => ({ ok: token.length > 0 }) },
  });
  const withParam = mockService(consumer(), {
    auth: { verify: async () => ({ ok: true }) },
    port: 8080,
  });

  expectTypeOf(withoutParam).toEqualTypeOf<RunnableServiceNode<ConsumerDeps, ConsumerParams>>();
  expectTypeOf(withParam).toEqualTypeOf<RunnableServiceNode<ConsumerDeps, ConsumerParams>>();
});

test('omitting the required "auth" override is a compile error', () => {
  // @ts-expect-error "auth" is a declared dep with no default — it must be supplied
  mockService(consumer(), {});
});

test("a double whose method return shape doesn't satisfy the dep's hydrated contract is a compile error", () => {
  // @ts-expect-error verify must resolve to `{ ok: boolean }`, not `{ status: string }`
  mockService(consumer(), { auth: { verify: async () => ({ status: 'ok' }) } });
});

test('overriding a param with the wrong type is a compile error', () => {
  // @ts-expect-error port is declared `number`
  mockService(consumer(), { auth: { verify: async () => ({ ok: true }) }, port: 'nope' });
});
