/**
 * `mockService`'s override argument is typed against the service's own `deps`
 * (`HydratedDeps<D>`) and `input` (the schema's inferred output, required
 * exactly when the service declares a schema — ADR-0042). A double that
 * doesn't satisfy a dep's hydrated shape, or an input of the wrong type, must
 * fail to compile. Type-only (vitest `--typecheck`, never executed): see
 * testing.test.ts for the runtime behavior.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { expectTypeOf, test } from 'vitest';
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
      throw new Error('unused — type-only file, never executed');
    },
    load(): never {
      throw new Error('unused — type-only file, never executed');
    },
    input(): never {
      throw new Error('unused — type-only file, never executed');
    },
  });

const schemaless = (): RunnableServiceNode<ConsumerDeps, ConsumerParams, Expose, undefined> =>
  Object.freeze({
    ...service({
      name: 'schemaless',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: { auth: authDep() },
      params: { port: number({ default: 3000 }) },
      build,
    }),
    async run(): Promise<unknown> {
      throw new Error('unused — type-only file, never executed');
    },
    load(): never {
      throw new Error('unused — type-only file, never executed');
    },
    input(): never {
      throw new Error('unused — type-only file, never executed');
    },
  });

test('a correctly-shaped double compiles; input() is typed by the schema', () => {
  const stub = mockService(consumer(), {
    auth: { verify: async ({ token }: { token: string }) => ({ ok: token.length > 0 }) },
    input: { greeting: 'hello' },
  });

  expectTypeOf(stub).toEqualTypeOf<
    RunnableServiceNode<ConsumerDeps, ConsumerParams, Expose, typeof consumerSchema>
  >();
  expectTypeOf(stub.input()).toEqualTypeOf<ConsumerInput>();
});

test('omitting the required "auth" override is a compile error', () => {
  // @ts-expect-error "auth" is a declared dep with no default — it must be supplied
  mockService(consumer(), { input: { greeting: 'hello' } });
});

test('omitting the required input override is a compile error when the service declares a schema', () => {
  // @ts-expect-error the service declares an input schema — the input double must be supplied
  mockService(consumer(), { auth: { verify: async () => ({ ok: true }) } });
});

test("a double whose method return shape doesn't satisfy the dep's hydrated contract is a compile error", () => {
  mockService(consumer(), {
    // @ts-expect-error verify must resolve to `{ ok: boolean }`, not `{ status: string }`
    auth: { verify: async () => ({ status: 'ok' }) },
    input: { greeting: 'hello' },
  });
});

test('an input double of the wrong shape is a compile error', () => {
  mockService(consumer(), {
    auth: { verify: async () => ({ ok: true }) },
    // @ts-expect-error greeting is declared `string`
    input: { greeting: 42 },
  });
});

test('a schema-less service takes no input override', () => {
  mockService(schemaless(), { auth: { verify: async () => ({ ok: true }) } });
  mockService(schemaless(), {
    auth: { verify: async () => ({ ok: true }) },
    // @ts-expect-error no input schema declared — nothing to double
    input: { anything: true },
  });
});
