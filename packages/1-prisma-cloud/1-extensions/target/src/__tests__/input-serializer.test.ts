/**
 * The input channel (ADR-0042): the deploy-side binding walk
 * (`resolveInputBinding`), the one-document serialization (`serializeInput`),
 * and the boot-side read (`readInput`) — classification, absence, `$secret`
 * escaping, sentinel validation, and the round trip.
 */
import { describe, expect, test } from 'bun:test';
import { SecretBox, service } from '@internal/core';
import { secretString } from '@internal/foundation/arktype';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { envParam } from '../param.ts';
import { envSecret } from '../secret.ts';
import { inputKey, readInput, resolveInputBinding, serializeInput } from '../serializer.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const svc = (schema: StandardSchemaV1) =>
  service({
    name: 'web',
    extension: '@prisma/composer-prisma-cloud',
    type: 'compute',
    inputs: {},
    params: {},
    input: schema,
    build,
  });

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const previous = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('resolveInputBinding — the recursive descent (ADR-0042)', () => {
  test('classifies literals, envParam, and envSecret leaves, nested objects and arrays included', () => {
    const { resolved, sentinels, absent } = resolveInputBinding(
      {
        plain: 'value',
        count: 3,
        enabled: true,
        nothing: null,
        list: ['a', 'b'],
        nested: {
          fromShell: envParam('SHELL_VALUE'),
          secretly: envSecret('STRIPE_SECRET_KEY'),
        },
      },
      { SHELL_VALUE: 'from-the-shell' },
    );

    const out = resolved as Record<string, unknown>;
    expect(out['plain']).toBe('value');
    expect(out['count']).toBe(3);
    expect(out['enabled']).toBe(true);
    expect(out['nothing']).toBeNull();
    expect(out['list']).toEqual(['a', 'b']);
    const nested = out['nested'] as Record<string, unknown>;
    expect(nested['fromShell']).toBe('from-the-shell');
    // The secret leaf resolves to an empty sentinel box, mapped to its platform name.
    expect(nested['secretly']).toBeInstanceOf(SecretBox);
    expect(sentinels.get(nested['secretly'] as SecretBox<string>)).toBe('STRIPE_SECRET_KEY');
    expect(absent).toEqual([]);
  });

  test('an unset deploy-shell var omits the key; an empty one too — the schema arbitrates absence', () => {
    const { resolved, absent } = resolveInputBinding(
      { unset: envParam('NOT_SET_ANYWHERE_XYZ'), empty: envParam('EMPTY_VALUE'), kept: 'yes' },
      { EMPTY_VALUE: '' },
    );
    expect(resolved).toEqual({ kept: 'yes' });
    expect(absent).toEqual(['unset → NOT_SET_ANYWHERE_XYZ', 'empty → EMPTY_VALUE']);
  });

  test('an env-bound array element that resolves absent is a loud error — positions cannot be omitted', () => {
    expect(() =>
      resolveInputBinding({ list: ['a', envParam('NOT_SET_ANYWHERE_XYZ')] }, {}),
    ).toThrow(/array element/);
  });

  test('a raw SecretBox (a secret VALUE) in the binding is rejected loudly', () => {
    expect(() => resolveInputBinding({ key: new SecretBox('sk_live_oops') }, {})).toThrow(
      /never belongs in a binding/,
    );
  });
});

describe('serializeInput — validate with sentinels, serialize the validated output', () => {
  const conditional = type({ stripeEnabled: 'false' }).or({
    stripeEnabled: 'true',
    stripeKey: secretString(),
  });

  test('discriminated-union conditionality passes with the satisfied arm (sentinel boxes as secrets)', () => {
    const row = serializeInput(
      svc(conditional),
      'web',
      { stripeEnabled: true, stripeKey: envSecret('STRIPE_SECRET_KEY') },
      {},
    );
    expect(row?.key).toBe('COMPOSER_WEB_INPUT');
    expect(JSON.parse(row?.value ?? '')).toEqual({
      stripeEnabled: true,
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
    });
  });

  test('the off arm needs no secret — the key is simply not bound', () => {
    const row = serializeInput(svc(conditional), 'web', { stripeEnabled: false }, {});
    expect(JSON.parse(row?.value ?? '')).toEqual({ stripeEnabled: false });
  });

  test('the on arm with a MISSING secret fails at deploy with the schema library’s own error', () => {
    expect(() => serializeInput(svc(conditional), 'web', { stripeEnabled: true }, {})).toThrow(
      /invalid input for service "web"/,
    );
  });

  test('misclassification — a literal where the schema wants a SecretString — fails at deploy, with the ADR-0042 note', () => {
    const attempt = () =>
      serializeInput(
        svc(conditional),
        'web',
        { stripeEnabled: true, stripeKey: 'sk_live_in_plain_config' },
        {},
      );
    expect(attempt).toThrow(/invalid input for service "web"/);
    expect(attempt).toThrow(/secretness, or the schema refines on secret content/);
  });

  test('envSecret where the schema wants a plain string fails the same way', () => {
    const schema = type({ url: 'string' });
    expect(() =>
      serializeInput(svc(schema), 'web', { url: envSecret('NOT_ACTUALLY_SECRET') }, {}),
    ).toThrow(/invalid input for service "web"/);
  });

  test('the document is DEFAULTS-APPLIED — the validated output is serialized, not the raw binding', () => {
    const schema = type({ greeting: 'string', 'retries?': 'number' }).pipe((v) => ({
      retries: 1,
      ...v,
    }));
    const row = serializeInput(svc(schema), 'web', { greeting: 'hello' }, {});
    expect(JSON.parse(row?.value ?? '')).toEqual({ greeting: 'hello', retries: 1 });
  });

  test('secret values never appear in the document, even when the deploy shell holds them', () => {
    const row = serializeInput(
      svc(conditional),
      'web',
      { stripeEnabled: true, stripeKey: envSecret('STRIPE_SECRET_KEY') },
      { STRIPE_SECRET_KEY: 'sk_live_should_not_leak' },
    );
    expect(row?.value).not.toContain('sk_live');
    expect(row?.value).toContain('"$secret":"STRIPE_SECRET_KEY"');
  });

  test('a schema that mints its own SecretBox (a default) is rejected — no platform var stands behind it', () => {
    const schema = type({ greeting: 'string' }).pipe((v) => ({
      ...v,
      injected: new SecretBox('made-up'),
    }));
    expect(() => serializeInput(svc(schema), 'web', { greeting: 'hi' }, {})).toThrow(
      /must not mint secret boxes/,
    );
  });

  test('a service with no input schema serializes nothing; a stray binding is a loud invariant error', () => {
    const plain = service({
      name: 'plain',
      extension: '@prisma/composer-prisma-cloud',
      type: 'compute',
      inputs: {},
      params: {},
      build,
    });
    expect(serializeInput(plain, 'plain', undefined, {})).toBeUndefined();
    expect(() => serializeInput(plain, 'plain', {}, {})).toThrow(/declares no input schema/);
  });

  test('a declared schema with no recorded binding is a loud invariant error', () => {
    expect(() => serializeInput(svc(conditional), 'web', undefined, {})).toThrow(
      /no recorded input binding/,
    );
  });
});

