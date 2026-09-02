/**
 * The converge invocation module, as it is now: bin resolution, invocation
 * composition, and the default runner for hosts with no engine behind them.
 *
 * The CLI no longer uses `spawnAlchemy` — under the engine the child is
 * started by `ctx.spawn` — so what is covered here is the programmatic host's
 * path (`@prisma/composer/control`), where the same rules still have to hold.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  alchemyCommandLine,
  alchemyInvocation,
  resolveAlchemyBin,
  spawnAlchemy,
} from '../run-alchemy.ts';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-alchemy-')),
  );
  tmpDirs.push(dir);
  return dir;
}

/** A fake `alchemy` bin at `<dir>/node_modules/.bin/alchemy`, running `body`. */
function installFakeAlchemy(dir: string, body: readonly string[] = []): string {
  const binDir = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'alchemy');
  fs.writeFileSync(bin, ['#!/usr/bin/env node', ...body].join('\n'), { mode: 0o755 });
  return bin;
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
    const bin = installFakeAlchemy(dir);

    expect(resolveAlchemyBin(dir)).toBe(bin);
  });

  test('walks up through parent directories (hoisted node_modules layouts)', () => {
    const root = makeTmpDir();
    const bin = installFakeAlchemy(root);
    const nested = path.join(root, 'examples', 'app');
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveAlchemyBin(nested)).toBe(bin);
  });

  test('throws naming the starting directory when no alchemy bin is found anywhere above it', () => {
    const dir = makeTmpDir();
    expect(() => resolveAlchemyBin(dir)).toThrow(/Could not find an installed `alchemy` bin/);
  });
});

describe('alchemyInvocation()', () => {
  /**
   * The invocation names WHAT to converge and resolves nothing. That split is
   * what lets an injected adapter — a fake child — run in a directory with no
   * alchemy installed; resolving the bin here would have raised
   * DEPLOY.ALCHEMY_BIN_MISSING before the fake ever ran.
   */
  test('names what to converge, and resolves no binary', () => {
    const dir = makeTmpDir();

    expect(
      alchemyInvocation({
        command: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd: dir,
        stage: 'ci-42',
        containerEnv: {},
      }),
    ).toEqual({
      action: 'deploy',
      stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
      cwd: dir,
      stage: 'ci-42',
      env: {},
    });
  });

  test('becomes `<command> <stack file> --yes --stage <stage>` against the resolved bin', () => {
    const dir = makeTmpDir();
    const bin = installFakeAlchemy(dir);

    expect(
      alchemyCommandLine(
        alchemyInvocation({
          command: 'deploy',
          stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
          cwd: dir,
          stage: 'ci-42',
          containerEnv: {},
        }),
      ),
    ).toEqual({
      command: bin,
      args: ['deploy', '.prisma-composer/alchemy.run.ts', '--yes', '--stage', 'ci-42'],
      cwd: dir,
      env: {},
    });
  });

  test('destroy passes --stage too — the stage is never left to alchemy’s machine-dependent default', () => {
    const dir = makeTmpDir();
    installFakeAlchemy(dir);

    expect(
      alchemyCommandLine(
        alchemyInvocation({
          command: 'destroy',
          stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
          cwd: dir,
          stage: 'br_test123',
          containerEnv: {},
        }),
      ).args,
    ).toEqual(['destroy', '.prisma-composer/alchemy.run.ts', '--yes', '--stage', 'br_test123']);
  });

  test('the stage never comes from the environment: identical argv whatever USER is', () => {
    const dir = makeTmpDir();
    installFakeAlchemy(dir);

    const argv = alchemyCommandLine(
      alchemyInvocation({
        command: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd: dir,
        stage: 'br_test123',
        containerEnv: {},
      }),
    ).args;

    expect(argv).not.toContain(os.userInfo().username);
    expect(argv).toEqual([
      'deploy',
      '.prisma-composer/alchemy.run.ts',
      '--yes',
      '--stage',
      'br_test123',
    ]);
  });

  test('env carries only the ADDITIONS — the containers plus the extra pointers, never a whole environment', () => {
    const dir = makeTmpDir();
    installFakeAlchemy(dir);

    expect(
      alchemyInvocation({
        command: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd: dir,
        stage: 'staging',
        containerEnv: { PRISMA_COMPOSER_CONTAINER_FOO: 'serialized-instance' },
        env: { PRISMA_COMPOSER_DEPLOYMENT_RESULT: '/tmp/result.json' },
      }).env,
    ).toEqual({
      PRISMA_COMPOSER_CONTAINER_FOO: 'serialized-instance',
      PRISMA_COMPOSER_DEPLOYMENT_RESULT: '/tmp/result.json',
    });
  });
});

describe('spawnAlchemy()', () => {
  test('runs the invocation in its cwd with its env additions merged over the invoking environment', async () => {
    const dir = makeTmpDir();
    const captureFile = path.join(dir, 'capture.json');
    installFakeAlchemy(dir, [
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({',
      '  argv: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '  BASE_VAR: process.env.BASE_VAR ?? null,',
      '  PRISMA_COMPOSER_CONTAINER_FOO: process.env.PRISMA_COMPOSER_CONTAINER_FOO ?? null,',
      '}));',
    ]);

    process.env['BASE_VAR'] = 'base';
    process.env['CAPTURE_FILE'] = captureFile;
    try {
      const outcome = await spawnAlchemy({
        action: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        stage: 'ci-42',
        cwd: dir,
        env: { PRISMA_COMPOSER_CONTAINER_FOO: 'serialized-instance' },
      });

      expect(outcome).toEqual({ exitCode: 0, signal: null });
      const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
      expect(captured.argv).toEqual([
        'deploy',
        '.prisma-composer/alchemy.run.ts',
        '--yes',
        '--stage',
        'ci-42',
      ]);
      expect(fs.realpathSync(captured.cwd)).toBe(dir);
      expect(captured.BASE_VAR).toBe('base');
      expect(captured.PRISMA_COMPOSER_CONTAINER_FOO).toBe('serialized-instance');
    } finally {
      delete process.env['BASE_VAR'];
      delete process.env['CAPTURE_FILE'];
    }
  });

  test("returns a failing child's status verbatim rather than collapsing it", async () => {
    const dir = makeTmpDir();
    installFakeAlchemy(dir, ['process.exit(3);']);

    expect(
      await spawnAlchemy({
        action: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        stage: 'test',
        cwd: dir,
        env: {},
      }),
    ).toEqual({
      exitCode: 3,
      signal: null,
    });
  });

  /**
   * The collapse this replaced is what made a Ctrl-C'd deploy report itself as
   * a failure: a signal-killed child has NO exit code, and saying otherwise
   * loses the only evidence that the user aborted.
   */
  test.skipIf(process.platform === 'win32')(
    'a signal-killed child comes back as the signal with a null exit code',
    async () => {
      const dir = makeTmpDir();
      installFakeAlchemy(dir, [
        'process.kill(process.pid, "SIGTERM");',
        'setTimeout(() => {}, 5000);',
      ]);

      expect(
        await spawnAlchemy({
          action: 'deploy',
          stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
          stage: 'test',
          cwd: dir,
          env: {},
        }),
      ).toEqual({
        exitCode: null,
        signal: 'SIGTERM',
      });
    },
  );

  test('raises the structured error when the app has no alchemy installed', async () => {
    const dir = makeTmpDir();
    await expect(
      spawnAlchemy({
        action: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        stage: 'test',
        cwd: dir,
        env: {},
      }),
    ).rejects.toThrow(/Could not find an installed `alchemy` bin/);
  });
});
