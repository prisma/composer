/**
 * Type-level wiring for storage(): the module's `store` port is assignable to a
 * consumer's `s3()` slot, and a wrong-kind port is rejected (the s3 slot's
 * required contract is kind-specific). Type-only (vitest --typecheck, never
 * executed) — mirrors cron's module.test-d.ts.
 */
import type { ModuleNode, RefPort } from '@internal/core';
import { module } from '@internal/core';
import node from '@internal/node';
import { compute, type postgresContract } from '@internal/prisma-cloud';
import { expectTypeOf, test } from 'vitest';
import { s3, type s3Contract } from '../contract.ts';
import { storage } from '../storage-module.ts';

const build = node({ module: import.meta.url, entry: '../dist/x.mjs' });

test('storage() is a ModuleNode exposing a store port', () => {
  const s = storage();
  const asModule: ModuleNode<Record<never, never>, { store: typeof s3Contract }> = s;
  void asModule;
});

test("the module's store port wires into a consumer's s3() slot", () => {
  module('root', {}, ({ provision }) => {
    const store = provision(storage(), { id: 'storage' });
    provision(compute({ name: 'consumer', deps: { store: s3() }, build }), {
      id: 'consumer',
      deps: { store: store.store },
    });
    return {};
  });
});

test('the s3 slot accepts an s3 port but rejects a wrong-kind (postgres) one', () => {
  // The consumer's s3() slot requires `typeof s3Contract` (kind "s3"). The
  // module's store port is a RefPort of that contract; a postgres port is not.
  expectTypeOf<RefPort<typeof s3Contract>>().toExtend<typeof s3Contract>();
  expectTypeOf<RefPort<typeof postgresContract>>().not.toExtend<typeof s3Contract>();
});
