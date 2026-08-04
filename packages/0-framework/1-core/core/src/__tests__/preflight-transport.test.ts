import { describe, expect, test } from 'bun:test';
import { preflightEnv, preflightEnvVarName, readPreflightPayload } from '../preflight-transport.ts';

describe('preflightEnvVarName()', () => {
  test('the documented mangling — the exact @prisma/composer-prisma-cloud expectation', () => {
    expect(preflightEnvVarName('@prisma/composer-prisma-cloud')).toBe(
      'PRISMA_COMPOSER_PREFLIGHT_PRISMA_COMPOSER_PRISMA_CLOUD',
    );
  });

  test('never collides with the container transport variable for the same extension', () => {
    expect(preflightEnvVarName('@prisma/composer-prisma-cloud')).not.toBe(
      'PRISMA_COMPOSER_CONTAINER_PRISMA_COMPOSER_PRISMA_CLOUD',
    );
  });
});

describe('preflightEnv()', () => {
  test('one var per extension, holding the payload that extension wrote, verbatim', () => {
    expect(
      preflightEnv(
        new Map([
          ['@prisma/composer-prisma-cloud', '{"STRIPE_KEY":"2026-05-05T12:00:00.000Z"}'],
          ['acme.widgets/v2', 'whatever-this-extension-wrote'],
        ]),
      ),
    ).toEqual({
      PRISMA_COMPOSER_PREFLIGHT_PRISMA_COMPOSER_PRISMA_CLOUD:
        '{"STRIPE_KEY":"2026-05-05T12:00:00.000Z"}',
      PRISMA_COMPOSER_PREFLIGHT_ACME_WIDGETS_V2: 'whatever-this-extension-wrote',
    });
  });

  test('an extension with nothing to carry sets no var', () => {
    expect(preflightEnv(new Map([['acme.widgets', '']]))).toEqual({});
    expect(preflightEnv(new Map())).toEqual({});
  });

  test('two ids that mangle to the same var name fail loudly, naming both', () => {
    expect(() =>
      preflightEnv(
        new Map([
          ['acme.widgets', 'a'],
          ['acme/widgets', 'b'],
        ]),
      ),
    ).toThrow(/both mangle to the preflight transport variable/);
  });
});

describe('readPreflightPayload()', () => {
  test('reads back exactly what the CLI process wrote', () => {
    const payload = '{"STRIPE_KEY":"2026-05-05T12:00:00.000Z"}';
    const env = preflightEnv(new Map([['@prisma/composer-prisma-cloud', payload]]));

    expect(readPreflightPayload('@prisma/composer-prisma-cloud', env)).toBe(payload);
  });

  test('a var belonging to another extension is not read as this one', () => {
    const env = preflightEnv(new Map([['acme.widgets', 'not-mine']]));

    expect(readPreflightPayload('@prisma/composer-prisma-cloud', env)).toBeUndefined();
  });

  test('an absent or empty var reads as nothing carried', () => {
    expect(readPreflightPayload('acme.widgets', {})).toBeUndefined();
    expect(
      readPreflightPayload('acme.widgets', { PRISMA_COMPOSER_PREFLIGHT_ACME_WIDGETS: '' }),
    ).toBeUndefined();
  });
});
