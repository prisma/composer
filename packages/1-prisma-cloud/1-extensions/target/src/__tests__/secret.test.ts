import { describe, expect, test } from 'bun:test';
import { isSecretSource, LoadError, secretSource } from '@internal/core';
import { envSecret, secretName } from '../secret.ts';

describe('envSecret (Prisma Cloud secret source)', () => {
  test('builds an opaque secret source; secretName reads its env-var name back', () => {
    const source = envSecret('STRIPE_SECRET_KEY');
    expect(isSecretSource(source)).toBe(true);
    expect(secretName(source, 'input key "stripeKey" of service "ingest"')).toBe(
      'STRIPE_SECRET_KEY',
    );
  });

  test('rejects empty, COMPOSER_-prefixed, and reserved DATABASE_URL names', () => {
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

describe('envSecret() as a value', () => {
  test('envSecret() turned into text fails naming it and saying it is known only at boot', () => {
    let thrown: unknown;
    try {
      String(envSecret('STRIPE_KEY'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LoadError);
    expect((thrown as Error).message).toBe(
      "envSecret('STRIPE_KEY') is known only at boot: the deploy holds a pointer to it, never " +
        'its value, and it was turned into text (a template literal or String()). A resolve() ' +
        'function may return the pointer, or put it in its result, unchanged; to compute with ' +
        'the value, do it in the service that reads it.',
    );
  });
});
