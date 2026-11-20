import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDocument } from '@internal/input-document';
import * as Redacted from 'effect/Redacted';
import { deploymentRows, devServerRows, materializeEnv } from '../compute.ts';
import { envStore } from '../dev-store.ts';

const NAMES = ['STRIPE_SECRET_KEY', 'APP_ORIGIN'];
let devDir: string;

beforeEach(() => {
  devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-materialize-env-'));
});

afterEach(() => {
  fs.rmSync(devDir, { recursive: true, force: true });
  for (const name of NAMES) delete process.env[name];
});

async function writeRows(rows: Record<string, string>): Promise<void> {
  await envStore(devDir).update(() => rows);
}

test('each service gets the current values of only the variables its own rows point at', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({
      stripeKey: { $platform: { name: 'STRIPE_SECRET_KEY', secret: true } },
      nested: [{ origin: { $platform: { name: 'APP_ORIGIN', secret: true } } }],
    }),
    COMPOSER_MAILER_INPUT: JSON.stringify({
      key: { $platform: { name: 'MAILER_KEY', secret: true } },
    }),
  });
  const secrets = {
    STRIPE_SECRET_KEY: 'sk_test_1',
    APP_ORIGIN: 'http://localhost:3000',
    MAILER_KEY: 'mk_1',
    UNRELATED_SECRET: 'not for any service',
  };

  const billing = materializeEnv(
    await devServerRows(devDir, 'billing'),
    'billing',
    4000,
    {},
    secrets,
  );
  const mailer = materializeEnv(await devServerRows(devDir, 'mailer'), 'mailer', 4001, {}, secrets);

  expect(billing['STRIPE_SECRET_KEY']).toBe('sk_test_1');
  expect(billing['APP_ORIGIN']).toBe('http://localhost:3000');
  expect(billing['MAILER_KEY']).toBeUndefined();
  expect(mailer['MAILER_KEY']).toBe('mk_1');
  expect(mailer['STRIPE_SECRET_KEY']).toBeUndefined();
  expect(billing['UNRELATED_SECRET']).toBeUndefined();
});

test('a value changed in the app secrets reaches the service on the next materialization', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({
      stripeKey: { $platform: { name: 'STRIPE_SECRET_KEY', secret: true } },
    }),
  });
  materializeEnv(
    await devServerRows(devDir, 'billing'),
    'billing',
    4000,
    {},
    { STRIPE_SECRET_KEY: 'sk_test_old' },
  );

  const billing = materializeEnv(
    await devServerRows(devDir, 'billing'),
    'billing',
    4000,
    {},
    { STRIPE_SECRET_KEY: 'sk_test_new' },
  );

  expect(billing['STRIPE_SECRET_KEY']).toBe('sk_test_new');
});

test('a platform variable that is unset or empty is not given to the service', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({
      stripeKey: { $platform: { name: 'STRIPE_SECRET_KEY', secret: true } },
      mailer: { $platform: { name: 'MAILER_KEY', secret: true } },
    }),
  });

  const billing = materializeEnv(
    await devServerRows(devDir, 'billing'),
    'billing',
    4000,
    {},
    { MAILER_KEY: '' },
  );

  expect('STRIPE_SECRET_KEY' in billing).toBe(false);
  expect('MAILER_KEY' in billing).toBe(false);
});

test('a local deployment takes its secrets from the app secrets and its plain platform variables from their texts, never the shell', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({
      stripeKey: { $platform: { name: 'STRIPE_SECRET_KEY', secret: true } },
      origin: { $platform: { name: 'APP_ORIGIN' } },
    }),
  });
  process.env['STRIPE_SECRET_KEY'] = 'shell';
  process.env['APP_ORIGIN'] = 'shell';

  const billing = materializeEnv(
    await devServerRows(devDir, 'billing'),
    'billing',
    4000,
    { APP_ORIGIN: 'https://pool.example' },
    { STRIPE_SECRET_KEY: 'sk_pool' },
  );

  expect(billing['STRIPE_SECRET_KEY']).toBe('sk_pool');
  expect(billing['APP_ORIGIN']).toBe('https://pool.example');
});

