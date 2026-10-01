/**
 * The converge invocation module, as it is now: resolving the Alchemy
 * executable from Composer's own dependency, invocation composition, and the
 * default runner for hosts with no engine behind them.
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
  nodeExecutable,
  resolveAlchemyEntry,
  type spawnAlchemy,
  spawnCommandLine,
} from '../run-alchemy.ts';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-alchemy-')),
  );
  tmpDirs.push(dir);
  return dir;
}

/**
 * A fake `alchemy` package at `<dir>/node_modules/alchemy`, whose `bin` runs
 * `body`. No `.bin` link is created: pnpm links bins only for an app's direct
 * dependencies, and alchemy is Composer's dependency, not the app's.
 */
function installFakeAlchemy(dir: string, body: readonly string[] = []): string {
  const packageDir = path.join(dir, 'node_modules', 'alchemy');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'alchemy', type: 'commonjs', bin: { alchemy: './bin/cli.js' } }),
  );
  const entry = path.join(packageDir, 'bin', 'cli.js');
  fs.writeFileSync(entry, body.join('\n'));
  return entry;
}

/**
 * pnpm's isolated layout: Composer's real files sit in the store next to its
 * own dependencies, and the app's node_modules has no `.bin/alchemy`.
 */
function pnpmStoreLayout(root: string): { composerFile: string; storeDir: string } {
  const storeDir = path.join(
    root,
    'node_modules',
    '.pnpm',
    '@prisma+composer@0.26.0',
    'node_modules',
  );
  const composerFile = path.join(storeDir, '@prisma', 'composer', 'dist', 'control.mjs');
  fs.mkdirSync(path.dirname(composerFile), { recursive: true });
  fs.writeFileSync(composerFile, '');
  return { composerFile, storeDir };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveAlchemyEntry()', () => {
  test('resolves the bin of an alchemy that is only a dependency of Composer, with no .bin link', () => {
    const root = makeTmpDir();
    const { composerFile, storeDir } = pnpmStoreLayout(root);
    const entry = installFakeAlchemy(path.dirname(storeDir));

    expect(resolveAlchemyEntry(composerFile)).toBe(entry);
    expect(fs.existsSync(path.join(root, 'node_modules', '.bin', 'alchemy'))).toBe(false);
  });

  test('walks up from Composer to a hoisted alchemy', () => {
    const root = makeTmpDir();
    const entry = installFakeAlchemy(root);
    const composerFile = path.join(
      root,
      'node_modules',
      '@prisma',
      'composer',
      'dist',
      'control.mjs',
    );
    fs.mkdirSync(path.dirname(composerFile), { recursive: true });
    fs.writeFileSync(composerFile, '');

    expect(resolveAlchemyEntry(composerFile)).toBe(entry);
  });

  test('resolves from Composer reached through a symlink, as pnpm links it into the app', () => {
    const root = makeTmpDir();
    const { composerFile, storeDir } = pnpmStoreLayout(root);
    const entry = installFakeAlchemy(path.dirname(storeDir));
    const appLink = path.join(root, 'node_modules', '@prisma', 'composer');
    fs.mkdirSync(path.dirname(appLink), { recursive: true });
    fs.symlinkSync(path.join(storeDir, '@prisma', 'composer'), appLink, 'dir');

    expect(resolveAlchemyEntry(path.join(appLink, 'dist', path.basename(composerFile)))).toBe(
      entry,
    );
  });

  test('reads a bin given as a string', () => {
    const root = makeTmpDir();
    const { composerFile, storeDir } = pnpmStoreLayout(root);
    const packageDir = path.join(storeDir, 'alchemy');
    fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'alchemy', bin: './bin/cli.js' }),
    );
    fs.writeFileSync(path.join(packageDir, 'bin', 'cli.js'), '');

    expect(resolveAlchemyEntry(composerFile)).toBe(path.join(packageDir, 'bin', 'cli.js'));
  });

  for (const [label, bin, writeEntry] of [
    ['a bin object without an alchemy key', { other: './bin/cli.js' }, true],
    ['a bin that names a missing file', { alchemy: './bin/missing.js' }, true],
  ] as const) {
    test(`raises DEPLOY.ALCHEMY_BIN_MISSING for ${label}`, () => {
      const root = makeTmpDir();
      const { composerFile, storeDir } = pnpmStoreLayout(root);
      const packageDir = path.join(storeDir, 'alchemy');
      fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, 'package.json'),
        JSON.stringify({ name: 'alchemy', bin }),
      );
      if (writeEntry) fs.writeFileSync(path.join(packageDir, 'bin', 'cli.js'), '');

      expect(() => resolveAlchemyEntry(composerFile)).toThrow(
        expect.objectContaining({ code: 'DEPLOY.ALCHEMY_BIN_MISSING' }),
      );
    });
  }

  test('raises DEPLOY.ALCHEMY_BIN_MISSING, not a raw ENOENT, when Composer is not a file on disk', () => {
    const missing = path.join(makeTmpDir(), 'virtual', 'control.mjs');

    expect(() => resolveAlchemyEntry(missing)).toThrow(
      expect.objectContaining({ code: 'DEPLOY.ALCHEMY_BIN_MISSING' }),
    );
  });

  test('raises DEPLOY.ALCHEMY_BIN_MISSING, naming the package lookup, when alchemy is not installed', () => {
    const { composerFile } = pnpmStoreLayout(makeTmpDir());

    expect(() => resolveAlchemyEntry(composerFile)).toThrow(
      expect.objectContaining({
        code: 'DEPLOY.ALCHEMY_BIN_MISSING',
        message: expect.stringContaining('Could not resolve the `alchemy` package'),
        fix: expect.stringContaining('installed beside @prisma/composer'),
      }),
    );
  });

  test('resolves the alchemy this package is installed with', () => {
    const entry = resolveAlchemyEntry();

    expect(path.basename(path.dirname(path.dirname(entry)))).toBe('alchemy');
    expect(fs.existsSync(entry)).toBe(true);
  });
});

