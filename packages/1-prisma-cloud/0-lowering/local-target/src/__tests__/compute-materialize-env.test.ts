import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigPools } from '@internal/core/config';
import { materializeEnv } from '../compute.ts';
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

const pools = (
  secrets: Record<string, string>,
  config: Record<string, unknown> = {},
): ConfigPools => ({ config, secrets });

test('each service gets the current values of only the variables its own rows point at', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
      nested: [{ origin: { $secret: 'APP_ORIGIN' } }],
    }),
    COMPOSER_MAILER_INPUT: JSON.stringify({ key: { $secret: 'MAILER_KEY' } }),
  });
  const current = pools({
    STRIPE_SECRET_KEY: 'sk_test_1',
    APP_ORIGIN: 'http://localhost:3000',
    MAILER_KEY: 'mk_1',
    UNRELATED_SECRET: 'not for any service',
  });

  const billing = await materializeEnv(devDir, 'billing', 4000, current);
  const mailer = await materializeEnv(devDir, 'mailer', 4001, current);

  expect(billing['STRIPE_SECRET_KEY']).toBe('sk_test_1');
  expect(billing['APP_ORIGIN']).toBe('http://localhost:3000');
  expect(billing['MAILER_KEY']).toBeUndefined();
  expect(mailer['MAILER_KEY']).toBe('mk_1');
  expect(mailer['STRIPE_SECRET_KEY']).toBeUndefined();
  expect(billing['UNRELATED_SECRET']).toBeUndefined();
});

test('a param pointer row gives the service the current value of the variable it names', async () => {
  await writeRows({ COMPOSER_WEB_ORIGIN: '@composer-param-pointer:APP_ORIGIN' });

  const web = await materializeEnv(
    devDir,
    'web',
    4000,
    pools({}, { APP_ORIGIN: 'http://localhost:3000' }),
  );

  expect(web['APP_ORIGIN']).toBe('http://localhost:3000');
});

test('a value changed in the pools reaches the service on the next materialization', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({ stripeKey: { $secret: 'STRIPE_SECRET_KEY' } }),
  });
  await materializeEnv(devDir, 'billing', 4000, pools({ STRIPE_SECRET_KEY: 'sk_test_old' }));

  const billing = await materializeEnv(
    devDir,
    'billing',
    4000,
    pools({ STRIPE_SECRET_KEY: 'sk_test_new' }),
  );

  expect(billing['STRIPE_SECRET_KEY']).toBe('sk_test_new');
});

test('a pointed variable that is unset or empty is not given to the service', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
      mailer: { $secret: 'MAILER_KEY' },
    }),
  });

  const billing = await materializeEnv(devDir, 'billing', 4000, pools({ MAILER_KEY: '' }));

  expect('STRIPE_SECRET_KEY' in billing).toBe(false);
  expect('MAILER_KEY' in billing).toBe(false);
});

test('a local deployment takes its secrets from the secrets pool and its param pointers from the config pool, never the shell', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({ stripeKey: { $secret: 'STRIPE_SECRET_KEY' } }),
    COMPOSER_BILLING_ORIGIN: '@composer-param-pointer:APP_ORIGIN',
  });
  process.env['STRIPE_SECRET_KEY'] = 'shell';
  process.env['APP_ORIGIN'] = 'shell';

  const billing = await materializeEnv(
    devDir,
    'billing',
    4000,
    pools({ STRIPE_SECRET_KEY: 'sk_pool' }, { APP_ORIGIN: 'https://pool.example' }),
  );

  expect(billing['STRIPE_SECRET_KEY']).toBe('sk_pool');
  expect(billing['APP_ORIGIN']).toBe('https://pool.example');
});

test('a param pointer whose config pool value is not text is left out', async () => {
  await writeRows({ COMPOSER_WEB_ORIGIN: '@composer-param-pointer:APP_ORIGIN' });

  const web = await materializeEnv(devDir, 'web', 4000, pools({}, { APP_ORIGIN: { host: 'x' } }));

  expect('APP_ORIGIN' in web).toBe(false);
});
