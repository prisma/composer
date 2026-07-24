import { describe, expect, test } from 'bun:test';
import { isSecretSource, secretSource } from '@internal/core';
import { envSecret, secretName } from '../secret.ts';

describe('envSecret (Prisma Cloud secret source)', () => {
  test('builds an opaque secret source; secretName reads its env-var name back', () => {
    const source = envSecret('STRIPE_SECRET_KEY');
    expect(isSecretSource(source)).toBe(true);
    expect(secretName(source, 'input key "stripeKey" of service "ingest"')).toBe(
      'STRIPE_SECRET_KEY',
    );
  });

  test('rejects empty, COMPOSER_-prefixed, and poisoned names', () => {
    expect(() => envSecret('')).toThrow(/non-empty/);
    expect(() => envSecret('COMPOSER_X')).toThrow(/COMPOSER_/);
    expect(() => envSecret('DATABASE_URL')).toThrow(/reserved/);
    expect(() => envSecret('DATABASE_URL_POOLED')).toThrow(/reserved/);
  });

  test('secretName rejects a leaf bound to a source not built by envSecret', () => {
    // A user who bypasses envSecret and binds a raw core secretSource: the
    // payload has no envSecret brand, so there is no platform name to read.
    const source = secretSource('STRIPE_SECRET_KEY');
    const read = () => secretName(source, 'input key "stripeKey" of service "ingest"');
    expect(read).toThrow(/input key "stripeKey" of service "ingest".*not created by envSecret/);
    expect(read).toThrow(/envSecret\('NAME'\) from @prisma\/composer-prisma-cloud/);
  });
});
