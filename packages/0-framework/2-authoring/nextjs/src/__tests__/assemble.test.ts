import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble, nextStandaloneDir } from '../control.ts';
import nextjs from '../index.ts';

const tmpDirs: string[] = [];

/** A 4-levels-deep app dir under a fresh tmp root — mirrors the monorepo
 * layout nextStandaloneDir assumes (workspaceRoot = 4 levels up). */
function makeAppDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-nextjs-assemble-'));
  tmpDirs.push(root);
  const appDir = path.join(root, 'a', 'b', 'c', 'app');
  fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
  return appDir;
}

/** The authoring module's import.meta.url for an app dir's src/service.ts. */
function moduleUrl(appDir: string): string {
  return pathToFileURL(path.join(appDir, 'src', 'service.ts')).href;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('assemble()', () => {
  test('rejects a non-nextjs build adapter', async () => {
    const appDir = makeAppDir();
    await expect(
      assemble({
        // A "node" build reaching here at all would only happen through the
        // untyped registry seam (the config routes by (extension, type)
        // before calling in) — forced here to exercise the runtime guard.
        build: {
          extension: '@prisma/compose/node',
          type: 'node',
          module: moduleUrl(appDir),
          entry: 'server.js',
        },
      }),
    ).rejects.toThrow(/expected a "nextjs" build adapter/);
  });

  test('rejects when the standalone server.js is missing — names the expected path', async () => {
    const appDir = makeAppDir();
    await expect(
      assemble({
        build: nextjs({ module: moduleUrl(appDir), appDir: '..', entry: 'server.js' }),
      }),
    ).rejects.toThrow(/no standalone server\.js at .* run `next build`/);
  });

  test('copies static/public/node_modules, writes bunfig.toml, and bundles the wrapper', async () => {
    const appDir = makeAppDir();
    const standaloneDir = nextStandaloneDir(appDir);
    fs.mkdirSync(standaloneDir, { recursive: true });
    fs.writeFileSync(path.join(standaloneDir, 'server.js'), '// standalone server\n');

    // Next's hoisted root node_modules, shared by every app in the standalone tree.
    const standaloneRoot = path.join(appDir, '.next', 'standalone');
    fs.mkdirSync(path.join(standaloneRoot, 'node_modules', 'next'), { recursive: true });
    fs.writeFileSync(path.join(standaloneRoot, 'node_modules', 'next', 'marker.txt'), 'next\n');

    fs.mkdirSync(path.join(appDir, '.next', 'static'), { recursive: true });
    fs.writeFileSync(path.join(appDir, '.next', 'static', 'chunk.js'), '// static asset\n');
    fs.mkdirSync(path.join(appDir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'public', 'favicon.ico'), 'icon\n');

    fs.writeFileSync(
      path.join(appDir, 'src', 'service.ts'),
      'export default { hello: "wrapper" as const };\n',
    );

    const result = await assemble({
      build: nextjs({ module: moduleUrl(appDir), appDir: '..', entry: 'server.js' }),
    });

    expect(result.dir).toBe(standaloneDir);
    expect(result.entry).toBe('server.js');
    expect(fs.existsSync(path.join(standaloneDir, 'main.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(standaloneDir, 'node_modules', 'next', 'marker.txt'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(standaloneDir, '.next', 'static', 'chunk.js'))).toBe(true);
    expect(fs.existsSync(path.join(standaloneDir, 'public', 'favicon.ico'))).toBe(true);
    expect(fs.readFileSync(path.join(standaloneDir, 'bunfig.toml'), 'utf8')).toContain(
      'auto = "disable"',
    );
  }, 20_000);
});

describe('nextStandaloneDir()', () => {
  test('nests the app dir path under .next/standalone, pinned to the 4-levels-up workspace root', () => {
    const appDir = makeAppDir();
    const dir = nextStandaloneDir(appDir);
    expect(dir.startsWith(path.join(appDir, '.next', 'standalone'))).toBe(true);
    expect(dir.endsWith(path.join('a', 'b', 'c', 'app'))).toBe(true);
  });
});
