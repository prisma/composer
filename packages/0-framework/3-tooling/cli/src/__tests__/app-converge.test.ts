import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliStructuredError } from '@internal/foundation/errors';
import { HOST_COMPOSER_VERSION, loadAppConverge } from '../app-converge.ts';
import { CONVERGE_CONTRACT } from '../converge-contract.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An app whose node_modules holds a @prisma/composer with the given exports and entry source. */
function appWith(
  composer:
    | {
        exports: Record<string, string>;
        files: Record<string, string>;
        version?: string;
        /** The converge contract the install speaks; null for an install with no contract entry. */
        contract?: number | null;
      }
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
        exports: {
          ...composer.exports,
          ...(composer.contract === null
            ? {}
            : { './internal/converge-contract': './dist/contract.mjs' }),
          './package.json': './package.json',
        },
      }),
    );
    if (composer.contract !== null) {
      fs.writeFileSync(
        path.join(pkg, 'dist', 'contract.mjs'),
        `export const CONVERGE_CONTRACT = ${String(composer.contract ?? CONVERGE_CONTRACT)};`,
      );
    }
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

  const entry = {
    exports: { './internal/converge': './dist/internal-converge.mjs' },
    files: {
      'dist/internal-converge.mjs':
        "export const lower = () => {}; export const convergeInProcess = async () => ({ kind: 'applied' });",
    },
  };

  test("an app's @prisma/composer at another version that speaks the same contract loads", async () => {
    const engine = await loadAppConverge(appWith({ ...entry, version: '0.0.1' }));

    expect(typeof engine.converge).toBe('function');
  });

  test('an older contract is DEPS.CONVERGE_CONTRACT_MISMATCH, naming both contracts and versions, and says to upgrade the app', async () => {
    const failure = await failureOf(
      appWith({ ...entry, version: '0.0.1', contract: CONVERGE_CONTRACT - 1 }),
    );

    expect(failure.code).toBe('DEPS.CONVERGE_CONTRACT_MISMATCH');
    expect(failure.message).toBe(
      `The app's @prisma/composer 0.0.1 speaks converge contract ${String(CONVERGE_CONTRACT - 1)}, and the \`prisma\` CLI's Composer ${HOST_COMPOSER_VERSION} speaks contract ${String(CONVERGE_CONTRACT)}.`,
    );
    expect(failure.fix).toStartWith("Upgrade the app's @prisma/composer");
  });

  test('a newer contract says to upgrade the prisma CLI', async () => {
    const failure = await failureOf(
      appWith({ ...entry, version: '9.0.0', contract: CONVERGE_CONTRACT + 1 }),
    );

    expect(failure.code).toBe('DEPS.CONVERGE_CONTRACT_MISMATCH');
    expect(failure.fix).toStartWith('Upgrade the `prisma` CLI');
    expect(failure.fix).toContain('9.0.0');
  });

  test('an install with the converge but no contract entry is DEPS.CONVERGE_UNRESOLVABLE', async () => {
    const failure = await failureOf(appWith({ ...entry, contract: null }));

    expect(failure.code).toBe('DEPS.CONVERGE_UNRESOLVABLE');
  });
});
