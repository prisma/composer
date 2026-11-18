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
      url: 'file://server/share/helpers.ts',
      cause: { specifier: './helpers.ts', referrer: 'file://server/share/label.ts' },
    };
    const outer = { cause: error, url: pathToFileURL(path.join(dir, 'x.ts')).href };

    expect(appFilesNamedBy(error)).toEqual([]);
    expect(appFilesNamedBy(outer)[0]).toBe(path.join(dir, 'x.ts'));
  });

  test('a file in node_modules is not an app file', () => {
    const dir = appDir();
    const error = { url: pathToFileURL(path.join(dir, 'node_modules', 'dep', 'x.js')).href };

    expect(appFilesNamedBy(error)).toEqual([]);
  });
});
