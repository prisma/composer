import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  test('finds node_modules/.bin/alchemy in the given directory', () => {
    const dir = makeTmpDir();
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'alchemy'), '');

    expect(resolveAlchemyBin(dir)).toBe(path.join(binDir, 'alchemy'));
  });

  test('walks up through parent directories (hoisted node_modules layouts)', () => {
    const root = makeTmpDir();
    const binDir = path.join(root, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'alchemy'), '');
    const nested = path.join(root, 'examples', 'app');
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveAlchemyBin(nested)).toBe(path.join(binDir, 'alchemy'));
  });

  test('throws naming the starting directory when no alchemy bin is found anywhere above it', () => {
    const dir = makeTmpDir();
    expect(() => resolveAlchemyBin(dir)).toThrow(/Could not find an installed `alchemy` bin/);
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

    const status = runAlchemy({
      command: 'deploy',
      stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
      cwd: dir,
      stage: 'ci-42',
      containerEnv: {},
      env: { ...process.env, CAPTURE_FILE: captureFile },
    });

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

  test('omits --stage when none is given', () => {
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

    runAlchemy({
      command: 'destroy',
      stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
      cwd: dir,
      stage: undefined,
      containerEnv: {},
      env: { ...process.env, CAPTURE_FILE: captureFile },
    });

    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    expect(captured.argv).toEqual(['destroy', '.prisma-composer/alchemy.run.ts', '--yes']);
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

    runAlchemy({
      command: 'deploy',
      stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
      cwd: dir,
      stage: 'staging',
      containerEnv: { PRISMA_COMPOSER_CONTAINER_FOO: 'serialized-instance' },
      env: { ...process.env, CAPTURE_FILE: captureFile, BASE_VAR: 'base' },
    });

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

    runAlchemy({
      command: 'deploy',
      stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
      cwd: dir,
      stage: undefined,
      containerEnv: {},
      env: { ...process.env, CAPTURE_FILE: captureFile, BASE_VAR: 'base' },
    });

    const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    expect(captured).toEqual({ BASE_VAR: 'base' });
  });
});
