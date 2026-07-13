import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble } from '../control.ts';
import nextjs from '../index.ts';

const tmpDirs: string[] = [];

/** A fresh tmp root holding an authoring module and (optionally) a standalone tree. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-nextjs-assemble-'));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

/** The authoring module's import.meta.url for a root's src/service.ts. */
function moduleUrl(root: string): string {
  return pathToFileURL(path.join(root, 'src', 'service.ts')).href;
}

/**
 * Writes a finished, flat standalone tree with the app nested at `apps/web`
 * (the datahub shape — NOT the 4-levels-up layout the old adapter assumed) and
 * the hoisted node_modules + client assets already copied in, as the user's
 * build is now responsible for producing.
 */
function writeStandalone(root: string): { standaloneRel: string; entry: string } {
  const standalone = path.join(root, '.next', 'standalone');
  const appOut = path.join(standalone, 'apps', 'web');
  fs.mkdirSync(appOut, { recursive: true });
  fs.writeFileSync(path.join(appOut, 'server.js'), '// standalone server\n');
  fs.mkdirSync(path.join(appOut, '.next', 'static'), { recursive: true });
  fs.writeFileSync(path.join(appOut, '.next', 'static', 'chunk.js'), '// static asset\n');
  fs.mkdirSync(path.join(appOut, 'public'), { recursive: true });
  fs.writeFileSync(path.join(appOut, 'public', 'favicon.ico'), 'icon\n');
  fs.mkdirSync(path.join(standalone, 'node_modules', 'next'), { recursive: true });
  fs.writeFileSync(path.join(standalone, 'node_modules', 'next', 'marker.txt'), 'next\n');
  return { standaloneRel: '../.next/standalone', entry: 'apps/web/server.js' };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('assemble()', () => {
  test('rejects a non-nextjs build adapter', async () => {
    const root = makeRoot();
    await expect(
      assemble({
        address: 'web',
        cwd: root,
        // A "node" build reaching here at all would only happen through the
        // untyped registry seam (the config routes by (extension, type) before
        // calling in) — forced here to exercise the runtime guard.
        build: {
          extension: '@prisma/compose/node',
          type: 'node',
          module: moduleUrl(root),
          entry: 'server.js',
        },
      }),
    ).rejects.toThrow(/expected a "nextjs" build adapter/);
  });

  test('rejects when the standalone entry is missing — names the expected path and says run next build', async () => {
    const root = makeRoot();
    await expect(
      assemble({
        address: 'web',
        cwd: root,
        build: nextjs({
          module: moduleUrl(root),
          standalone: '../.next/standalone',
          entry: 'apps/web/server.js',
        }),
      }),
    ).rejects.toThrow(/no standalone apps\/web\/server\.js at .* run `next build`/);
  });

  test('copies the user standalone tree under bundle/, adds main.mjs at the root, writes bunfig, no derivation', async () => {
    const root = makeRoot();
    const { standaloneRel, entry } = writeStandalone(root);
    fs.writeFileSync(
      path.join(root, 'src', 'service.ts'),
      'export default { hello: "wrapper" as const };\n',
    );

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-nextjs-cwd-'));
    tmpDirs.push(cwd);
    const result = await assemble({
      address: 'storefront.web',
      cwd,
      build: nextjs({ module: moduleUrl(root), standalone: standaloneRel, entry }),
    });

    const workDir = path.join(cwd, '.prisma-compose', 'artifacts', 'storefront.web');
    // The artifact is our stuff at the root, the user's tree under bundle/.
    expect(result.dir).toBe(workDir);
    expect(result.entry).toBe('bundle/apps/web/server.js');
    expect(fs.existsSync(path.join(workDir, 'main.mjs'))).toBe(true);
    expect(fs.readFileSync(path.join(workDir, 'bunfig.toml'), 'utf8')).toContain(
      'auto = "disable"',
    );
    // The whole standalone tree came across verbatim — we did not complete or
    // rearrange it (the user's build already did static/public/node_modules).
    expect(fs.existsSync(path.join(workDir, 'bundle', 'apps', 'web', 'server.js'))).toBe(true);
    expect(
      fs.existsSync(path.join(workDir, 'bundle', 'apps', 'web', '.next', 'static', 'chunk.js')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(workDir, 'bundle', 'apps', 'web', 'public', 'favicon.ico')),
    ).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'bundle', 'node_modules', 'next', 'marker.txt'))).toBe(
      true,
    );
    // We never wrote into the user's build output.
    expect(fs.existsSync(path.join(root, '.next', 'standalone', 'main.mjs'))).toBe(false);
  }, 20_000);
});
