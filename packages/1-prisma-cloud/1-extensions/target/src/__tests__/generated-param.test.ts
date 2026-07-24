/**
 * The `generatedParam()` source and the `GeneratedParam` resource — proven
 * WITHOUT Alchemy: the provider `reconcile` generates a fresh value on first
 * create (no prior `output`) and returns the persisted value UNCHANGED on every
 * later apply (the no-op-redeploy property the deploy relies on), plus the
 * source constructor's validation and `isGeneratedParamSource` discrimination.
 */
import { describe, expect, test } from 'bun:test';
import { isParamSource, paramSource } from '@internal/core';
import * as Effect from 'effect/Effect';
import {
  type GeneratedParamAttributes,
  generatedParamProviderService,
  generateValue,
} from '../generated-param-resource.ts';
import { envParam, generatedParam, isEnvParamSource, isGeneratedParamSource } from '../param.ts';
import { envSecret } from '../secret.ts';

const reconcile = (bytes: number, output: GeneratedParamAttributes | undefined) =>
  generatedParamProviderService.reconcile({
    id: 'gen',
    instanceId: 'gen',
    news: { bytes },
    olds: output === undefined ? undefined : { bytes },
    output,
    session: undefined as never,
    bindings: undefined as never,
  });

describe('GeneratedParam generate provider', () => {
  test('first create generates a fresh value that decodes to `bytes` bytes', async () => {
    const attrs = await Effect.runPromise(reconcile(32, undefined));
    expect(atob(attrs.value)).toHaveLength(32);
  });

  test('the byte length follows the prop', async () => {
    const attrs = await Effect.runPromise(reconcile(16, undefined));
    expect(atob(attrs.value)).toHaveLength(16);
  });

  test('a redeploy returns the persisted value unchanged (idempotent no-op)', async () => {
    const first = await Effect.runPromise(reconcile(32, undefined));
    const second = await Effect.runPromise(reconcile(32, first));
    expect(second).toEqual(first);
  });

  test('changing `bytes` on an existing resource keeps the old value — rotation is destroy/recreate', async () => {
    const first = await Effect.runPromise(reconcile(32, undefined));
    const afterBytesChange = await Effect.runPromise(reconcile(64, first));
    expect(afterBytesChange).toEqual(first);
    expect(atob(afterBytesChange.value)).toHaveLength(32);
  });

  test('two independent generations differ (the value is random, not derived)', () => {
    expect(generateValue(32)).not.toEqual(generateValue(32));
  });
});

describe('generatedParam() source construction', () => {
  test('defaults: 32 bytes, redacted', () => {
    const source = generatedParam();
    expect(source.payload.bytes).toBe(32);
    expect(source.payload.redacted).toBe(true);
  });

  test('honors explicit bytes and redacted', () => {
    const source = generatedParam({ bytes: 64, redacted: false });
    expect(source.payload.bytes).toBe(64);
    expect(source.payload.redacted).toBe(false);
  });

  test('accepts the inclusive bounds 16 and 1024', () => {
    expect(() => generatedParam({ bytes: 16 })).not.toThrow();
    expect(() => generatedParam({ bytes: 1024 })).not.toThrow();
  });

  test('rejects bytes below 16, above 1024, and non-integer — the message names the bound', () => {
    expect(() => generatedParam({ bytes: 15 })).toThrow(/between 16 and 1024/);
    expect(() => generatedParam({ bytes: 1025 })).toThrow(/between 16 and 1024/);
    expect(() => generatedParam({ bytes: 32.5 })).toThrow(/integer/);
    expect(() => generatedParam({ bytes: -1 })).toThrow(/between 16 and 1024/);
  });
});

describe('isGeneratedParamSource discrimination', () => {
  test('true only for a generatedParam() source', () => {
    expect(isGeneratedParamSource(generatedParam())).toBe(true);
  });

  test('a generated source IS a ParamSource but is NOT an envParam source (distinct brands)', () => {
    const source = generatedParam();
    expect(isParamSource(source)).toBe(true);
    expect(isEnvParamSource(source)).toBe(false);
  });

  test('env and secret sources are NOT generated', () => {
    expect(isGeneratedParamSource(envParam('APP_ORIGIN'))).toBe(false);
    expect(isGeneratedParamSource(envSecret('STRIPE_SECRET_KEY'))).toBe(false);
  });

  test('a raw core paramSource and a plain literal are NOT generated', () => {
    expect(isGeneratedParamSource(paramSource({ foo: 1 }))).toBe(false);
    expect(isGeneratedParamSource('a-literal')).toBe(false);
    expect(isGeneratedParamSource(undefined)).toBe(false);
  });
});