describe('nodeExecutable()', () => {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';

  test('under Node, is the running Node itself', () => {
    expect(
      nodeExecutable({
        bun: false,
        execPath: '/opt/node/bin/node',
        env: {},
        platform: 'linux',
        exists: fs.existsSync,
      }),
    ).toBe('/opt/node/bin/node');
  });

  test('under Bun, is the first node on PATH, so Alchemy keeps running under Node', () => {
    const empty = makeTmpDir();
    const withNode = makeTmpDir();
    const node = path.join(withNode, nodeName);
    fs.writeFileSync(node, '', { mode: 0o755 });

    expect(
      nodeExecutable({
        bun: true,
        execPath: '/opt/bun/bin/bun',
        env: { PATH: [empty, withNode].join(path.delimiter) },
        platform: process.platform,
        exists: fs.existsSync,
      }),
    ).toBe(node);
  });

  test('on Windows, splits PATH on ";", unquotes entries and tries PATHEXT, whatever the host platform', () => {
    const node = 'C:\\Program Files\\nodejs\\node.EXE';

    expect(
      nodeExecutable({
        bun: true,
        execPath: 'C:\\bun\\bun.exe',
        env: { Path: 'C:\\missing;"C:\\Program Files\\nodejs"', PATHEXT: '.COM;.EXE' },
        platform: 'win32',
        exists: (file) => file === node,
      }),
    ).toBe(node);
  });

  test('under Bun with no node on PATH, raises DEPLOY.NODE_MISSING', () => {
    expect(() =>
      nodeExecutable({
        bun: true,
        execPath: '/opt/bun/bin/bun',
        env: { PATH: makeTmpDir() },
        platform: process.platform,
        exists: fs.existsSync,
      }),
    ).toThrow(expect.objectContaining({ code: 'DEPLOY.NODE_MISSING' }));
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

  test('becomes `<node> <alchemy entry> <command> <stack file> --yes --stage <stage>`', () => {
    const dir = makeTmpDir();
    const entry = installFakeAlchemy(dir);

    expect(
      alchemyCommandLine(
        alchemyInvocation({
          command: 'deploy',
          stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
          cwd: dir,
          stage: 'ci-42',
          containerEnv: {},
        }),
        entry,
        '/opt/node/bin/node',
      ),
    ).toEqual({
      command: '/opt/node/bin/node',
      args: [entry, 'deploy', '.prisma-composer/alchemy.run.ts', '--yes', '--stage', 'ci-42'],
      cwd: dir,
      env: {},
    });
  });

  test('destroy passes --stage too — the stage is never left to alchemy’s machine-dependent default', () => {
    const dir = makeTmpDir();
    const entry = installFakeAlchemy(dir);

    expect(
      alchemyCommandLine(
        alchemyInvocation({
          command: 'destroy',
          stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
          cwd: dir,
          stage: 'br_test123',
          containerEnv: {},
        }),
        entry,
      ).args,
    ).toEqual([
      entry,
      'destroy',
      '.prisma-composer/alchemy.run.ts',
      '--yes',
      '--stage',
      'br_test123',
    ]);
  });

  test('the stage never comes from the environment: identical argv whatever USER is', () => {
    const dir = makeTmpDir();
    const entry = installFakeAlchemy(dir);

    const argv = alchemyCommandLine(
      alchemyInvocation({
        command: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd: dir,
        stage: 'br_test123',
        containerEnv: {},
      }),
      entry,
    ).args;

    expect(argv).not.toContain(os.userInfo().username);
    expect(argv).toEqual([
      entry,
      'deploy',
      '.prisma-composer/alchemy.run.ts',
      '--yes',
      '--stage',
      'br_test123',
    ]);
  });

  test('env carries only the ADDITIONS — the containers plus the extra pointers, never a whole environment', () => {
    const dir = makeTmpDir();

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

describe('spawnCommandLine()', () => {
  /** Runs a fake alchemy entry the way spawnAlchemy runs the real one: the current runtime, the entry as its first argument. */
  function runFake(
    entry: string,
    invocation: Parameters<typeof spawnAlchemy>[0],
  ): ReturnType<typeof spawnAlchemy> {
    return spawnCommandLine(alchemyCommandLine(invocation, entry));
  }

  test('runs the invocation in its cwd with its env additions merged over the invoking environment', async () => {
    const dir = makeTmpDir();
    const captureFile = path.join(dir, 'capture.json');
    const entry = installFakeAlchemy(dir, [
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
      const outcome = await runFake(entry, {
        action: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        stage: 'spaces & symbols',
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
        'spaces & symbols',
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
    const entry = installFakeAlchemy(dir, ['process.exit(3);']);

    expect(
      await runFake(entry, {
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
      const entry = installFakeAlchemy(dir, [
        'process.kill(process.pid, "SIGTERM");',
        'setTimeout(() => {}, 5000);',
      ]);

      expect(
        await runFake(entry, {
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
});
