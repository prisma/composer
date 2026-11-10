import { describe, expect, test } from 'bun:test';
import { containerEnvVarName } from '../container-transport.ts';
import {
  PREFLIGHT_FINDINGS_ENV_VAR,
  preflightEnv,
  preflightEnvVarName,
  preflightFindingsEnv,
  readPreflightFindings,
  readPreflightPayload,
  type UnsetPlatformVariable,
} from '../preflight-transport.ts';

describe('preflightEnvVarName()', () => {
  test('the documented mangling — the exact @prisma/composer-prisma-cloud expectation', () => {
    expect(preflightEnvVarName('@prisma/composer-prisma-cloud')).toBe(
      'PRISMA_COMPOSER_PREFLIGHT_PRISMA_COMPOSER_PRISMA_CLOUD',
    );
  });

  test('never collides with the container transport variable for the same extension', () => {
    expect(preflightEnvVarName('@prisma/composer-prisma-cloud')).not.toBe(
      containerEnvVarName('@prisma/composer-prisma-cloud'),
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

  test('two ids that map to the same var name fail loudly, naming both', () => {
    expect(() =>
      preflightEnv(
        new Map([
          ['acme.widgets', 'a'],
          ['acme/widgets', 'b'],
        ]),
      ),
    ).toThrow(/"acme\.widgets" and "acme\/widgets" both use the environment variable/);
  });

  test('an extension whose variable would be the findings variable is refused, naming the reserved variable', () => {
    expect(() => preflightEnv(new Map([['findings', 'a']]))).toThrow(
      'Extension id "findings" uses the environment variable "PRISMA_COMPOSER_PREFLIGHT_FINDINGS", which Composer reserves. Rename the extension.',
    );
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

describe('the deploy preflight findings', () => {
  const unset: UnsetPlatformVariable = {
    name: 'MAIL_KEY',
    readers: [{ kind: 'unread', node: 'app.mail', nodeKind: 'module' }],
    commands: ["prisma project env add 'MAIL_KEY=<value>' --project 'proj' --role production"],
  };

  test('reach the second process as the first process wrote them', () => {
    expect(readPreflightFindings(preflightFindingsEnv({ unset: [unset] }))).toEqual({
      unset: [unset],
    });
  });

  test('are always written, and empty when nothing was found, so a stale value in the shell is replaced', () => {
    expect(preflightFindingsEnv({ unset: [] })).toEqual({ [PREFLIGHT_FINDINGS_ENV_VAR]: '' });
    expect(readPreflightFindings(preflightFindingsEnv({ unset: [] }))).toEqual({ unset: [] });
    expect(readPreflightFindings({})).toEqual({ unset: [] });
  });

  test('that do not decode fail rather than print a partial report', () => {
    expect(() => readPreflightFindings({ [PREFLIGHT_FINDINGS_ENV_VAR]: 'not json' })).toThrow(
      /could not be read in the second process/,
    );
    expect(() =>
      readPreflightFindings({ [PREFLIGHT_FINDINGS_ENV_VAR]: '{"unset":[{"name":"A_KEY"}]}' }),
    ).toThrow(/could not be read in the second process/);
  });
});
