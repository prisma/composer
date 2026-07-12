import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble } from '../control.ts';

const tmpDirs: string[] = [];

/** A tmp dir standing in for a service package: src/service.ts + a dist/ sibling. */
function makeServiceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-node-assemble-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

/** The authoring module's import.meta.url for a service dir's src/service.ts (need not exist on disk unless the test writes it). */
function moduleUrl(serviceDir: string): string {
  return pathToFileURL(path.join(serviceDir, 'src', 'service.ts')).href;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('assemble()', () => {
  test('rejects a non-node build adapter', async () => {
    const serviceDir = makeServiceDir();
    await expect(
      assemble({
        build: {
          extension: '@prisma/compose/nextjs',
          type: 'nextjs',
          module: moduleUrl(serviceDir),
          entry: 'server.js',
        },
      }),
    ).rejects.toThrow(/expected a "node" build adapter/);
  });

  test('rejects when the declared build entry is missing — names the expected path', async () => {
    const serviceDir = makeServiceDir();
    await expect(
      assemble({
        build: {
          extension: '@prisma/compose/node',
          type: 'node',
          module: moduleUrl(serviceDir),
          entry: '../dist/server.js',
        },
      }),
    ).rejects.toThrow(/no built entry at .*dist\/server\.js/);
  });

  test('rejects an app entry named main.js — reserved for the wrapper', async () => {
    const serviceDir = makeServiceDir();
    fs.mkdirSync(path.join(serviceDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'dist', 'main.js'), 'export {};\n');
    await expect(
      assemble({
        build: {
          extension: '@prisma/compose/node',
          type: 'node',
          module: moduleUrl(serviceDir),
          entry: '../dist/main.js',
        },
      }),
    ).rejects.toThrow(/reserved for the Prisma App wrapper/);
  });

  test('rejects an entry that resolves to the reserved bundle output dir itself (F04)', async () => {
    // `bundleDir` is computed as `dirname(entryPath)/bundle` — an entry whose
    // own resolved basename is "bundle" makes bundleDir fold back onto
    // entryPath exactly (e.g. a build tool that names its output file/dir
    // "bundle"), so the guard must catch entryPath === bundleDir before the
    // rm-then-copy sequence would delete the entry out from under itself.
    const serviceDir = makeServiceDir();
    fs.mkdirSync(path.join(serviceDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'dist', 'bundle'), 'export {};\n');
    await expect(
      assemble({
        build: {
          extension: '@prisma/compose/node',
          type: 'node',
          module: moduleUrl(serviceDir),
          entry: '../dist/bundle',
        },
      }),
    ).rejects.toThrow(/resolves inside its own output dir/);
  });

  test('produces a bundle dir (beside the built entry) containing the wrapper and a copy of the built entry', async () => {
    const serviceDir = makeServiceDir();
    fs.mkdirSync(path.join(serviceDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'dist', 'server.js'), 'export default "app-entry";\n');
    fs.writeFileSync(
      path.join(serviceDir, 'src', 'service.ts'),
      'export default { hello: "wrapper" as const };\n',
    );

    const result = await assemble({
      build: {
        extension: '@prisma/compose/node',
        type: 'node',
        module: moduleUrl(serviceDir),
        entry: '../dist/server.js',
      },
    });

    expect(result.dir).toBe(path.join(serviceDir, 'dist', 'bundle'));
    expect(result.entry).toBe('server.js');
    expect(fs.existsSync(path.join(result.dir, 'server.js'))).toBe(true);
    const hasWrapper =
      fs.existsSync(path.join(result.dir, 'main.js')) ||
      fs.existsSync(path.join(result.dir, 'main.mjs'));
    expect(hasWrapper).toBe(true);
    // The copied entry is untouched — same module instance as the user's build.
    expect(fs.readFileSync(path.join(result.dir, 'server.js'), 'utf8')).toContain('app-entry');
  }, 20_000);
});
