/** Which app files an entry import loaded, under Bun (this runner) and under Node (a spawned process). */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordAppFiles } from '../entry-resolution.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An app whose entry imports a sibling statically, a sub-module through a `tsconfig` path, a file dynamically, and a package in `node_modules`. */
function appDir(paths: boolean): { dir: string; entry: string; expected: string[] } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-record-files-')));
  dirs.push(dir);
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write('package.json', JSON.stringify({ name: 'app', type: 'module' }));
  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@sub/*': ['modules/*'] } } }),
  );
  write(
    'node_modules/dep/package.json',
    JSON.stringify({ name: 'dep', type: 'module', exports: './index.js' }),
  );
  write('node_modules/dep/index.js', 'export const dep = 1;\n');
  write('service.ts', "export const service = 'service';\n");
  write('modules/catalog/module.ts', "export const catalog = 'catalog';\n");
  write('lazy.ts', "export const lazy = 'lazy';\n");
  write(
    'entry.ts',
    [
      "import { service } from './service.ts';",
      paths
        ? "import { catalog } from '@sub/catalog/module.ts';"
        : "import { catalog } from './modules/catalog/module.ts';",
      "import { dep } from 'dep';",
      "const { lazy } = await import('./lazy.ts');",
      'export default [service, catalog, dep, lazy];',
      '',
    ].join('\n'),
  );
  return {
    dir,
    entry: path.join(dir, 'entry.ts'),
    expected: ['entry.ts', 'service.ts', 'modules/catalog/module.ts', 'lazy.ts']
      .map((file) => path.join(dir, file))
      .sort(),
  };
}

describe('recordAppFiles()', () => {
  test('under Bun: static, tsconfig-path and dynamic imports, and nothing in node_modules', async () => {
    const app = appDir(true);

    const { value, files } = await recordAppFiles(() => import(pathToFileURL(app.entry).href));

    expect((value as { default: unknown[] }).default).toEqual(['service', 'catalog', 1, 'lazy']);
    expect([...files].sort()).toEqual(app.expected);
  });

  test('under Node: static and dynamic imports, and nothing in node_modules', () => {
    const app = appDir(false);
    const script = path.join(app.dir, 'record.mjs');
    fs.writeFileSync(
      script,
      [
        `import { recordAppFiles } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, '..', 'entry-resolution.ts')).href)};`,
        `const { files } = await recordAppFiles(() => import(${JSON.stringify(pathToFileURL(app.entry).href)}));`,
        'console.log(JSON.stringify(files));',
      ].join('\n'),
    );

    const result = spawnSync('node', [script], { encoding: 'utf8' });

    expect(result.stderr).not.toContain('Error');
    expect(JSON.parse(result.stdout).sort()).toEqual(app.expected);
  });
});
