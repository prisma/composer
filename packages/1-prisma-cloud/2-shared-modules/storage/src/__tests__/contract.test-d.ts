/**
 * s3()'s binding and s3Contract's kind comparison.
 *
 * Type-only (checked by `tsc --noEmit`, never executed) — mirrors
 * target's postgres-shapes.test-d.ts.
 */
import type { Contract, DependencyEnd, Hydrated } from '@internal/core';
import { expectTypeOf, test } from 'vitest';
import type { S3Config } from '../contract.ts';
import { s3, s3Contract } from '../contract.ts';

const dep = s3();

test('s3() yields the dependency requiring s3Contract; its binding is S3Config', () => {
  expectTypeOf(dep).toEqualTypeOf<DependencyEnd<S3Config, typeof s3Contract>>();
  expectTypeOf<Hydrated<typeof dep>>().toEqualTypeOf<S3Config>();
});

test('s3Contract.satisfies accepts another contract of kind "s3"', () => {
  const otherS3: Contract<'s3', { readonly token: string }> = {
    kind: 's3',
    __cmp: { token: '' },
    satisfies: (required) => required.kind === 's3',
  };
  s3Contract.satisfies(otherS3);
});

test('s3Contract.satisfies rejects a differently-kinded contract at compile time', () => {
  const postgresLike: Contract<'postgres', { readonly url: string }> = {
    kind: 'postgres',
    __cmp: { url: '' },
    satisfies: (required) => required.kind === 'postgres',
  };
  // @ts-expect-error required contract must be kind "s3"
  s3Contract.satisfies(postgresLike);
});