test('a plain platform variable whose value is not text is left out', async () => {
  await writeRows({
    COMPOSER_WEB_INPUT: JSON.stringify({ origin: { $platform: { name: 'APP_ORIGIN' } } }),
  });

  const web = materializeEnv(
    await devServerRows(devDir, 'web'),
    'web',
    4000,
    { APP_ORIGIN: { host: 'x' } },
    {},
  );

  expect('APP_ORIGIN' in web).toBe(false);
});

test('a dev server reads a typed variable from its env.json document, schema included, and decodes the same text', async () => {
  const document = JSON.stringify({
    port: { $platform: { name: 'SMTP_PORT', schema: { type: 'number' } } },
  });
  await writeRows({ COMPOSER_MAILER_INPUT: document });

  const mailer = materializeEnv(
    await devServerRows(devDir, 'mailer'),
    'mailer',
    4000,
    { SMTP_PORT: '587' },
    {},
  );

  expect(mailer['SMTP_PORT']).toBe('587');
  const input = mailer['COMPOSER_MAILER_INPUT'] ?? '';
  expect(
    readDocument(JSON.parse(input), { variable: (name) => mailer[name], secret: (text) => text })
      .value,
  ).toEqual({ port: 587 });
});

test("a service that runs its artifact gets a typed variable's text, and decodes it by the artifact document's schema", async () => {
  const inputDocument = {
    port: { $platform: { name: 'SMTP_PORT', schema: { type: 'number' } } },
  };

  const mailer = materializeEnv({}, 'mailer', 4000, { SMTP_PORT: '587' }, {}, { inputDocument });

  expect(mailer['SMTP_PORT']).toBe('587');
  expect('COMPOSER_MAILER_INPUT' in mailer).toBe(false);
  expect(
    readDocument(inputDocument, { variable: (name) => mailer[name], secret: (text) => text }).value,
  ).toEqual({ port: 587 });
});

test("a service gets the variables its artifact's input document names, and not the document itself", async () => {
  const inputDocument = {
    stripeKey: { $platform: { name: 'STRIPE_SECRET_KEY', secret: true } },
    origin: { $platform: { name: 'APP_ORIGIN' } },
  };

  const web = materializeEnv(
    {},
    'web',
    4000,
    { APP_ORIGIN: 'http://localhost:3000', UNREAD_NAME: 'not read' },
    { STRIPE_SECRET_KEY: 'sk_test_1', MAILER_KEY: 'mk_1' },
    { inputDocument },
  );

  expect(web['STRIPE_SECRET_KEY']).toBe('sk_test_1');
  expect(web['APP_ORIGIN']).toBe('http://localhost:3000');
  expect('MAILER_KEY' in web).toBe(false);
  expect('UNREAD_NAME' in web).toBe(false);
  expect('COMPOSER_WEB_INPUT' in web).toBe(false);
});

test('a deployment gives its service the keys in its variables, and leaves out a key sent as null', () => {
  const rows = deploymentRows({
    COMPOSER_WEB_DB_URL: Redacted.make('postgres://local'),
    COMPOSER_WEB_STREAMS_API_KEY: null,
  });

  expect(rows).toEqual({ COMPOSER_WEB_DB_URL: 'postgres://local' });
});

test("a service that runs its artifact gets its deployment's keys, the emulator's port over its own, and not env.json", async () => {
  await writeRows({ COMPOSER_WEB_STALE: 'a row an older Composer wrote' });
  const inputDocument = { stripeKey: { $platform: { name: 'STRIPE_SECRET_KEY', secret: true } } };

  const web = materializeEnv(
    deploymentRows({
      COMPOSER_WEB_PORT: Redacted.make('3000'),
      COMPOSER_WEB_DB_URL: Redacted.make('postgres://local'),
      COMPOSER_WEB_STREAMS_API_KEY: null,
    }),
    'web',
    4000,
    {},
    { STRIPE_SECRET_KEY: 'sk_test_1' },
    { inputDocument },
  );

  expect(web['COMPOSER_WEB_PORT']).toBe('4000');
  expect(web['COMPOSER_WEB_DB_URL']).toBe('postgres://local');
  expect(web['STRIPE_SECRET_KEY']).toBe('sk_test_1');
  expect('COMPOSER_WEB_STREAMS_API_KEY' in web).toBe(false);
  expect('COMPOSER_WEB_STALE' in web).toBe(false);
});
