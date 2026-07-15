import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble, standaloneServerPath } from '../control.ts';
import nextjs from '../index.ts';

const tmpDirs: string[] = [];

/** A fresh tmp root standing in for a Next app: src/service.ts, .next/standalone/<deep>, .next/static, public. */
function makeAppRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-nextjs-assemble-'));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function moduleUrl(root: string): string {
  return pathToFileURL(path.join(root, 'src', 'service.ts')).href;
}

/**
 * Writes a `next build` standalone tree with the app nested at `apps/web` (the
 * monorepo shape — `outputFileTracingRoot` above the app) plus the client assets
 * Next omits: `.next/static` and `public/` live at the app root, NOT in
 * standalone. Returns the deep app-relative path.
 */
function writeNextBuild(root: string): { appRel: string } {
  const standalone = path.join(root, '.next', 'standalone');
  const appOut = path.join(standalone, 'apps', 'web');
  fs.mkdirSync(appOut, { recursive: true });
  fs.writeFileSync(path.join(appOut, 'server.js'), '// standalone server\n');
  fs.mkdirSync(path.join(standalone, 'node_modules', 'next'), { recursive: true });
  fs.writeFileSync(path.join(standalone, 'node_modules', 'next', 'marker.txt'), 'next\n');
  // Client assets — omitted from standalone by Next, at the app root.
  fs.mkdirSync(path.join(root, '.next', 'static'), { recursive: true });
  fs.writeFileSync(path.join(root, '.next', 'static', 'chunk.js'), '// static asset\n');
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'favicon.ico'), 'icon\n');
  fs.writeFileSync(
    path.join(root, 'src', 'service.ts'),
    'export default { hello: "wrap" as const };\n',
  );
  return { appRel: path.join('apps', 'web') };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('assemble()', () => {
  test('rejects a non-nextjs build adapter', async () => {
    const root = makeAppRoot();
    await expect(
      assemble({
        address: 'web',
        cwd: root,
        build: {
          extension: '@prisma/compose/node',
          type: 'node',
          module: moduleUrl(root),
          entry: 'server.js',
        },
      }),
    ).rejects.toThrow(/expected a "nextjs" build adapter/);
  });

  test('rejects when there is no standalone build — says run next build', async () => {
    const root = makeAppRoot();
    await expect(
      assemble({
        address: 'web',
        cwd: root,
        build: nextjs({ module: moduleUrl(root), appDir: '..' }),
      }),
    ).rejects.toThrow(/no .*standalone under .* run `next build`/);
  });

  test('ships the standalone tree, copies static/public to the located app dir, main.mjs at root', async () => {
    const root = makeAppRoot();
    const { appRel } = writeNextBuild(root);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-nextjs-cwd-'));
    tmpDirs.push(cwd);

    const result = await assemble({
      address: 'storefront.web',
      cwd,
      build: nextjs({ module: moduleUrl(root), appDir: '..' }),
    });

    const workDir = path.join(cwd, '.prisma-compose', 'artifacts', 'storefront.web');
    const bundleApp = path.join(workDir, 'bundle', appRel);
    expect(result.dir).toBe(workDir);
    // The deep server path was FOUND, not authored, and prefixed with bundle/.
    expect(result.entry).toBe('bundle/apps/web/server.js');
    expect(fs.existsSync(path.join(workDir, 'main.mjs'))).toBe(true);
    // Standalone tree shipped (incl. the hoisted node_modules at its root).
    expect(fs.existsSync(path.join(bundleApp, 'server.js'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'bundle', 'node_modules', 'next', 'marker.txt'))).toBe(
      true,
    );
    // The documented copy: static + public placed beside the app's server.js.
    expect(fs.existsSync(path.join(bundleApp, '.next', 'static', 'chunk.js'))).toBe(true);
    expect(fs.existsSync(path.join(bundleApp, 'public', 'favicon.ico'))).toBe(true);
    // We never wrote into the user's build output.
    expect(fs.existsSync(path.join(root, '.next', 'standalone', 'main.mjs'))).toBe(false);
  }, 20_000);

  test('standaloneServerPath locates the app server.js (the integration-test seam)', () => {
    const root = makeAppRoot();
    writeNextBuild(root);
    const server = standaloneServerPath(nextjs({ module: moduleUrl(root), appDir: '..' }));
    expect(server).toBe(path.join(root, '.next', 'standalone', 'apps', 'web', 'server.js'));
  });
});
