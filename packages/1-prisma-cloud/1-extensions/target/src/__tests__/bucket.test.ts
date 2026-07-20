/**
 * The `bucket()` authoring factory — both overload shapes and the contract's
 * kind-equality with the storage module's `s3Contract`. No provisioning logic
 * here: control-lowering.test.ts covers the descriptor end-to-end.
 */
import { describe, expect, test } from 'bun:test';
import type { DependencyEnd, ResourceNode } from '@internal/core';
import { type BucketConfig, bucket, bucketContract } from '../bucket.ts';

describe('bucket() authoring factory', () => {
  test('{ name } yields a resource providing bucketContract', () => {
    const identity: ResourceNode<typeof bucketContract> = bucket({ name: 'files' });
    expect(identity.kind).toBe('resource');
    expect(identity.type).toBe('s3');
    expect(identity.provides).toBe(bucketContract);
  });

  test('bucket() yields a dependency requiring bucketContract, binding the S3Config', () => {
    const dep: DependencyEnd<BucketConfig, typeof bucketContract> = bucket();
    expect(dep.kind).toBe('dependency');
    expect(dep.type).toBe('s3');
    expect(dep.required).toBe(bucketContract);
    expect(dep.connection.params['url']).toBeDefined();
    expect(dep.connection.params['bucket']).toBeDefined();
    expect(dep.connection.params['accessKeyId']).toBeDefined();
    expect(dep.connection.params['secretAccessKey']).toBeDefined();
  });

  test('bucketContract.satisfies compares kind only — a different object with kind s3 satisfies it', () => {
    expect(
      bucketContract.satisfies({
        kind: 's3',
        __cmp: undefined,
        satisfies: () => true,
      }),
    ).toBe(true);
  });

  test('bucketContract and the storage module s3Contract are interchangeable by kind — a bucket fills an s3() slot', () => {
    // The storage module's s3Contract is not imported here (cross-layer
    // import is forbidden). Instead, verify the kind string directly: any
    // contract whose satisfies compares kind === 's3' will accept
    // bucketContract.provides, and vice versa.
    expect(bucketContract.kind).toBe('s3');
    // bucketContract.satisfies mirrors the storage emulator's check —
    // any s3-kind contract satisfies any other s3-kind contract.
    expect(bucketContract.satisfies(bucketContract)).toBe(true);
  });
});
