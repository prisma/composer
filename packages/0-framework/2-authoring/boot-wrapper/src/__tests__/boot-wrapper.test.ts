import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBootWrapper } from '../exports/index.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
}

function fixturePackage(name: string, source: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
    }),
    [`node_modules/${name}/index.js`]: source,
  };
}

/** Builds a wrapper from `service`, a service module that may import the fixture ORM and a plain package, and imports it. */
async function buildAndImport(
  service: string,
): Promise<{ wrapper: string; module: Record<string, unknown> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-boot-wrapper-'));
  tmpDirs.push(dir);
  writeTree(dir, {
    ...fixturePackage(
      '@prisma/orm-runtime-fixture',
      [
        'globalThis.ormFixtureLoaded = true;',
        'export default function createClient() { return "client"; }',
        'export function contractFromJson() { return "contract"; }',
      ].join('\n'),
    ),
    ...fixturePackage('plain-dep', 'export const marker = "PLAIN_DEP_INLINED";\n'),
    'src/service.ts': service,
  });
  const outdir = path.join(dir, 'out');
  await buildBootWrapper(path.join(dir, 'src', 'service.ts'), outdir);
  const mainFile = path.join(outdir, 'main.mjs');
  return {
    wrapper: fs.readFileSync(mainFile, 'utf8'),
    module: await import(pathToFileURL(mainFile).href),
  };
}

describe('buildBootWrapper()', () => {
  test('leaves Prisma ORM out of the wrapper and inlines every other package', async () => {
    Reflect.deleteProperty(globalThis, 'ormFixtureLoaded');
    const { wrapper, module } = await buildAndImport(
      [
        "import createClient, { contractFromJson } from '@prisma/orm-runtime-fixture';",
        "import { marker } from 'plain-dep';",
        'export const plain = marker;',
        'export const useDefault = () => createClient();',
        'export const useNamed = () => contractFromJson();',
      ].join('\n'),
    );

    expect(wrapper).toContain('PLAIN_DEP_INLINED');
    expect(wrapper).not.toContain('ormFixtureLoaded');
    expect(Reflect.get(globalThis, 'ormFixtureLoaded')).toBeUndefined();
    expect(module['plain']).toBe('PLAIN_DEP_INLINED');
  }, 20_000);

  test('a wrapper that uses a Prisma ORM export fails loudly, naming the export and the package', async () => {
    const { module } = await buildAndImport(
      [
        "import createClient, { contractFromJson } from '@prisma/orm-runtime-fixture';",
        'export const useDefault = () => createClient();',
        'export const useNamed = () => contractFromJson();',
      ].join('\n'),
    );
    const useDefault = module['useDefault'];
    const useNamed = module['useNamed'];
    if (typeof useDefault !== 'function' || typeof useNamed !== 'function') {
      throw new Error('the fixture wrapper must export useDefault and useNamed');
    }

    expect(() => useNamed()).toThrow(
      /used "contractFromJson" from "@prisma\/orm-runtime-fixture", but the wrapper does not carry Prisma ORM/,
    );
    expect(() => useDefault()).toThrow(
      /used "default" from "@prisma\/orm-runtime-fixture", but the wrapper does not carry Prisma ORM/,
    );
  }, 20_000);

  test('an import that does not resolve fails the build and emits no main.mjs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-boot-wrapper-'));
    tmpDirs.push(dir);
    writeTree(dir, {
      'src/service.ts':
        "import { thing } from 'totally-unresolvable-package-xyz';\nexport default thing;\n",
    });
    const outdir = path.join(dir, 'out');

    await expect(buildBootWrapper(path.join(dir, 'src', 'service.ts'), outdir)).rejects.toThrow(
      /Could not resolve/,
    );
    expect(fs.existsSync(path.join(outdir, 'main.mjs'))).toBe(false);
  }, 20_000);
});
