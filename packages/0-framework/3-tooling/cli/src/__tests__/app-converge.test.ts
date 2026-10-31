import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliStructuredError } from '@internal/foundation/errors';
import { HOST_COMPOSER_VERSION, loadAppConverge } from '../app-converge.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An app whose node_modules holds a @prisma/composer with the given exports and entry source. */
function appWith(
  composer:
    | { exports: Record<string, string>; files: Record<string, string>; version?: string }
    | undefined,
) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-app-converge-')));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
  if (composer !== undefined) {
    const pkg = path.join(dir, 'node_modules', '@prisma', 'composer');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: '@prisma/composer',
        version: composer.version ?? HOST_COMPOSER_VERSION,
        type: 'module',
        exports: { ...composer.exports, './package.json': './package.json' },
      }),
    );
    for (const [file, source] of Object.entries(composer.files)) {
      fs.writeFileSync(path.join(pkg, file), source);
    }
  }
  return dir;
}

async function failureOf(dir: string): Promise<CliStructuredError> {
  try {
    await loadAppConverge(dir);
  } catch (error) {
    if (CliStructuredError.is(error)) return error;
    throw error;
  }
  throw new Error('expected loadAppConverge to fail');
}

describe('loadAppConverge', () => {
  test("loads lower and convergeInProcess from the app's own @prisma/composer", async () => {
    const dir = appWith({
      exports: { './internal/converge': './dist/internal-converge.mjs' },
      files: {
        'dist/internal-converge.mjs':
          "export const lower = () => {}; export const convergeInProcess = async () => ({ kind: 'applied' });",
      },
    });

    const engine = await loadAppConverge(dir);
    const stub = await import(
      pathToFileURL(path.join(dir, 'node_modules/@prisma/composer/dist/internal-converge.mjs')).href
    );

    expect(engine.lower).toBe(stub.lower);
    expect(engine.converge).toBe(stub.convergeInProcess);
  });

  test('an app without @prisma/composer is DEPS.CONVERGE_UNRESOLVABLE', async () => {
    const failure = await failureOf(appWith(undefined));

    expect(failure.code).toBe('DEPS.CONVERGE_UNRESOLVABLE');
    expect(failure.message).toContain('@prisma/composer/internal/converge does not resolve');
  });

  test('a @prisma/composer older than the in-process converge is DEPS.CONVERGE_UNRESOLVABLE', async () => {
    const failure = await failureOf(
      appWith({ exports: { './deploy': './dist/deploy.mjs' }, files: { 'dist/deploy.mjs': '' } }),
    );

    expect(failure.code).toBe('DEPS.CONVERGE_UNRESOLVABLE');
  });

  test('an entry that exports neither function is DEPS.CONVERGE_UNRESOLVABLE', async () => {
    const failure = await failureOf(
      appWith({
        exports: { './internal/converge': './dist/internal-converge.mjs' },
        files: { 'dist/internal-converge.mjs': 'export const other = 1;' },
      }),
    );

    expect(failure.message).toContain('exports no lower and convergeInProcess');
  });

  test("an app's @prisma/composer at another version is DEPS.CONVERGE_VERSION_MISMATCH, naming both versions", async () => {
    const failure = await failureOf(
      appWith({
        version: '0.0.1',
        exports: { './internal/converge': './dist/internal-converge.mjs' },
        files: {
          'dist/internal-converge.mjs':
            'export const lower = () => {}; export const convergeInProcess = async () => ({});',
        },
      }),
    );

    expect(failure.code).toBe('DEPS.CONVERGE_VERSION_MISMATCH');
    expect(failure.message).toContain('0.0.1');
    expect(failure.message).toContain(HOST_COMPOSER_VERSION);
    expect(failure.fix).toContain(`Install @prisma/composer ${HOST_COMPOSER_VERSION}`);
  });
});
