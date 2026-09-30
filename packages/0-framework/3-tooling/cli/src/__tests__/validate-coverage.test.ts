import { describe, expect, test } from 'bun:test';
import { Load } from '@internal/core';
import type { PrismaAppConfig } from '@internal/core/config';
import { validateRegistryCoverage } from '../validate-coverage.ts';
import fixtureModule from './fixtures/valid-module.ts';

describe('validateRegistryCoverage()', () => {
  test('a missing extension names the composer section of prisma.config.ts as the fix', () => {
    const config = { extensions: [], state: {} } as unknown as PrismaAppConfig;
    expect(() => validateRegistryCoverage(Load(fixtureModule), config)).toThrow(
      expect.objectContaining({
        code: 'CONFIG.EXTENSION_MISSING',
        fix: 'Add it to `extensions` in the `composer` section of prisma.config.ts (import its /control entry and list its descriptor).',
      }),
    );
  });
});
