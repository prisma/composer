/**
 * The input channel (ADR-0042): the deploy-side binding walk
 * (`resolveInputBinding`), the one-document serialization (`serializeInput`),
 * and the boot-side read (`readInput`) — classification, absence, `$secret`
 * escaping, validation with pointers in place, and the round trip.
 */
import { describe, expect, test } from 'bun:test';
import {
  isSecretPointer,
  isSecretString,
  Load,
  module,
  SecretBox,
  type ServiceNode,
  service,
} from '@internal/core';
import { field, secretString } from '@internal/foundation/arktype';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { envParam, generatedParam, serviceOrigin } from '../param.ts';
import { envSecret } from '../secret.ts';
import {
  assertDistinctPointerNames,
  inputKey,
  readInput,
  resolveInputBinding,
  serializeInput,
} from '../serializer.ts';

/** An ArkType copy of `value`: a transform elsewhere in the schema makes ArkType copy its whole input. */
const copyOf = <T>(value: T): T => {
  const out = type({ value: 'object', n: 'string.integer.parse' })({ value, n: '1' });
  if (out instanceof type.errors) throw new Error(out.summary);
  return out.value as T;
};

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
    const secretly = envSecret('STRIPE_SECRET_KEY');
    const { resolved, absent } = resolveInputBinding(
      {
        plain: 'value',
        count: 3,
        enabled: true,
        nothing: null,
        list: ['a', 'b'],
        nested: {
          fromShell: envParam('SHELL_VALUE'),
          secretly,
        },
      },
      '',
      { env: { SHELL_VALUE: 'from-the-shell' } },
    );

    const out = resolved as Record<string, unknown>;
    expect(out['plain']).toBe('value');
    expect(out['count']).toBe(3);
    expect(out['enabled']).toBe(true);
    expect(out['nothing']).toBeNull();
    expect(out['list']).toEqual(['a', 'b']);
    const nested = out['nested'] as Record<string, unknown>;
    expect(nested['fromShell']).toBe('from-the-shell');
    // The secret leaf stays in place as its pointer.
    expect(nested['secretly']).toBe(secretly);
    expect(absent).toEqual([]);
  });

  test('an unset deploy-shell var omits the key; an empty one too — the schema arbitrates absence', () => {
    const { resolved, absent } = resolveInputBinding(
      { unset: envParam('NOT_SET_ANYWHERE_XYZ'), empty: envParam('EMPTY_VALUE'), kept: 'yes' },
      '',
      { env: { EMPTY_VALUE: '' } },
    );
    expect(resolved).toEqual({ kept: 'yes' });
    expect(absent).toEqual(['unset → NOT_SET_ANYWHERE_XYZ', 'empty → EMPTY_VALUE']);
  });

  test('an env-bound array element that resolves absent is a loud error — positions cannot be omitted', () => {
    expect(() =>
      resolveInputBinding({ list: ['a', envParam('NOT_SET_ANYWHERE_XYZ')] }, '', { env: {} }),
    ).toThrow(/array element/);
  });

  test('a raw SecretBox (a secret VALUE) in the binding is rejected loudly', () => {
    expect(() =>
      resolveInputBinding({ key: new SecretBox('sk_live_oops') }, '', { env: {} }),
    ).toThrow(/never belongs in a binding/);
  });
});

describe('resolveInputBinding — envParam() reads the config pool', () => {
  test('an envParam() leaf reads the env it is given', async () => {
    const row = await withEnv({ G: 'shell' }, () =>
      serializeInput(
        svc(type({ greeting: 'string' })),
        'web',
        { greeting: envParam('G') },
        { env: { G: 'pool' } },
      ),
    );

    expect(JSON.parse(row?.value ?? 'null')).toEqual({ greeting: 'pool' });
  });

  test('an envParam() leaf whose value is not text fails naming the key and its kind', () => {
    expect(() =>
      resolveInputBinding({ nested: { greeting: envParam('G') } }, 'web', { env: { G: 4 } }),
    ).toThrow(
      'input binding key "nested.greeting" is bound to envParam(\'G\'), but the config pool holds a number at "G", not text. envParam() reads text; to pass other data, declare it in the root module\'s input.',
    );
    expect(() => resolveInputBinding(envParam('G'), 'web', { env: { G: ['x'] } })).toThrow(
      'input binding is bound to envParam(\'G\'), but the config pool holds an array at "G", not text.',
    );
  });
});

