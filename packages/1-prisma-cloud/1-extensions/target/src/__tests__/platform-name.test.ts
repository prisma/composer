import { describe, expect, test } from 'bun:test';
import { validatePlatformName } from '../descriptors/shared.ts';

describe('validatePlatformName', () => {
  test('a Connection name needs at least 3 characters', () => {
    expect(() => validatePlatformName('Connection', 'a.')).toThrow(
      'prisma-cloud: the node "a." is 2 characters long, but Connection names on Prisma Cloud ' +
        "take 3 to 52 characters, and every platform name is the node's address. Lengthen a provision id.",
    );
    expect(() => validatePlatformName('Connection', 'a.b')).not.toThrow();
  });

  test('an App or Bucket name needs at least 1 character', () => {
    expect(() => validatePlatformName('App', '')).toThrow(
      'but App names on Prisma Cloud take 1 to 256 characters',
    );
    expect(() => validatePlatformName('Bucket', '')).toThrow(
      'but Bucket names on Prisma Cloud take 1 to 100 characters',
    );
    expect(() => validatePlatformName('App', 'a')).not.toThrow();
    expect(() => validatePlatformName('Bucket', 'a')).not.toThrow();
  });

  test('each kind accepts an address exactly at its maximum and rejects one character more', () => {
    for (const [kind, max] of [
      ['App', 256],
      ['Connection', 52],
      ['Bucket', 100],
    ] as const) {
      expect(() => validatePlatformName(kind, 'a'.repeat(max))).not.toThrow();
      expect(() => validatePlatformName(kind, 'a'.repeat(max + 1))).toThrow(
        `is ${max + 1} characters long, but ${kind} names on Prisma Cloud take`,
      );
    }
  });
});
