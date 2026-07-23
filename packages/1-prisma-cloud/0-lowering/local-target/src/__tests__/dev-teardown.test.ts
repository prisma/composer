import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeLocalPostgresInstances } from '../dev/teardown.ts';

/**
 * `removeLocalPostgresInstances`'s glob must apply the SAME name slugging
 * `postgres.ts`'s `instanceName` uses to derive an instance name in the
 * first place — otherwise an app name containing slugged characters (a
 * space, a dot, an uppercase letter, …) would orphan its instances: the
 * database was created under the slugged name, but the teardown glob would
 * search for the raw one.
 */
describe('removeLocalPostgresInstances — the stop/rm glob slugs the app name', () => {
  let cwd: string;
  let previousCwd: string;
  let argvLog: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-teardown-test-'));
    previousCwd = process.cwd();
    process.chdir(cwd);

    const binDir = path.join(cwd, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    argvLog = path.join(cwd, 'argv.log');
    const fakePrisma = path.join(binDir, 'prisma');
    fs.writeFileSync(fakePrisma, `#!/bin/sh\necho "$@" >> ${JSON.stringify(argvLog)}\nexit 0\n`, {
      mode: 0o755,
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('an app name with slug-transformed characters (e.g. "My.App") globs the slugged instance name, not the raw one', () => {
    removeLocalPostgresInstances(cwd, 'My.App');

    const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(calls).toEqual(['dev stop pcdev-my-app-*', 'dev rm pcdev-my-app-*']);
  });

  test('an already-slug-safe app name is unaffected', () => {
    removeLocalPostgresInstances(cwd, 'plainapp');

    const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(calls).toEqual(['dev stop pcdev-plainapp-*', 'dev rm pcdev-plainapp-*']);
  });
});
