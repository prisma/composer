import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAlchemyBin, runAlchemy } from '../run-alchemy.ts';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-alchemy-')),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveAlchemyBin()', () => {
  test("resolves Alchemy from Composer's dependency graph and reads its declared bin", () => {
    const root = makeTmpDir();
    const packageDir = path.join(root, 'node_modules', 'alchemy');
    const binDir = path.join(packageDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'alchemy',
        main: './index.js',
        exports: { '.': './index.js' },
        bin: { alchemy: './bin/cli.js' },
      }),
    );
    fs.writeFileSync(path.join(packageDir, 'index.js'), '');
    fs.writeFileSync(path.join(binDir, 'cli.js'), '');
    fs.writeFileSync(path.join(root, 'composer-bin.mjs'), '');

    expect(resolveAlchemyBin(pathToFileURL(path.join(root, 'composer-bin.mjs')).href)).toBe(
      path.join(binDir, 'cli.js'),
    );
  });

  test('resolves an isolated pnpm-style dependency with no app-level bin', () => {
    const root = makeTmpDir();
    const appDir = path.join(root, 'app');
    const installDir = path.join(
      appDir,
      'node_modules',
      '.pnpm',
      '@prisma+composer@0.0.0',
      'node_modules',
    );
    const composerDir = path.join(installDir, '@prisma', 'composer');
    const alchemyDir = path.join(installDir, 'alchemy');
    fs.mkdirSync(path.join(composerDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(alchemyDir, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(alchemyDir, 'package.json'),
      JSON.stringify({ name: 'alchemy', main: './index.js', bin: { alchemy: './bin/cli.js' } }),
    );
    fs.writeFileSync(path.join(alchemyDir, 'index.js'), '');
    fs.writeFileSync(path.join(alchemyDir, 'bin', 'cli.js'), '');
    fs.writeFileSync(path.join(composerDir, 'dist', 'bin.mjs'), '');
    const publicComposerDir = path.join(appDir, 'node_modules', '@prisma', 'composer');
    fs.mkdirSync(path.dirname(publicComposerDir), { recursive: true });
    fs.symlinkSync(composerDir, publicComposerDir, 'dir');

    expect(resolveAlchemyBin(path.join(publicComposerDir, 'dist', 'bin.mjs'))).toBe(
      path.join(alchemyDir, 'bin', 'cli.js'),
    );
  });

  test('throws when the resolved package has no declared alchemy bin', () => {
    const root = makeTmpDir();
    const packageDir = path.join(root, 'node_modules', 'alchemy');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'alchemy', main: './index.js' }),
    );
    fs.writeFileSync(path.join(packageDir, 'index.js'), '');
    fs.writeFileSync(path.join(root, 'composer-bin.mjs'), '');

    expect(() => resolveAlchemyBin(path.join(root, 'composer-bin.mjs'))).toThrow(
      /does not declare an `alchemy` bin/,
    );
  });
});

