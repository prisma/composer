import { describe, expect, test } from 'bun:test';
import { isPlainPointer, isSecretPointer, POINTER } from './pointer.ts';
import { SecretBox } from './secret.ts';

const plain = Object.freeze({ [POINTER]: 'plain' as const });
const secret = Object.freeze({ [POINTER]: 'secret' as const });

describe('pointer', () => {
  test('isPlainPointer() and isSecretPointer() read the kind from the pointer brand', () => {
    expect([isPlainPointer(plain), isSecretPointer(plain)]).toEqual([true, false]);
    expect([isPlainPointer(secret), isSecretPointer(secret)]).toEqual([false, true]);
  });

  test('anything without a plain or secret brand is no pointer', () => {
    for (const value of [
      undefined,
      null,
      'plain',
      3,
      {},
      { [POINTER]: true },
      { [POINTER]: 'other' },
      new SecretBox('x'),
    ]) {
      expect([isPlainPointer(value), isSecretPointer(value)]).toEqual([false, false]);
    }
  });

  test('the brand is the registered symbol prisma:pointer, so another copy of this module agrees', () => {
    expect<symbol>(POINTER).toBe(Symbol.for('prisma:pointer'));
  });
});
