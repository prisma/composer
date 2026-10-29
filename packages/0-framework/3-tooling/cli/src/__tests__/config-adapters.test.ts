import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dotenv, environmentVariables } from '../config-adapters.ts';

const freshDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'config-adapters-'));

const write = (dir: string, files: Record<string, string>): void => {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
};

afterEach(() => {
  delete process.env['S4_LATE'];
  delete process.env['S4_PROBE'];
});

describe('environmentVariables()', () => {
  test('environmentVariables() reads the process environment when called, not when created', async () => {
    const adapter = environmentVariables();
    process.env['S4_LATE'] = 'late';

    const values = await adapter({ environment: 'staging', configDirectory: '/app' });

    expect(values['S4_LATE']).toBe('late');
  });
});

describe('dotenv()', () => {
  test("dotenv() reads the four files, the environment's local file winning, then the environment's file, then .env.local, then .env", async () => {
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

    expect(message).toStartWith(`dotenv() could not read ${dir}/.env: `);
  });

  test('dotenv() leaves ${VAR} references as written', async () => {
    const dir = freshDir();
    write(dir, { '.env': 'A=x\nB=${A}\n' });

    const values = await dotenv()({ environment: 'staging', configDirectory: dir });

    expect(values['B']).toBe('${A}');
  });
});
