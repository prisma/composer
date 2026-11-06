import { describe, expect, test } from 'bun:test';
import {
  collectPlatformMarkers,
  describeDocument,
  escapeKey,
  generatedMarker,
  platformMarker,
  readDocument,
  unescapeKey,
  withUnsetVariables,
} from '../exports/index.ts';

const boxed = (text: string) => ({ boxed: text });

const read = (document: unknown, env: Record<string, string>) =>
  readDocument(document, { key: 'COMPOSER_INPUT', variable: (name) => env[name], secret: boxed });

describe('platformMarker', () => {
  test('carries secret: true only for a secret', () => {
    expect(platformMarker('X', true)).toEqual({ $platform: { name: 'X', secret: true } });
    expect(platformMarker('X', false)).toEqual({ $platform: { name: 'X' } });
  });
});

describe('the key escape', () => {
  test('a user key spelled like a marker gains one "$" and loses it on read', () => {
    for (const key of ['$platform', '$$platform', '$generated', '$secret', '$$secret']) {
      expect(escapeKey(key)).toBe(`$${key}`);
      expect(unescapeKey(escapeKey(key))).toBe(key);
    }
    expect(escapeKey('platform')).toBe('platform');
    expect(escapeKey('$platforms')).toBe('$platforms');
    expect(unescapeKey('$platform')).toBe('$platform');
  });
});

describe('collectPlatformMarkers', () => {
  test('finds every marker at any depth, with its path, secret flag and array position', () => {
    const document = {
      apiKey: platformMarker('API_KEY', true),
      nested: { $$platform: { from: platformMarker('FROM', false) } },
      list: [platformMarker('LISTED', true)],
      token: generatedMarker('COMPOSER_WEB_TOKEN_GENERATED', true),
    };
    expect(collectPlatformMarkers(document)).toEqual([
      { name: 'API_KEY', path: 'apiKey', secret: true, inArray: false },
      { name: 'FROM', path: 'nested.$platform.from', secret: false, inArray: false },
      { name: 'LISTED', path: 'list.0', secret: true, inArray: true },
    ]);
  });

  test('a malformed marker is refused, naming its path', () => {
    expect(() => collectPlatformMarkers({ a: { $platform: 'X' } })).toThrow(
      'the input document holds a malformed $platform marker at "a"',
    );
  });
});

describe('readDocument', () => {
  test('a variable with text takes the text, and a secret is boxed', () => {
    const document = { from: platformMarker('FROM', false), key: platformMarker('KEY', true) };
    expect(read(document, { FROM: 'shop@example.com', KEY: 'abc' })).toEqual({
      value: { from: 'shop@example.com', key: { boxed: 'abc' } },
      unset: [],
    });
  });

  test('an unset or empty variable leaves its key out, and is named once in unset', () => {
    const document = {
      a: platformMarker('MISSING', true),
      nested: { b: platformMarker('MISSING', true), c: platformMarker('EMPTY', false) },
    };
    expect(read(document, { EMPTY: '' })).toEqual({
      value: { nested: {} },
      unset: ['MISSING', 'EMPTY'],
    });
  });

  test('an unset variable in an array position fails, naming the variable and the path', () => {
    expect(() => read({ list: ['a', platformMarker('LISTED', true)] }, {})).toThrow(
      'input key "list.1" (env COMPOSER_INPUT) reads the platform variable "LISTED", which has no value. An array position cannot be left out: set "LISTED" with prisma project env add.',
    );
  });

  test('a generated marker is boxed only when redacted, and fails when unset', () => {
    const document = {
      secret: generatedMarker('G_SECRET', true),
      plain: generatedMarker('G_PLAIN', false),
    };
    expect(read(document, { G_SECRET: 's', G_PLAIN: 'p' }).value).toEqual({
      secret: { boxed: 's' },
      plain: 'p',
    });
    expect(() => read(document, { G_PLAIN: 'p' })).toThrow(
      /COMPOSER_INPUT → G_SECRET.*deploy and the running service disagree/,
    );
  });

  test('escaped user keys are unescaped', () => {
    expect(read({ $$platform: 'data', $$$generated: 1 }, {}).value).toEqual({
      $platform: 'data',
      $$generated: 1,
    });
  });
});

describe('withUnsetVariables', () => {
  test('ends the message with the unset names, when there are any', () => {
    expect(withUnsetVariables('apiKey must be a string', [])).toBe('apiKey must be a string');
    expect(withUnsetVariables('apiKey must be a string', ['A', 'B'])).toBe(
      'apiKey must be a string (platform variables with no value: A, B)',
    );
  });
});

describe('describeDocument', () => {
  test('shows each marker as its kind and name, never its JSON', () => {
    expect(
      describeDocument({
        greeting: 'hello',
        key: platformMarker('STRIPE_SECRET_KEY', true),
        list: [1, generatedMarker('COMPOSER_WEB_TOKEN_GENERATED', true)],
      }),
    ).toBe(
      '{"greeting":"hello","key":$platform STRIPE_SECRET_KEY,"list":[1,$generated COMPOSER_WEB_TOKEN_GENERATED]}',
    );
  });
});
