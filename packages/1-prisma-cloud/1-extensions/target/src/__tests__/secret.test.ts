import { describe, expect, test } from 'bun:test';
import {
  isPlainPointer,
  isSecretPointer,
  isSecretSource,
  LoadError,
  secretSource,
} from '@internal/core';
import { envSecret, secretName } from '../secret.ts';

describe('envSecret (Prisma Cloud secret source)', () => {
  test('builds an opaque secret source; secretName reads its env-var name back', () => {
    const source = envSecret('STRIPE_SECRET_KEY');
    expect(isSecretSource(source)).toBe(true);
    expect(secretName(source, 'input key "stripeKey" of service "ingest"')).toBe(
      'STRIPE_SECRET_KEY',
    );
  });

  test('rejects an empty name', () => {
    expect(() => envSecret('')).toThrow(
      "envSecret() requires a non-empty platform variable name, e.g. envSecret('API_KEY').",
    );
  });

  test.each(['api_key', 'Api_Key', '_TOKEN', '1TOKEN', 'API-KEY'])(
    'rejects %s, which is not an upper-case platform variable name',
    (name) => {
      expect(() => envSecret(name)).toThrow(
        `envSecret name "${name}" is not a platform variable name: it must match ^[A-Z][A-Z0-9_]*$, an upper-case letter followed by upper-case letters, digits and underscores, because the platform accepts no other key and a process environment compares names with case.`,
      );
    },
  );

  test.each([
    ['COMPOSER_X', "names starting with COMPOSER_ are Composer's own platform variables."],
    [
      'DATABASE_URL',
      'Prisma Cloud sets and manages DATABASE_URL and DATABASE_URL_POOLED itself. Declare the database your service uses and read its url from that connection.',
    ],
    [
      'DATABASE_URL_POOLED',
      'Prisma Cloud sets and manages DATABASE_URL and DATABASE_URL_POOLED itself. Declare the database your service uses and read its url from that connection.',
    ],
    ['PORT', "boot sets PORT to the service's port."],
    [
      'PATH',
      'under prisma dev the local target sets PATH and HOME from your shell, so a value on the platform would never be seen locally.',
    ],
    [
      'HOME',
      'under prisma dev the local target sets PATH and HOME from your shell, so a value on the platform would never be seen locally.',
    ],
  ])('rejects the reserved name %s, saying why', (name, reason) => {
    expect(() => envSecret(name)).toThrow(`envSecret name "${name}" is reserved: ${reason}`);
  });

  test('accepts HOST and a name with digits and underscores', () => {
    expect(() => envSecret('HOST')).not.toThrow();
    expect(() => envSecret('STRIPE_KEY_2')).not.toThrow();
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
        'its value, and it was turned into text (a template literal or String()). A module body ' +
        'can only pass it on, into a provision() binding; to compute with the value, do it in ' +
        'the service that reads it.',
    );
  });

  test('envSecret() is a secret pointer', () => {
    expect(isSecretPointer(envSecret('X'))).toBe(true);
    expect(isPlainPointer(envSecret('X'))).toBe(false);
  });
});
