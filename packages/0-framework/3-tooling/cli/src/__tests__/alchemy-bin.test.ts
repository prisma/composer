import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveAlchemyBin } from '../alchemy-bin.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-alchemy-bin-')));
  tmpDirs.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** A package directory under `node_modules`, whose manifest exports only `./package.json`, as @prisma/composer's does. */
function writeComposer(packageDir: string): void {
  writeJson(path.join(packageDir, 'package.json'), {
    name: '@prisma/composer',
    exports: { './package.json': './package.json' },
  });
}

/** A fake `alchemy` package in `<nodeModules>/alchemy`, with the bin layout of the real one. */
function writeAlchemy(
  nodeModules: string,
  manifest: object = { bin: { alchemy: './bin/cli.js' } },
) {
  const packageDir = path.join(nodeModules, 'alchemy');
  writeJson(path.join(packageDir, 'package.json'), { name: 'alchemy', ...manifest });
  const entry = path.join(packageDir, 'bin', 'cli.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  return { packageDir, entry };
}

/**
 * pnpm's isolated layout with hoisting off (`hoist-pattern=`): the app links
 * @prisma/composer and @prisma/composer-cli, each package's real files sit
 * in its own store directory beside its direct dependencies only, and there
 * is no `node_modules/.pnpm/node_modules` and no root `alchemy`.
 */
function strictPnpmApp(): { appDir: string; composerStore: string } {
  const appDir = makeTmpDir();
  writeJson(path.join(appDir, 'package.json'), { name: 'app' });
  const pnpmDir = path.join(appDir, 'node_modules', '.pnpm');
  const composerStore = path.join(pnpmDir, '@prisma+composer@0.26.0', 'node_modules');
  const cliStore = path.join(pnpmDir, '@prisma+composer-cli@0.26.0', 'node_modules');
  for (const [store, name] of [
    [composerStore, 'composer'],
    [cliStore, 'composer-cli'],
  ] as const) {
    const real = path.join(store, '@prisma', name);
    writeComposer(real);
    const link = path.join(appDir, 'node_modules', '@prisma', name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link, 'dir');
  }
  return { appDir, composerStore };
}

function expectBinMissing(run: () => unknown, message?: string): void {
  expect(run).toThrow(
    expect.objectContaining({
      code: 'DEPLOY.ALCHEMY_BIN_MISSING',
      ...(message === undefined ? {} : { message: expect.stringContaining(message) }),
    }),
  );
}

describe('resolveAlchemyBin()', () => {
  test('is the bin of the alchemy beside the app’s @prisma/composer, under pnpm with hoisting off', () => {
    const { appDir, composerStore } = strictPnpmApp();
    const { entry } = writeAlchemy(composerStore);

    expect(resolveAlchemyBin(appDir)).toBe(entry);
    expect(fs.existsSync(path.join(appDir, 'node_modules', '.pnpm', 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(appDir, 'node_modules', 'alchemy'))).toBe(false);
  });

  test('walks up from @prisma/composer to a hoisted alchemy', () => {
    const appDir = makeTmpDir();
    writeComposer(path.join(appDir, 'node_modules', '@prisma', 'composer'));
    const { entry } = writeAlchemy(path.join(appDir, 'node_modules'));

    expect(resolveAlchemyBin(appDir)).toBe(entry);
  });

  test('reads a bin given as a string', () => {
    const { appDir, composerStore } = strictPnpmApp();
    const { entry } = writeAlchemy(composerStore, { bin: './bin/cli.js' });

    expect(resolveAlchemyBin(appDir)).toBe(entry);
  });

  test('raises DEPLOY.ALCHEMY_BIN_MISSING when the app cannot resolve @prisma/composer', () => {
    const appDir = makeTmpDir();
    writeAlchemy(path.join(appDir, 'node_modules'));

    expectBinMissing(() => resolveAlchemyBin(appDir), '@prisma/composer');
  });

  test('raises DEPLOY.ALCHEMY_BIN_MISSING when no alchemy is installed beside @prisma/composer', () => {
    const { appDir } = strictPnpmApp();

    expectBinMissing(() => resolveAlchemyBin(appDir), 'alchemy');
  });

  test('raises DEPLOY.ALCHEMY_BIN_MISSING, not a raw error, when the app directory does not exist', () => {
    expectBinMissing(() => resolveAlchemyBin(path.join(makeTmpDir(), 'missing')));
  });

  for (const [label, manifest] of [
    ['a bin object without an alchemy key', { bin: { other: './bin/cli.js' } }],
    ['a bin that names a missing file', { bin: { alchemy: './bin/missing.js' } }],
  ] as const) {
    test(`raises DEPLOY.ALCHEMY_BIN_MISSING for ${label}`, () => {
      const { appDir, composerStore } = strictPnpmApp();
      writeAlchemy(composerStore, manifest);

      expectBinMissing(() => resolveAlchemyBin(appDir));
    });
  }

  for (const [label, breakManifest] of [
    ['a malformed manifest', (file: string) => fs.writeFileSync(file, '{ "name": "alchemy",')],
    [
      'an unreadable manifest',
      (file: string) => {
        fs.rmSync(file);
        fs.mkdirSync(file);
      },
    ],
  ] as const) {
    test(`raises DEPLOY.ALCHEMY_BIN_MISSING, not a raw error, for ${label}`, () => {
      const { appDir, composerStore } = strictPnpmApp();
      const { packageDir } = writeAlchemy(composerStore);
      breakManifest(path.join(packageDir, 'package.json'));

      expectBinMissing(() => resolveAlchemyBin(appDir));
    });
  }

  test('resolves the alchemy installed with a workspace app', () => {
    const appDir = path.join(import.meta.dir, '../../../../../../examples/orm-demo');
    expect(fs.existsSync(path.join(appDir, 'package.json'))).toBe(true);

    const entry = resolveAlchemyBin(appDir);

    expect(path.basename(path.dirname(path.dirname(entry)))).toBe('alchemy');
    expect(fs.existsSync(entry)).toBe(true);
  });
});
