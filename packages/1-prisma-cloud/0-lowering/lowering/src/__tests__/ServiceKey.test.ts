/**
 * The `ServiceKey` mint, proven WITHOUT Alchemy: its provider `reconcile`
 * mints a fresh key on first create (no prior `output`) and returns the
 * persisted key UNCHANGED on every later apply — the no-op-redeploy property
 * ADR-0030's service keys rely on. Driven directly against the exported
 * provider service, mirroring the target package's s3-credentials-resource
 * test.
 */
import { describe, expect, test } from 'bun:test';
import * as Effect from 'effect/Effect';
import {
  mintServiceKey,
  type ServiceKeyAttributes,
  serviceKeyProviderService,
} from '../compute/ServiceKey.ts';

const reconcile = (output: ServiceKeyAttributes | undefined) =>
  serviceKeyProviderService.reconcile({
    id: 'key',
    instanceId: 'key',
    news: {},
    olds: output === undefined ? undefined : {},
    output,
    session: undefined as never,
    bindings: undefined as never,
  });

describe('ServiceKey mint provider', () => {
  test('first create mints a fresh 64-char hex key', async () => {
    const key = await Effect.runPromise(reconcile(undefined));
    expect(key.value).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a redeploy returns the persisted key unchanged (idempotent no-op)', async () => {
    const first = await Effect.runPromise(reconcile(undefined));
    const second = await Effect.runPromise(reconcile(first));
    expect(second).toEqual(first);
  });

  test('two independent mints differ (the key is random, not derived)', () => {
    expect(mintServiceKey()).not.toEqual(mintServiceKey());
  });
});
