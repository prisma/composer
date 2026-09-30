/**
 * The generated stack files import the declaring prisma.config.ts and hand its
 * `composer` export to lower(). These tests run the generated files in a child
 * process against a real prisma.config.ts, with the heavy imports stubbed, so
 * the import itself is executed rather than string-matched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeDevStackFile } from '../dev/generate-dev-stack.ts';
import { writeStackFile } from '../generate-stack.ts';

const fixtureDir = path.join(import.meta.dir, 'fixtures', 'stack-import');
const generatedDir = path.join(fixtureDir, '.prisma-composer');

afterEach(() => {
  fs.rmSync(generatedDir, { recursive: true, force: true });
});

const stackInput = {
  entryPath: path.join(import.meta.dir, 'fixtures', 'valid-module.ts'),
  cwd: fixtureDir,
  configFile: path.join(fixtureDir, 'prisma.config.ts'),
  name: 'fixture-module',
  assembled: { bundles: {} },
};

function runStack(stackFile: string) {
  const child = spawnSync(
    process.execPath,
    ['--preload', path.join(fixtureDir, 'stub-composer.ts'), stackFile],
    { cwd: fixtureDir, encoding: 'utf-8' },
  );
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('the generated stack files, evaluated', () => {
  test('the deploy stack passes the composer export of prisma.config.ts to lower()', () => {
    expect(runStack(writeStackFile(stackInput))).toEqual({
      app: 'fixture-module',
      extensions: ['fixture-extension'],
      state: 'fixture-extension',
    });
  });

  test('the dev stack passes the composer export of prisma.config.ts to lower()', () => {
    expect(runStack(writeDevStackFile(stackInput))).toEqual({
      app: 'fixture-module',
      extensions: ['fixture-extension'],
      state: 'fixture-extension',
    });
  });
});