describe('runAlchemy()', () => {
  test('spawns the resolved bin with <command> <stack file> --yes [--stage], cwd = the package dir', () => {
    const dir = makeTmpDir();
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const captureFile = path.join(dir, 'capture.json');
    // A fake `alchemy` bin: records argv + cwd instead of doing anything real.
    fs.writeFileSync(
      path.join(binDir, 'alchemy'),
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));',
      ].join('\n'),
      { mode: 0o755 },
    );

    const status = runAlchemy(
      {
        command: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd: dir,
        stage: 'ci-42',
        containerEnv: {},
        env: { ...process.env, CAPTURE_FILE: captureFile },
      },
      { resolveBin: () => path.join(binDir, 'alchemy') },
    );

    expect(status).toBe(0);
    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    expect(captured.argv).toEqual([
      'deploy',
      '.prisma-composer/alchemy.run.ts',
      '--yes',
      '--stage',
      'ci-42',
    ]);
    expect(fs.realpathSync(captured.cwd)).toBe(dir);
  });

  test('destroy always passes --stage too — the stage is required, never left to alchemy’s default', () => {
    const dir = makeTmpDir();
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const captureFile = path.join(dir, 'capture.json');
    fs.writeFileSync(
      path.join(binDir, 'alchemy'),
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ argv: process.argv.slice(2) }));',
      ].join('\n'),
      { mode: 0o755 },
    );

    runAlchemy(
      {
        command: 'destroy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd: dir,
        stage: 'br_test123',
        containerEnv: {},
        env: { ...process.env, CAPTURE_FILE: captureFile },
      },
      { resolveBin: () => path.join(binDir, 'alchemy') },
    );

    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    expect(captured.argv).toEqual([
      'destroy',
      '.prisma-composer/alchemy.run.ts',
      '--yes',
      '--stage',
      'br_test123',
    ]);
  });

  test('argv is identical across USER env values and with USER/USERNAME unset (stage never comes from the environment)', () => {
    const dir = makeTmpDir();
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const captureFile = path.join(dir, 'capture.json');
    fs.writeFileSync(
      path.join(binDir, 'alchemy'),
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ argv: process.argv.slice(2) }));',
      ].join('\n'),
      { mode: 0o755 },
    );

    const baseEnv: NodeJS.ProcessEnv = { ...process.env, CAPTURE_FILE: captureFile };
    delete baseEnv['USER'];
    delete baseEnv['USERNAME'];
    const envs: NodeJS.ProcessEnv[] = [
      { ...baseEnv, USER: 'alice' },
      { ...baseEnv, USER: 'runner' },
      baseEnv,
    ];

    const captures = envs.map((env) => {
      runAlchemy(
        {
          command: 'deploy',
          stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
          cwd: dir,
          stage: 'br_test123',
          containerEnv: {},
          env,
        },
        { resolveBin: () => path.join(binDir, 'alchemy') },
      );
      return JSON.parse(fs.readFileSync(captureFile, 'utf8')).argv;
    });

    for (const argv of captures) {
      expect(argv).toEqual([
        'deploy',
        '.prisma-composer/alchemy.run.ts',
        '--yes',
        '--stage',
        'br_test123',
      ]);
    }
  });

  test('merges containerEnv over the base env on the child — one var per extension, content-blind', () => {
    const dir = makeTmpDir();
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const captureFile = path.join(dir, 'capture.json');
    fs.writeFileSync(
      path.join(binDir, 'alchemy'),
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({',
        '  BASE_VAR: process.env.BASE_VAR ?? null,',
        '  PRISMA_COMPOSER_CONTAINER_FOO: process.env.PRISMA_COMPOSER_CONTAINER_FOO ?? null,',
        '}));',
      ].join('\n'),
      { mode: 0o755 },
    );

    runAlchemy(
      {
        command: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd: dir,
        stage: 'staging',
        containerEnv: { PRISMA_COMPOSER_CONTAINER_FOO: 'serialized-instance' },
        env: { ...process.env, CAPTURE_FILE: captureFile, BASE_VAR: 'base' },
      },
      { resolveBin: () => path.join(binDir, 'alchemy') },
    );

    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    expect(captured).toEqual({
      BASE_VAR: 'base',
      PRISMA_COMPOSER_CONTAINER_FOO: 'serialized-instance',
    });
  });

  test('an empty containerEnv leaves the base env untouched', () => {
    const dir = makeTmpDir();
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const captureFile = path.join(dir, 'capture.json');
    fs.writeFileSync(
      path.join(binDir, 'alchemy'),
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({',
        '  BASE_VAR: process.env.BASE_VAR ?? null,',
        '}));',
      ].join('\n'),
      { mode: 0o755 },
    );

    runAlchemy(
      {
        command: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd: dir,
        stage: 'staging',
        containerEnv: {},
        env: { ...process.env, CAPTURE_FILE: captureFile, BASE_VAR: 'base' },
      },
      { resolveBin: () => path.join(binDir, 'alchemy') },
    );

    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    expect(captured).toEqual({ BASE_VAR: 'base' });
  });
});
