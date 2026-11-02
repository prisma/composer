import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dotenv, environmentVariables } from '../config-adapters.ts';

const freshDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'config-adapters-'));

const write = (dir: string, files: Record<string, string>): void => {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
};

const TOUCHED = ['S4_LATE', 'S4_PROBE', 'PRISMA_COMPOSER_PREFLIGHT_X'];

afterEach(() => {
  for (const name of TOUCHED) delete process.env[name];
});

const adapterInput = { environment: 'staging', configDirectory: '/app' };

describe('environmentVariables()', () => {
  test('environmentVariables() reads the process environment when called, not when created', async () => {
    const adapter = environmentVariables();
    process.env['S4_LATE'] = 'late';

    const values = await adapter({ environment: 'staging', configDirectory: '/app' });

    expect(values['S4_LATE']).toBe('late');
  });

  test("environmentVariables() leaves out Composer's own PRISMA_COMPOSER_ variables", async () => {
    process.env['PRISMA_COMPOSER_PREFLIGHT_X'] = 'payload';
    process.env['S4_PROBE'] = 'kept';

    const values = await environmentVariables()(adapterInput);

    expect(values['PRISMA_COMPOSER_PREFLIGHT_X']).toBeUndefined();
    expect(values['S4_PROBE']).toBe('kept');
  });
});

describe('dotenv()', () => {
  test("dotenv() reads the four files in dotenv-flow's order: the environment's local file wins, then the environment's file, then .env.local, then .env", async () => {
    const dir = freshDir();
    write(dir, {
      '.env': 'KEY=.env\nFROM_ENV=1\n',
      '.env.local': 'KEY=.env.local\nFROM_LOCAL=1\n',
      '.env.staging': 'KEY=.env.staging\nFROM_STAGING=1\n',
      '.env.staging.local': 'KEY=.env.staging.local\nFROM_STAGING_LOCAL=1\n',
    });

    const values = await dotenv()({ environment: 'staging', configDirectory: dir });

    expect(values).toEqual({
      KEY: '.env.staging.local',
      FROM_ENV: '1',
      FROM_LOCAL: '1',
      FROM_STAGING: '1',
      FROM_STAGING_LOCAL: '1',
    });
  });

  test('dotenv() skips files that do not exist, and gives {} when none does', async () => {
    const dir = freshDir();
    expect(await dotenv()({ environment: 'staging', configDirectory: dir })).toEqual({});

    write(dir, { '.env.staging': 'A=a\n' });
    expect(await dotenv()({ environment: 'staging', configDirectory: dir })).toEqual({ A: 'a' });
  });

  test('dotenv() reads beside prisma.config.ts, not the working directory', async () => {
    const dir = freshDir();
    write(dir, { '.env': 'BESIDE=yes\n' });
    const elsewhere = freshDir();
    write(elsewhere, { '.env': 'CWD=yes\n' });
    const cwd = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(await dotenv()({ environment: 'staging', configDirectory: dir })).toEqual({
        BESIDE: 'yes',
      });
    } finally {
      process.chdir(cwd);
    }
  });

  test('dotenv() does not read the process environment', async () => {
    const dir = freshDir();
    write(dir, { '.env': 'A=a\n' });
    process.env['S4_PROBE'] = 'probe';

    const values = await dotenv()({ environment: 'staging', configDirectory: dir });

    expect(values).not.toHaveProperty('S4_PROBE');
  });

  test('dotenv() encodes an environment name with a slash', async () => {
    const dir = freshDir();
    write(dir, { '.env.feature%2Fx': 'BRANCH=feature\n' });

    const values = await dotenv()({ environment: 'feature/x', configDirectory: dir });

    expect(values).toEqual({ BRANCH: 'feature' });
  });

  test('dotenv() fails naming a file it cannot read', async () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.env'));

    let message = '';
    try {
      await dotenv()({ environment: 'staging', configDirectory: dir });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toStartWith(`dotenv() could not read ${path.join(dir, '.env')}: `);
  });

  const reference = ['$', '{A}'].join('');

  test(`dotenv() leaves ${'$'}{VAR} references as written`, async () => {
    const dir = freshDir();
    write(dir, { '.env': `A=x\nB=${reference}\n` });

    const values = await dotenv()({ environment: 'staging', configDirectory: dir });

    expect(values['B']).toBe(reference);
  });

  test('dotenv() never reads .env.defaults', async () => {
    const dir = freshDir();
    write(dir, { '.env.defaults': 'A=defaults\nD=defaults\n', '.env': 'A=env\n' });

    const values = await dotenv()({ environment: 'staging', configDirectory: dir });

    expect(values).toEqual({ A: 'env' });
  });

  test('dotenv() skips .env.local for the environment test, as dotenv-flow does', async () => {
    const dir = freshDir();
    write(dir, {
      '.env': 'KEY=.env\n',
      '.env.local': 'KEY=.env.local\nONLY_LOCAL=1\n',
      '.env.test': 'KEY=.env.test\n',
      '.env.test.local': 'KEY=.env.test.local\n',
    });

    const values = await dotenv()({ environment: 'test', configDirectory: dir });

    expect(values).toEqual({ KEY: '.env.test.local' });
  });

  test("dotenv() reads .env.defaults as the environment's file for an environment named defaults", async () => {
    const dir = freshDir();
    write(dir, { '.env.defaults': 'A=env-file\n', '.env': 'A=env\n' });

    const values = await dotenv()({ environment: 'defaults', configDirectory: dir });

    expect(values).toEqual({ A: 'env-file' });
  });

  test('dotenv() does not change the process environment', async () => {
    const dir = freshDir();
    write(dir, { '.env': 'S11_PROBE=1\n' });

    await dotenv()({ environment: 'staging', configDirectory: dir });

    expect(process.env['S11_PROBE']).toBeUndefined();
  });
});
