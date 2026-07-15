/**
 * The `s3-credentials` mint, proven WITHOUT Alchemy: its provider `reconcile`
 * mints a fresh key pair on first create (no prior `output`) and returns the
 * persisted pair UNCHANGED on every later apply — the no-op-redeploy property
 * the whole slice relies on. Driven directly against the exported provider
 * service (the pg-warm-resource.test.ts pattern), plus the dual-form authoring
 * factory's node shapes.
 */
import { describe, expect, test } from 'bun:test';
import type { DependencyEnd, ResourceNode } from '@internal/core';
import * as Effect from 'effect/Effect';
import { type CredentialsConfig, credentialsContract, s3Credentials } from '../s3-credentials.ts';
import {
  mintKeyPair,
  type S3CredentialsAttributes,
  s3CredentialsProviderService,
} from '../s3-credentials-resource.ts';

const reconcile = (output: S3CredentialsAttributes | undefined) =>
  s3CredentialsProviderService.reconcile({
    id: 'creds',
    instanceId: 'creds',
    news: {},
    olds: output === undefined ? undefined : {},
    output,
    session: undefined as never,
    bindings: undefined as never,
  });

describe('S3Credentials mint provider', () => {
  test('first create mints a fresh AKIA key pair', async () => {
    const pair = await Effect.runPromise(reconcile(undefined));
    expect(pair.accessKeyId).toMatch(/^AKIA[0-9A-F]{16}$/);
    expect(pair.secretAccessKey).toHaveLength(40);
  });

  test('a redeploy returns the persisted pair unchanged (idempotent no-op)', async () => {
    const first = await Effect.runPromise(reconcile(undefined));
    const second = await Effect.runPromise(reconcile(first));
    expect(second).toEqual(first);
  });

  test('two independent mints differ (the pair is random, not derived)', () => {
    expect(mintKeyPair()).not.toEqual(mintKeyPair());
  });
});

describe('s3Credentials() authoring factory', () => {
  test('{ name } yields a resource providing credentialsContract', () => {
    const identity: ResourceNode<typeof credentialsContract> = s3Credentials({ name: 'creds' });
    expect(identity.kind).toBe('resource');
    expect(identity.type).toBe('credentials');
    expect(identity.provides).toBe(credentialsContract);
  });

  test('s3Credentials() yields a dependency requiring credentialsContract, binding the key pair', () => {
    const dep: DependencyEnd<CredentialsConfig, typeof credentialsContract> = s3Credentials();
    expect(dep.kind).toBe('dependency');
    expect(dep.type).toBe('credentials');
    expect(dep.required).toBe(credentialsContract);
    expect(dep.connection.params['accessKeyId']).toBeDefined();
    expect(dep.connection.params['secretAccessKey']).toBeDefined();
  });

  test('credentialsContract.satisfies compares kind only', () => {
    expect(
      credentialsContract.satisfies({
        kind: 'credentials',
        __cmp: undefined,
        satisfies: () => true,
      }),
    ).toBe(true);
  });
});
