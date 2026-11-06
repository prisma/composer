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
  entryPath: path.join(import.meta.dir, 'fixtures', 'valid-root.ts'),
  cwd: fixtureDir,
  configFile: path.join(fixtureDir, 'prisma.config.ts'),
  name: 'fixture-root',
  environment: 'staging',
  assembled: { devServers: {}, bundles: {} },
};

function spawnStack(stackFile: string) {
  return spawnSync(
    process.execPath,
    ['--preload', path.join(fixtureDir, 'stub-composer.ts'), stackFile],
    { cwd: fixtureDir, encoding: 'utf-8' },
  );
}

function runStack(stackFile: string) {
  const child = spawnStack(stackFile);
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('the generated stack files, evaluated', () => {
  const file = {
    appConfigurationRead: { rootInput: [], configurationKeyText: { read: 'from-file' } },
    nodeAddresses: ['stub-address'],
  };

  test('the deploy stack passes the composer export of prisma.config.ts, the environment, and the app configuration file, to lower(), and runs no adapter', () => {
    expect(runStack(writeStackFile(stackInput))).toEqual({
      app: 'fixture-root',
      extensions: ['fixture-extension'],
      state: 'fixture-extension',
      environment: 'staging',
      appConfigurationRead: file.appConfigurationRead,
      firstProcessNodeAddresses: file.nodeAddresses,
    });
  });

  test('the dev stack passes the composer export of prisma.config.ts, the environment, and the app configuration file, to lower(), the configuration key text and the named secrets to the local providers, and runs no adapter', () => {
    expect(runStack(writeDevStackFile(stackInput))).toEqual({
      app: 'fixture-root',
      extensions: ['fixture-extension'],
      state: 'fixture-extension',
      environment: 'staging',
      appConfigurationRead: file.appConfigurationRead,
      firstProcessNodeAddresses: file.nodeAddresses,
      local: { configurationKeyText: { read: 'from-file' }, namedSecrets: { read: 'secrets' } },
    });
  });

  const noSectionFile = path.join(fixtureDir, '..', 'stack-import-no-section', 'prisma.config.ts');

  /**
   * A file that inherits its section from a parent prisma.config.ts, or a
   * programmatic caller naming the wrong file, would otherwise fail inside
   * lower() with a TypeError.
   */
  for (const [stack, write] of [
    ['deploy', writeStackFile],
    ['dev', writeDevStackFile],
  ] as const) {
    test(`the ${stack} stack refuses a prisma.config.ts that declares no composer section, naming it`, () => {
      const child = spawnStack(write({ ...stackInput, configFile: noSectionFile }));
      expect(child.status).not.toBe(0);
      expect(child.stdout).toBe('');
      expect(child.stderr).toContain(
        `${noSectionFile} declares no \`composer\` section. Pass the prisma.config.ts that declares it.`,
      );
    });
  }
});
