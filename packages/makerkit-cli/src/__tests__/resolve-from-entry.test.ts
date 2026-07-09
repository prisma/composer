import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli-error.ts';
import { importFromEntry } from '../resolve-from-entry.ts';

const tmpDirs: string[] = [];

/** A throwaway app package dir with an entry FILE (need not exist on disk — createRequire only needs its dirname). */
function makeEntryPath(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'makerkit-cli-resolve-')));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
  return path.join(dir, 'service.ts');
}

function writeFixturePack(
  entryDir: string,
  pack: string,
  subpath: string,
  moduleSource: string,
): void {
  const packDir = path.join(entryDir, 'node_modules', pack);
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'package.json'),
    JSON.stringify({
      name: pack,
      type: 'module',
      exports: { [`./${subpath}`]: `./${subpath}.ts` },
    }),
  );
  fs.writeFileSync(path.join(packDir, `${subpath}.ts`), moduleSource);
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('importFromEntry() — entry-anchored resolution', () => {
  test('resolves and imports a fixture pack’s subpath entry declared via package.json exports', async () => {
    const entryPath = makeEntryPath();
    writeFixturePack(
      path.dirname(entryPath),
      'fixture-pack',
      'target',
      "export function fromEnv() { return 'ok'; }\n",
    );

    const mod = await importFromEntry(entryPath, 'fixture-pack', 'target');

    expect(
      typeof mod === 'object' &&
        mod !== null &&
        'fromEnv' in mod &&
        typeof mod.fromEnv === 'function'
        ? mod.fromEnv()
        : undefined,
    ).toBe('ok');
  });

  test('walks up to a parent directory’s node_modules, like Node/bun module resolution', async () => {
    const entryPath = makeEntryPath();
    const entryDir = path.dirname(entryPath);
    writeFixturePack(
      entryDir,
      'fixture-pack',
      'assemble',
      "export function assemble() { return 'assembled'; }\n",
    );
    const nestedDir = path.join(entryDir, 'nested', 'deeper');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'package.json'), JSON.stringify({ name: 'nested-app' }));
    const nestedEntryPath = path.join(nestedDir, 'service.ts');

    const mod = await importFromEntry(nestedEntryPath, 'fixture-pack', 'assemble');

    expect(
      typeof mod === 'object' &&
        mod !== null &&
        'assemble' in mod &&
        typeof mod.assemble === 'function'
        ? mod.assemble()
        : undefined,
    ).toBe('assembled');
  });

  test('a missing pack throws a CliError naming the pack, the entry dir, and the fix', async () => {
    const entryPath = makeEntryPath();
    const entryDir = path.dirname(entryPath);

    await expect(importFromEntry(entryPath, '@makerkit/does-not-exist', 'target')).rejects.toThrow(
      CliError,
    );
    await expect(importFromEntry(entryPath, '@makerkit/does-not-exist', 'target')).rejects.toThrow(
      new RegExp(
        `Cannot resolve "@makerkit/does-not-exist/target" from ${entryDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — the app's package \\(the one containing the entry module\\) must depend on "@makerkit/does-not-exist"`,
      ),
    );
  });

  // The runtimes report this differently (node: ERR_PACKAGE_PATH_NOT_EXPORTED,
  // bun: MODULE_NOT_FOUND), so the assertion is runtime-agnostic: a CliError
  // naming the pack, whichever branch produced it.
  test('a pack present but missing the requested subpath export throws a CliError naming the pack', async () => {
    const entryPath = makeEntryPath();
    const packDir = path.join(path.dirname(entryPath), 'node_modules', 'fixture-pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(
      path.join(packDir, 'package.json'),
      JSON.stringify({ name: 'fixture-pack', type: 'module', exports: { '.': './index.ts' } }),
    );
    fs.writeFileSync(path.join(packDir, 'index.ts'), 'export {};\n');

    await expect(importFromEntry(entryPath, 'fixture-pack', 'target')).rejects.toThrow(CliError);
    await expect(importFromEntry(entryPath, 'fixture-pack', 'target')).rejects.toThrow(
      /"?fixture-pack"?/,
    );
  });
});