describe('the reserved $secret key — user data round-trips (ADR-0042)', () => {
  const anySchema: StandardSchemaV1<unknown, unknown> = {
    '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
  };

  test('a user object containing "$secret" (and "$$secret") is escaped on write and unescaped on read', async () => {
    const binding = {
      real: envSecret('REAL_SECRET'),
      forged: { $secret: 'NOT_A_POINTER' },
      doubled: { $$secret: 'ALSO_NOT' },
    };
    const row = serializeInput(svc(anySchema), 'web', binding, {});
    // On the wire the user keys carry one extra "$" — only the framework's
    // own pointer keeps the single-"$" marker.
    expect(row?.value).toContain('"$$secret":"NOT_A_POINTER"');
    expect(row?.value).toContain('"$$$secret":"ALSO_NOT"');
    expect(row?.value).toContain('"real":{"$secret":"REAL_SECRET"}');

    const node = svc(anySchema);
    const value = await withEnv(
      { [inputKey('')]: row?.value ?? '', REAL_SECRET: 'sk_live_real' },
      () => readInput(node, '') as Record<string, unknown>,
    );
    // Read back: the pointer became a box; the user keys came back verbatim.
    expect((value['real'] as SecretBox<string>).expose()).toBe('sk_live_real');
    expect(value['forged']).toEqual({ $secret: 'NOT_A_POINTER' });
    expect(value['doubled']).toEqual({ $$secret: 'ALSO_NOT' });
  });
});

describe('readInput — the boot half', () => {
  const conditional = type({ stripeEnabled: 'false' }).or({
    stripeEnabled: 'true',
    stripeKey: secretString(),
  });

  test('deploy → boot round trip: document → boxes → validated object', async () => {
    const node = svc(conditional);
    const row = serializeInput(
      node,
      'web',
      { stripeEnabled: true, stripeKey: envSecret('STRIPE_SECRET_KEY') },
      {},
    );
    const value = await withEnv(
      { [inputKey('')]: row?.value ?? '', STRIPE_SECRET_KEY: 'sk_live_boot' },
      () => readInput(node, '') as { stripeEnabled: boolean; stripeKey?: SecretBox<unknown> },
    );
    expect(value.stripeEnabled).toBe(true);
    expect(value.stripeKey?.expose()).toBe('sk_live_boot');
    expect(String(value.stripeKey)).toBe('[REDACTED]');
  });

  test('an unprovisioned platform var behind a pointer is a loud boot failure naming both keys', async () => {
    const node = svc(conditional);
    await withEnv(
      { [inputKey('')]: '{"stripeEnabled":true,"stripeKey":{"$secret":"MISSING_SECRET_VAR"}}' },
      () => {
        expect(() => readInput(node, '')).toThrow(/COMPOSER_INPUT → MISSING_SECRET_VAR/);
      },
    );
  });

  test('a boot document failing validation is loud, naming the row', async () => {
    const node = svc(conditional);
    await withEnv({ [inputKey('')]: '{"stripeEnabled":true}' }, () => {
      expect(() => readInput(node, '')).toThrow(/invalid input document \(env COMPOSER_INPUT\)/);
    });
  });

  test('a malformed document row fails naming the env key, not a bare SyntaxError', async () => {
    const node = svc(conditional);
    await withEnv({ [inputKey('')]: '{not valid json' }, () => {
      expect(() => readInput(node, '')).toThrow(
        /input document is not valid JSON \(env COMPOSER_INPUT\)/,
      );
    });
  });
});
