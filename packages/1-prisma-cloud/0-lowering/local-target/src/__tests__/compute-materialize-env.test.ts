import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { materializeEnv } from '../compute.ts';
import { envStore } from '../dev-store.ts';

const NAMES = ['STRIPE_SECRET_KEY', 'MAILER_KEY', 'APP_ORIGIN', 'UNRELATED_SECRET'];
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
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
      nested: [{ origin: { $secret: 'APP_ORIGIN' } }],
    }),
    COMPOSER_MAILER_INPUT: JSON.stringify({ key: { $secret: 'MAILER_KEY' } }),
  });
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_1';
  process.env['APP_ORIGIN'] = 'http://localhost:3000';
  process.env['MAILER_KEY'] = 'mk_1';
  process.env['UNRELATED_SECRET'] = 'not for any service';

  const billing = await materializeEnv(devDir, 'billing', 4000);
  const mailer = await materializeEnv(devDir, 'mailer', 4001);

  expect(billing['STRIPE_SECRET_KEY']).toBe('sk_test_1');
  expect(billing['APP_ORIGIN']).toBe('http://localhost:3000');
  expect(billing['MAILER_KEY']).toBeUndefined();
  expect(mailer['MAILER_KEY']).toBe('mk_1');
  expect(mailer['STRIPE_SECRET_KEY']).toBeUndefined();
  expect(billing['UNRELATED_SECRET']).toBeUndefined();
});

test('a param pointer row gives the service the current value of the variable it names', async () => {
  await writeRows({ COMPOSER_WEB_ORIGIN: '@composer-param-pointer:APP_ORIGIN' });
  process.env['APP_ORIGIN'] = 'http://localhost:3000';

  const web = await materializeEnv(devDir, 'web', 4000);

  expect(web['APP_ORIGIN']).toBe('http://localhost:3000');
});

test('a value changed in the environment reaches the service on the next materialization', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({ stripeKey: { $secret: 'STRIPE_SECRET_KEY' } }),
  });
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_old';
  await materializeEnv(devDir, 'billing', 4000);
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_new';

  expect((await materializeEnv(devDir, 'billing', 4000))['STRIPE_SECRET_KEY']).toBe('sk_test_new');
});

test('a pointed variable that is unset or empty is not given to the service', async () => {
  await writeRows({
    COMPOSER_BILLING_INPUT: JSON.stringify({
      stripeKey: { $secret: 'STRIPE_SECRET_KEY' },
      mailer: { $secret: 'MAILER_KEY' },
    }),
  });
  process.env['MAILER_KEY'] = '';

  const billing = await materializeEnv(devDir, 'billing', 4000);

  expect('STRIPE_SECRET_KEY' in billing).toBe(false);
  expect('MAILER_KEY' in billing).toBe(false);
});
