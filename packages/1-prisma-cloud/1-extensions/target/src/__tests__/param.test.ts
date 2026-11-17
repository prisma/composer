import { describe, expect, test } from 'bun:test';
import { isPlainPointer, isSecretPointer } from '@internal/core';
import { generatedParam, serviceOrigin } from '../param.ts';

describe('the kind of pointer each source is', () => {
  test('serviceOrigin() and a plain generatedParam() are plain pointers, and a redacted generatedParam() is a secret pointer', () => {
    expect(isPlainPointer(serviceOrigin('shop.web'))).toBe(true);
    expect(isPlainPointer(generatedParam({ redacted: false }))).toBe(true);
    expect(isSecretPointer(generatedParam())).toBe(true);
  });
});