describe('serializeInput — validate with pointers in place, serialize the validated output', () => {
  const conditional = type({ stripeEnabled: 'false' }).or({
    stripeEnabled: 'true',
    stripeKey: secretString(),
  });

  test('discriminated-union conditionality passes with the satisfied arm (secret pointers in place)', () => {
    const row = serializeInput(
      svc(conditional),
      'web',
      { stripeEnabled: true, stripeKey: envSecret('STRIPE_SECRET_KEY') },
      { env: {} },
    );
    expect(row?.key).toBe('COMPOSER_WEB_INPUT');
    expect(JSON.parse(row?.value ?? '')).toEqual({
      stripeEnabled: true,
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
    });
  });

  test('without absent secrets (every deploy), an unset secret is still written as a pointer', () => {
    const row = serializeInput(
      svc(conditional),
      'web',
      { stripeEnabled: true, stripeKey: envSecret('STRIPE_SECRET_KEY') },
      { env: {} },
    );
    expect(JSON.parse(row?.value ?? '')).toEqual({
      stripeEnabled: true,
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
    });
  });

  test('a secret named absent is left out of the document', () => {
    const optional = type({ 'stripeKey?': secretString() });
    const row = serializeInput(
      svc(optional),
      'web',
      { stripeKey: envSecret('STRIPE_SECRET_KEY') },
      { env: {}, absentSecrets: new Set(['STRIPE_SECRET_KEY']) },
    );
    expect(JSON.parse(row?.value ?? '')).toEqual({});
  });

  test('the off arm needs no secret — the key is simply not bound', () => {
    const row = serializeInput(svc(conditional), 'web', { stripeEnabled: false }, { env: {} });
    expect(JSON.parse(row?.value ?? '')).toEqual({ stripeEnabled: false });
  });

  test('an async schema fails at deploy with an error naming the service', () => {
    const asyncSchema: StandardSchemaV1 = {
      '~standard': { version: 1, vendor: 'test', validate: async (value) => ({ value }) },
    };
    expect(() => serializeInput(svc(asyncSchema), 'web', {}, { env: {} })).toThrow(
      /^invalid input for service "web": config param schema validation must be synchronous/,
    );
  });

  test('the on arm with a MISSING secret fails at deploy with the schema library’s own error', () => {
    expect(() =>
      serializeInput(svc(conditional), 'web', { stripeEnabled: true }, { env: {} }),
    ).toThrow(/invalid input for service "web"/);
  });

  test('misclassification — a literal where the schema wants a SecretString — fails at deploy, with the ADR-0042 note', () => {
    const attempt = () =>
      serializeInput(
        svc(conditional),
        'web',
        { stripeEnabled: true, stripeKey: 'sk_live_in_plain_config' },
        { env: {} },
      );
    expect(attempt).toThrow(/invalid input for service "web"/);
    expect(attempt).toThrow(/secretness, or the schema refines on secret content/);
  });

  test('envSecret where the schema wants a plain string fails the same way', () => {
    const schema = type({ url: 'string' });
    expect(() =>
      serializeInput(svc(schema), 'web', { url: envSecret('NOT_ACTUALLY_SECRET') }, { env: {} }),
    ).toThrow(/invalid input for service "web"/);
  });

  test('the document is DEFAULTS-APPLIED — the validated output is serialized, not the raw binding', () => {
    const schema = type({ greeting: 'string', 'retries?': 'number' }).pipe((v) => ({
      retries: 1,
      ...v,
    }));
    const row = serializeInput(svc(schema), 'web', { greeting: 'hello' }, { env: {} });
    expect(JSON.parse(row?.value ?? '')).toEqual({ greeting: 'hello', retries: 1 });
  });

  test('secret values never appear in the document, even when the deploy shell holds them', () => {
    const row = serializeInput(
      svc(conditional),
      'web',
      { stripeEnabled: true, stripeKey: envSecret('STRIPE_SECRET_KEY') },
      { env: { STRIPE_SECRET_KEY: 'sk_live_should_not_leak' } },
    );
    expect(row?.value).not.toContain('sk_live');
    expect(row?.value).toContain('"$secret":"STRIPE_SECRET_KEY"');
  });

  test('a schema that mints its own SecretBox (a default) is rejected — no platform var stands behind it', () => {
    const schema = type({ greeting: 'string' }).pipe((v) => ({
      ...v,
      injected: new SecretBox('made-up'),
    }));
    expect(() => serializeInput(svc(schema), 'web', { greeting: 'hi' }, { env: {} })).toThrow(
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
    expect(serializeInput(plain, 'plain', undefined, { env: {} })).toBeUndefined();
    expect(() => serializeInput(plain, 'plain', {}, { env: {} })).toThrow(
      /declares no input schema/,
    );
  });

  test('a declared schema with no recorded binding is a loud invariant error', () => {
    expect(() => serializeInput(svc(conditional), 'web', undefined, { env: {} })).toThrow(
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
    const row = serializeInput(svc(anySchema), 'web', binding, { env: {} });
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
      { env: {} },
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

describe('resolveInputBinding — generated leaves (ADR-0041)', () => {
  test('a redacted generated leaf stays in place as its pointer and records the generated list', () => {
    const secret = generatedParam();
    const { resolved, generated } = resolveInputBinding({ secret }, 'web', { env: {} });
    expect((resolved as Record<string, unknown>)['secret']).toBe(secret);
    expect(generated).toEqual([
      { varName: 'COMPOSER_WEB_SECRET_GENERATED', bytes: 32, redacted: true, path: 'secret' },
    ]);
  });

  test('a non-redacted generated leaf stays in place as its pointer', () => {
    const token = generatedParam({ redacted: false, bytes: 16 });
    const { resolved, generated } = resolveInputBinding({ token }, 'web', { env: {} });
    expect((resolved as Record<string, unknown>)['token']).toBe(token);
    expect(generated).toEqual([
      { varName: 'COMPOSER_WEB_TOKEN_GENERATED', bytes: 16, redacted: false, path: 'token' },
    ]);
  });

  test('the var name is address- and path-scoped, even for a nested leaf', () => {
    const { generated } = resolveInputBinding({ auth: { signing: generatedParam() } }, 'api', {
      env: {},
    });
    expect(generated[0]?.varName).toBe('COMPOSER_API_AUTH_SIGNING_GENERATED');
    expect(generated[0]?.path).toBe('auth.signing');
  });
});

describe('serializeInput — generated leaves become $generated pointers (ADR-0041)', () => {
  test('a redacted leaf (secretString schema) serializes to a $generated pointer + records the leaf', () => {
    const row = serializeInput(
      svc(type({ secret: secretString() })),
      'web',
      { secret: generatedParam() },
      { env: {} },
    );
    expect(JSON.parse(row?.value ?? '')).toEqual({
      secret: { $generated: 'COMPOSER_WEB_SECRET_GENERATED', redacted: true },
    });
    expect(row?.generated).toEqual([
      { varName: 'COMPOSER_WEB_SECRET_GENERATED', bytes: 32, redacted: true, path: 'secret' },
    ]);
  });

  test('a non-redacted leaf (wrapped string field) also serializes to a $generated pointer', () => {
    const row = serializeInput(
      svc(type({ token: field(type('string')) })),
      'web',
      { token: generatedParam({ redacted: false, bytes: 16 }) },
      { env: {} },
    );
    expect(JSON.parse(row?.value ?? '')).toEqual({
      token: { $generated: 'COMPOSER_WEB_TOKEN_GENERATED', redacted: false },
    });
    expect(row?.generated[0]?.redacted).toBe(false);
  });

  test('the pointer prints; the value lives in state, never in the document', () => {
    const row = serializeInput(
      svc(type({ secret: secretString() })),
      'web',
      { secret: generatedParam() },
      { env: {} },
    );
    expect(row?.value).toContain('"$generated":"COMPOSER_WEB_SECRET_GENERATED"');
  });

  test('deploy → boot round trip: a redacted generated leaf hydrates to a box exposing the provisioned value', async () => {
    const node = svc(type({ secret: secretString() }));
    const row = serializeInput(node, 'web', { secret: generatedParam() }, { env: {} });
    const value = await withEnv(
      { [inputKey('')]: row?.value ?? '', COMPOSER_WEB_SECRET_GENERATED: 'generated-value-xyz' },
      () => readInput(node, '') as { secret: SecretBox<string> },
    );
    expect(value.secret.expose()).toBe('generated-value-xyz');
    expect(String(value.secret)).toBe('[REDACTED]');
  });

  test('deploy → boot round trip: a non-redacted generated leaf hydrates to a PLAIN STRING, not a box', async () => {
    const node = svc(type({ token: field(type('string')) }));
    const row = serializeInput(
      node,
      'web',
      { token: generatedParam({ redacted: false }) },
      { env: {} },
    );
    const value = await withEnv(
      { [inputKey('')]: row?.value ?? '', COMPOSER_WEB_TOKEN_GENERATED: 'plain-generated-value' },
      () => readInput(node, '') as { token: string },
    );
    // The facet on the pointer drives this: a box here would fail the wrapped
    // `string` schema field — the exact case uniform-boxing would have broken.
    expect(value.token).toBe('plain-generated-value');
    expect(value.token).not.toBeInstanceOf(SecretBox);
  });

  test('a missing generated var at boot is a hard error naming the var and the disagreement', async () => {
    const node = svc(type({ secret: secretString() }));
    await withEnv(
      {
        [inputKey('')]: '{"secret":{"$generated":"COMPOSER_WEB_SECRET_GENERATED","redacted":true}}',
      },
      () => {
        expect(() => readInput(node, '')).toThrow(/COMPOSER_INPUT → COMPOSER_WEB_SECRET_GENERATED/);
        expect(() => readInput(node, '')).toThrow(/deploy and the running service disagree/);
      },
    );
  });
});

describe('the reserved $generated key — user data round-trips (ADR-0041)', () => {
  const anySchema: StandardSchemaV1<unknown, unknown> = {
    '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
  };

  test('a user object containing "$generated" (and "$$generated") is escaped on write and unescaped on read', async () => {
    const binding = {
      real: generatedParam(),
      forged: { $generated: 'NOT_A_POINTER' },
      doubled: { $$generated: 'ALSO_NOT' },
    };
    const row = serializeInput(svc(anySchema), 'web', binding, { env: {} });
    // On the wire the user keys carry one extra "$"; only the framework's own
    // pointer keeps the single-"$" marker.
    expect(row?.value).toContain('"$$generated":"NOT_A_POINTER"');
    expect(row?.value).toContain('"$$$generated":"ALSO_NOT"');
    expect(row?.value).toContain(
      '"real":{"$generated":"COMPOSER_WEB_REAL_GENERATED","redacted":true}',
    );

    const node = svc(anySchema);
    const value = await withEnv(
      { [inputKey('')]: row?.value ?? '', COMPOSER_WEB_REAL_GENERATED: 'gen-real' },
      () => readInput(node, '') as Record<string, unknown>,
    );
    expect((value['real'] as SecretBox<string>).expose()).toBe('gen-real');
    expect(value['forged']).toEqual({ $generated: 'NOT_A_POINTER' });
    expect(value['doubled']).toEqual({ $$generated: 'ALSO_NOT' });
  });
});

describe('the pointer-name collision guard (ADR-0041, F02)', () => {
  test('two secret leaves binding the same platform name collide (secret/secret)', () => {
    expect(() =>
      resolveInputBinding({ a: envSecret('SHARED'), b: envSecret('SHARED') }, 'web', { env: {} }),
    ).toThrow(/both resolve to the platform variable "SHARED"/);
  });

  test('two secret leaves whose names differ only in case collide (case-collision)', () => {
    expect(() =>
      resolveInputBinding({ a: envSecret('token'), b: envSecret('TOKEN') }, 'web', { env: {} }),
    ).toThrow(/both resolve to the platform variable "TOKEN"/);
  });

  test('two generated leaves whose paths normalize to the same var collide (generated/generated)', () => {
    expect(() =>
      resolveInputBinding({ token: generatedParam(), Token: generatedParam() }, 'web', { env: {} }),
    ).toThrow(/both resolve to the platform variable "COMPOSER_WEB_TOKEN_GENERATED"/);
  });

  test('secret and generated names are checked in one pool (secret-vs-generated)', () => {
    // A secret name can never be COMPOSER_-prefixed via envSecret, so this
    // cross-namespace collision is exercised on the guard directly: it is one
    // general pool, not a per-marker special case.
    expect(() =>
      assertDistinctPointerNames(
        [
          { path: 'fromSecret', varName: 'COMPOSER_WEB_SECRET_GENERATED' },
          { path: 'fromGenerated', varName: 'COMPOSER_WEB_SECRET_GENERATED' },
        ],
        'web',
      ),
    ).toThrow(/input paths "fromSecret" and "fromGenerated"/);
  });

  test('a secret leaf and a generated leaf with distinct names do NOT collide', () => {
    const sec = envSecret('MY_SECRET');
    const { resolved, generated } = resolveInputBinding({ sec, gen: generatedParam() }, 'web', {
      env: {},
    });
    expect(generated).toHaveLength(1);
    expect((resolved as Record<string, unknown>)['sec']).toBe(sec);
  });
});

describe('a secret forwarded through a module input', () => {
  test("a secret forwarded through a module's input serializes to its $secret pointer", () => {
    const email = module(
      'email',
      { input: type({ from: 'string', key: secretString() }) },
      ({ input, provision }) => {
        provision(svc(type({ from: 'string', key: secretString() })), {
          input: { from: input.from, key: input.key },
        });
      },
    );
    const graph = Load(
      module('shop', ({ provision }) => {
        provision(email, { input: { from: 'shop@example.com', key: envSecret('EMAIL_KEY') } });
      }),
    );
    const address = graph.inputBindings[0]?.serviceAddress ?? '';
    const node = graph.nodes.find((entry) => entry.id === address)?.node as ServiceNode;

    const row = serializeInput(node, address, graph.inputBindings[0]?.binding, { env: {} });

    expect(JSON.parse(row?.value ?? '')).toEqual({
      from: 'shop@example.com',
      key: { $secret: 'EMAIL_KEY' },
    });
  });
});

describe('an ArkType schema with a morph', () => {
  test('a secret field beside an ArkType morph is refused at deploy, naming the copied secret', () => {
    expect(() =>
      serializeInput(
        svc(type({ key: secretString(), name: 'string.trim' })),
        'web',
        { key: envSecret('KEY'), name: ' shop ' },
        { env: {} },
      ),
    ).toThrow(
      'input key "key" of service "web" validated to a copy of its secret, and the copy has lost ' +
        "the secret's value: the schema copies its input (for example an ArkType morph elsewhere " +
        'in the schema), so the service would fail to read the secret at boot. Move the transform ' +
        'into the service code, or keep the schema free of transforms.',
    );
  });
});

describe('a source forwarded through a module input', () => {
  const forwarded = (schema: StandardSchemaV1, binding: Record<string, unknown>) => {
    const login = module('login', { input: schema }, ({ input, provision }) => {
      provision(svc(schema), { input: input as never });
    });
    const graph = Load(
      module('shop', ({ provision }) => {
        provision(login, { input: binding as never });
      }),
    );
    const node = graph.nodes.find((entry) => entry.id === 'shop.login.web')?.node as ServiceNode;
    return serializeInput(node, 'shop.login.web', graph.inputBindings[0]?.binding, { env: {} });
  };

  test("serviceOrigin() forwarded through a module's input serializes to its origin pointer", () => {
    const row = forwarded(type({ baseUrl: field(type('string')) }), {
      baseUrl: serviceOrigin('shop.web'),
    });

    expect(JSON.parse(row?.value ?? '')).toEqual({
      baseUrl: { $generated: 'COMPOSER_SHOP_LOGIN_WEB_BASEURL_GENERATED', redacted: false },
    });
    expect(row?.generated[0]?.origin).toBe('shop.web');
  });

  test("a redacted generatedParam() forwarded through a module's secretString() field serializes to its generated pointer", () => {
    const row = forwarded(type({ secret: secretString() }), { secret: generatedParam() });

    expect(JSON.parse(row?.value ?? '')).toEqual({
      secret: { $generated: 'COMPOSER_SHOP_LOGIN_WEB_SECRET_GENERATED', redacted: true },
    });
  });
});

describe('an ArkType copy of a source', () => {
  test('a copy of envSecret() serializes to its $secret pointer', () => {
    const row = serializeInput(
      svc(type({ key: secretString() })),
      'web',
      { key: copyOf(envSecret('STRIPE_SECRET_KEY')) },
      { env: {} },
    );

    expect(JSON.parse(row?.value ?? '')).toEqual({ key: { $secret: 'STRIPE_SECRET_KEY' } });
  });

  test('a copy of serviceOrigin() serializes to its $generated pointer', () => {
    const row = serializeInput(
      svc(type({ base: field(type('string')) })),
      'web',
      { base: copyOf(serviceOrigin('shop.web')) },
      { env: {} },
    );

    expect(JSON.parse(row?.value ?? '')).toEqual({
      base: { $generated: 'COMPOSER_WEB_BASE_GENERATED', redacted: false },
    });
    expect(row?.generated[0]?.origin).toBe('shop.web');
  });

  test('a copy of a redacted generatedParam() serializes to its $generated pointer', () => {
    const row = serializeInput(
      svc(type({ secret: secretString() })),
      'web',
      { secret: copyOf(generatedParam()) },
      { env: {} },
    );

    expect(JSON.parse(row?.value ?? '')).toEqual({
      secret: { $generated: 'COMPOSER_WEB_SECRET_GENERATED', redacted: true },
    });
  });
});

describe('schemas see pointers at deploy', () => {
  const recording = (seen: unknown[]): StandardSchemaV1<unknown, unknown> => ({
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => {
        seen.push(value);
        return { value };
      },
    },
  });
  const returning = (output: (value: Record<string, unknown>) => unknown): StandardSchemaV1 => ({
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => ({ value: output(value as Record<string, unknown>) }),
    },
  });

  test("a plain field bound to serviceOrigin() fails at deploy with the plain field's message", () => {
    expect(() =>
      serializeInput(
        svc(type({ base: 'string' })),
        'web',
        { base: serviceOrigin('shop.web') },
        {
          env: {},
        },
      ),
    ).toThrow(
      'invalid input for service "web": config param validation failed: base must be a string (was an object)',
    );
  });

  test('envSecret() bound to a wrapped text field fails at deploy', () => {
    expect(() =>
      serializeInput(
        svc(type({ from: field(type('string')) })),
        'web',
        { from: envSecret('KEY') },
        {
          env: {},
        },
      ),
    ).toThrow(
      'invalid input for service "web": config param validation failed: from must be a string (was an object)',
    );
  });

  test('a plain generatedParam() bound to a secretString() field fails, saying it is not a secret', () => {
    expect(() =>
      serializeInput(
        svc(type({ secret: secretString() })),
        'web',
        { secret: generatedParam({ redacted: false }) },
        { env: {} },
      ),
    ).toThrow(
      'invalid input for service "web": config param validation failed: secret must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)',
    );
  });

  test('a pointer the schema copies is still written as its marker', () => {
    const row = serializeInput(
      svc(type({ base: field(type('string')), n: 'string.integer.parse' })),
      'web',
      { base: serviceOrigin('shop.web'), n: '1' },
      { env: {} },
    );

    expect(JSON.parse(row?.value ?? '')).toEqual({
      base: { $generated: 'COMPOSER_WEB_BASE_GENERATED', redacted: false },
      n: 1,
    });
  });

  test('a service whose binding holds no secret pointer is checked once', () => {
    const seen: unknown[] = [];

    serializeInput(
      svc(recording(seen)),
      'web',
      { greeting: 'hi', base: serviceOrigin('shop.web') },
      { env: {} },
    );

    expect(seen).toHaveLength(1);
  });

  test('a service whose binding holds a secret pointer is checked again with a stand-in box, which never reaches the document', () => {
    const seen: unknown[] = [];
    const key = envSecret('KEY');

    const row = serializeInput(
      svc(recording(seen)),
      'web',
      { key, token: generatedParam() },
      {
        env: {},
      },
    );

    expect(seen).toHaveLength(2);
    const [first, second] = seen as Record<string, unknown>[];
    expect(first?.['key']).toBe(key);
    expect(isSecretPointer(first?.['token'])).toBe(true);
    expect(isSecretString(second?.['key'])).toBe(true);
    expect(isSecretString(second?.['token'])).toBe(true);
    expect(row?.value).not.toContain('composer-stand-in-not-a-secret');
    expect(JSON.parse(row?.value ?? '')).toEqual({
      key: { $secret: 'KEY' },
      token: { $generated: 'COMPOSER_WEB_TOKEN_GENERATED', redacted: true },
    });
  });

  test('an ArkType schema that deletes undeclared keys loses a secret box, and the deploy refuses it naming the field', () => {
    expect(() =>
      serializeInput(
        svc(type({ '+': 'delete', key: secretString() })),
        'web',
        { key: envSecret('KEY') },
        {
          env: {},
        },
      ),
    ).toThrow('input key "key" of service "web" validated to a copy of its secret');
  });

  test('a wrapped transforming field beside a secret makes ArkType copy the input, and the deploy refuses it', () => {
    expect(() =>
      serializeInput(
        svc(type({ key: secretString(), port: field(type('string.integer.parse')) })),
        'web',
        { key: envSecret('KEY'), port: '4' },
        { env: {} },
      ),
    ).toThrow('input key "key" of service "web" validated to a copy of its secret');
  });

  test('a redacted generatedParam() copied with the input is refused the same way', () => {
    expect(() =>
      serializeInput(
        svc(type({ secret: secretString(), name: 'string.trim' })),
        'web',
        { secret: generatedParam(), name: ' shop ' },
        { env: {} },
      ),
    ).toThrow('input key "secret" of service "web" validated to a copy of its secret');
  });

  test("a schema that accepts a secret's pointer but refuses a box in its place is refused", () => {
    const pointerOnly: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) =>
          isSecretPointer((value as Record<string, unknown>)['key'])
            ? { value }
            : { issues: [{ message: 'key must be a pointer' }] },
      },
    };

    expect(() =>
      serializeInput(svc(pointerOnly), 'web', { key: envSecret('KEY') }, { env: {} }),
    ).toThrow(
      'invalid input for service "web": the schema accepts each secret\'s pointer but refuses a secret box in its place: key must be a pointer',
    );
  });

  test('a schema that replaces a field bound to a value known only at boot is refused', () => {
    expect(() =>
      serializeInput(
        svc(returning(() => ({ base: 'x' }))),
        'web',
        { base: serviceOrigin('shop.web') },
        {
          env: {},
        },
      ),
    ).toThrow(
      'input key "base" of service "web" is bound to a value known only at boot, but the schema replaced it. A schema may check such a field, never move or transform it.',
    );
  });

  test('a schema that moves a pointer to another key is refused', () => {
    expect(() =>
      serializeInput(
        svc(returning((value) => ({ other: value['base'] }))),
        'web',
        { base: serviceOrigin('shop.web') },
        { env: {} },
      ),
    ).toThrow(
      'input key "other" of service "web" validated to a value known only at boot that its binding did not put there: the schema moved it. A schema may check such a field, never move or transform it.',
    );
  });

  test('a schema that mints its own secret box beside a secret pointer is refused for minting, not for copying', () => {
    const minting = svc(returning((value) => ({ ...value, other: new SecretBox('minted') })));
    expect(() => serializeInput(minting, 'web', { key: envSecret('KEY') }, { env: {} })).toThrow(
      'input key "other" of service "web" validated to a SecretString the binding did not supply',
    );
  });
});
