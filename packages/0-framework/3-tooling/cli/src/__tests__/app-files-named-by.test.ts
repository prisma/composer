import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appFilesNamedBy } from '../entry-resolution.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function appDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-named-by-')));
  dirs.push(dir);
  return dir;
}

const candidates = (dir: string, base: string): string[] =>
  ['.ts', '.mts', '.tsx', '/index.ts'].map((suffix) => path.join(dir, `${base}${suffix}`));

describe('appFilesNamedBy()', () => {
  test('a missing extensionless import names every file the resolve hook would try', () => {
    const dir = appDir();
    const error = { url: pathToFileURL(path.join(dir, 'helpers')).href };

    expect(appFilesNamedBy(error)).toEqual([
      path.join(dir, 'helpers'),
      ...candidates(dir, 'helpers'),
    ]);
  });

  test('a missing .js import, in the shape Bun reports it, names the .js file and its TypeScript sources', () => {
    const dir = appDir();
    const error = {
      cause: { specifier: './lib/helpers.js', referrer: path.join(dir, 'label.ts') },
    };

    expect(appFilesNamedBy(error)).toEqual([
      path.join(dir, 'lib', 'helpers.js'),
      ...candidates(path.join(dir, 'lib'), 'helpers'),
    ]);
  });

  test('a file that exists but does not parse is named alone', () => {
    const dir = appDir();
    const file = path.join(dir, 'label.ts');
    fs.writeFileSync(file, 'export const label = ;\n');

    expect(appFilesNamedBy({ position: { file } })).toEqual([file]);
  });

  test('a cause chain that loops ends', () => {
    const error: { cause?: unknown } = {};
    error.cause = { cause: error };

    expect(appFilesNamedBy(error)).toEqual([]);
  });

  test('a file URL that names no local file is skipped, and its cause still read', () => {
    const dir = appDir();
    const error = {
      url: 'file:///lib%2Fhelpers.ts',
      cause: { specifier: './helpers.ts', referrer: 'file:///lib%2Flabel.ts' },
    };
    const outer = { cause: error, url: pathToFileURL(path.join(dir, 'x.ts')).href };

    expect(appFilesNamedBy(error)).toEqual([]);
    expect(appFilesNamedBy(outer)[0]).toBe(path.join(dir, 'x.ts'));
  });

  test('a missing import that already has a TypeScript extension is named alone', () => {
    const dir = appDir();
    const error = { specifier: './helpers.ts', referrer: path.join(dir, 'label.ts') };

    expect(appFilesNamedBy(error)).toEqual([path.join(dir, 'helpers.ts')]);
  });

  describe('an import that names an existing directory names the index file inside it, never the directory', () => {
    function appWithLib(): { readonly dir: string; readonly app: string } {
      const dir = appDir();
      const app = path.join(dir, 'app');
      fs.mkdirSync(path.join(app, 'lib'), { recursive: true });
      return { dir, app };
    }

    const nodeShape = (directory: string) => ({
      code: 'ERR_UNSUPPORTED_DIR_IMPORT',
      url: `${pathToFileURL(directory).href}/`,
    });
    const bunShape = (app: string, specifier: string) => ({
      cause: { specifier, referrer: path.join(app, 'label.ts') },
    });

    const cases = [
      ['./lib', (_dir: string, app: string) => path.join(app, 'lib')],
      ['./', (_dir: string, app: string) => app],
      ['..', (dir: string) => dir],
    ] as const;

    for (const [specifier, directoryOf] of cases) {
      for (const shape of ['Node', 'Bun'] as const) {
        test(`${specifier}, as ${shape} reports it`, () => {
          const { dir, app } = appWithLib();
          const directory = directoryOf(dir, app);
          const error = shape === 'Node' ? nodeShape(directory) : bunShape(app, specifier);

          const named = appFilesNamedBy(error);

          expect(named).toEqual([path.join(directory, 'index.ts')]);
          for (const file of named) {
            expect(fs.existsSync(file) && fs.statSync(file).isDirectory()).toBe(false);
          }
        });
      }
    }
  });

  test('a file in node_modules is not an app file', () => {
    const dir = appDir();
    const error = { url: pathToFileURL(path.join(dir, 'node_modules', 'dep', 'x.js')).href };

    expect(appFilesNamedBy(error)).toEqual([]);
  });
});
