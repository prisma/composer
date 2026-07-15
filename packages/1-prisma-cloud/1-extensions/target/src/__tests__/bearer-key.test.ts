/**
 * The `bearer-key` mint, proven WITHOUT Alchemy: its provider `reconcile`
 * mints a fresh key on first create (no prior `output`) and returns the
 * persisted key UNCHANGED on every later apply — the no-op-redeploy property.
 * Driven directly against the exported provider service (the
 * s3-credentials.test.ts pattern), plus the dual-form authoring factory's
 * node shapes.
 */
import { describe, expect, test } from 'bun:test';
import type { DependencyEnd, ResourceNode } from '@internal/core';
import * as Effect from 'effect/Effect';
import { type BearerKeyConfig, bearerKey, bearerKeyContract } from '../bearer-key.ts';
import {
  type BearerKeyAttributes,
  bearerKeyProviderService,
  mintBearerKey,
} from '../bearer-key-resource.ts';

const reconcile = (output: BearerKeyAttributes | undefined) =>
  bearerKeyProviderService.reconcile({
    id: 'key',
    instanceId: 'key',
    news: {},
    olds: output === undefined ? undefined : {},
    output,
    session: undefined as never,
    bindings: undefined as never,
  });

describe('BearerKey mint provider', () => {
  test('first create mints a fresh 48-hex key', async () => {
    const key = await Effect.runPromise(reconcile(undefined));
    expect(key.apiKey).toMatch(/^[0-9a-f]{48}$/);
  });

  test('a redeploy returns the persisted key unchanged (idempotent no-op)', async () => {
    const first = await Effect.runPromise(reconcile(undefined));
    const second = await Effect.runPromise(reconcile(first));
    expect(second).toEqual(first);
  });

  test('two independent mints differ (the key is random, not derived)', () => {
    expect(mintBearerKey()).not.toEqual(mintBearerKey());
  });
});

describe('bearerKey() authoring factory', () => {
  test('{ name } yields a resource providing bearerKeyContract', () => {
    const identity: ResourceNode<typeof bearerKeyContract> = bearerKey({ name: 'credentials' });
    expect(identity.kind).toBe('resource');
    expect(identity.type).toBe('bearer-key');
    expect(identity.provides).toBe(bearerKeyContract);
  });

  test('bearerKey() yields a dependency requiring bearerKeyContract, binding the key', () => {
    const dep: DependencyEnd<BearerKeyConfig, typeof bearerKeyContract> = bearerKey();
    expect(dep.kind).toBe('dependency');
    expect(dep.type).toBe('bearer-key');
    expect(dep.required).toBe(bearerKeyContract);
    expect(dep.connection.params['apiKey']).toBeDefined();
  });

  test('bearerKeyContract.satisfies compares kind only', () => {
    expect(
      bearerKeyContract.satisfies({
        kind: 'bearer-key',
        __cmp: undefined,
        satisfies: () => true,
      }),
    ).toBe(true);
  });
});
