import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble, standaloneServerPath } from '../exports/control.ts';
import nextjs from '../exports/index.ts';

const tmpDirs: string[] = [];

/** A fresh tmp root standing in for a Next app: src/service.ts, .next/standalone/<deep>, .next/static, public. */
function makeAppRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-nextjs-assemble-'));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function moduleUrl(root: string): string {
  return pathToFileURL(path.join(root, 'src', 'service.ts')).href;
}

/**
 * Writes a `next build` standalone tree with the app nested at `apps/web` (the
 * monorepo shape — `outputFileTracingRoot` above the app), plus the client assets
 * Next omits (`.next/static`, `public/` at the app root, NOT in standalone) and
 * the `required-server-files.json` manifest Next writes recording where it put
 * the app (`relativeAppDir`). Returns the deep app-relative path.
 */
function writeNextBuild(root: string): { appRel: string } {
  const standalone = path.join(root, '.next', 'standalone');
  const appOut = path.join(standalone, 'apps', 'web');
  fs.mkdirSync(appOut, { recursive: true });
  fs.writeFileSync(path.join(appOut, 'server.js'), '// standalone server\n');
  fs.mkdirSync(path.join(standalone, 'node_modules', 'next'), { recursive: true });
  fs.writeFileSync(path.join(standalone, 'node_modules', 'next', 'marker.txt'), 'next\n');
  fs.symlinkSync('next', path.join(standalone, 'node_modules', 'next-linked'));
  // Client assets — omitted from standalone by Next, at the app root.
  fs.mkdirSync(path.join(root, '.next', 'static'), { recursive: true });
  fs.writeFileSync(path.join(root, '.next', 'static', 'chunk.js'), '// static asset\n');
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'favicon.ico'), 'icon\n');
  // Next's manifest — records the app's subpath within standalone (posix).
  fs.writeFileSync(
    path.join(root, '.next', 'required-server-files.json'),
    JSON.stringify({
      relativeAppDir: 'apps/web',
      config: { outputFileTracingRoot: root },
    }),
  );
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
          extension: '@prisma/composer/node',
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
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-nextjs-cwd-'));
    tmpDirs.push(cwd);

    const result = await assemble({
      address: 'storefront.web',
      cwd,
      build: nextjs({ module: moduleUrl(root), appDir: '..' }),
    });

    const workDir = path.join(cwd, '.prisma-composer', 'artifacts', 'storefront.web');
    const bundleApp = path.join(workDir, 'bundle', appRel);
    expect(result.dir).toBe(workDir);
    // The deep server path came from Next's manifest (relativeAppDir), prefixed with bundle/.
    expect(result.entry).toBe('bundle/apps/web/server.js');
    expect(fs.existsSync(path.join(workDir, 'main.mjs'))).toBe(true);
    // Standalone tree shipped (incl. the hoisted node_modules at its root).
    expect(fs.existsSync(path.join(bundleApp, 'server.js'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'bundle', 'node_modules', 'next', 'marker.txt'))).toBe(
      true,
    );
    expect(fs.readlinkSync(path.join(workDir, 'bundle', 'node_modules', 'next-linked'))).toBe(
      'next',
    );
    // The documented copy: static + public placed beside the app's server.js.
    expect(fs.existsSync(path.join(bundleApp, '.next', 'static', 'chunk.js'))).toBe(true);
    expect(fs.existsSync(path.join(bundleApp, 'public', 'favicon.ico'))).toBe(true);
    // We never wrote into the user's build output.
    expect(fs.existsSync(path.join(root, '.next', 'standalone', 'main.mjs'))).toBe(false);
    // Bundle.watch names the standalone output dir (ADR-0041).
    expect(result.watch).toEqual([path.join(root, '.next', 'standalone')]);
  }, 20_000);

  test('standaloneServerPath locates the app server.js (the integration-test seam)', () => {
    const root = makeAppRoot();
    writeNextBuild(root);
    const server = standaloneServerPath(nextjs({ module: moduleUrl(root), appDir: '..' }));
    expect(server).toBe(path.join(root, '.next', 'standalone', 'apps', 'web', 'server.js'));
  });

  test('stages a pnpm virtual-store target that Next omitted behind a traced link', async () => {
    const root = makeAppRoot();
    writeNextBuild(root);
    const standalone = path.join(root, '.next', 'standalone');
    const source = path.join(
      root,
      'node_modules',
      '.pnpm',
      'semver@6.3.1',
      'node_modules',
      'semver',
    );
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = "6.3.1";\n');
    const linkDir = path.join(standalone, 'node_modules', '.pnpm', 'node_modules');
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync('../semver@6.3.1/node_modules/semver', path.join(linkDir, 'semver'));

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-nextjs-cwd-'));
    tmpDirs.push(cwd);
    const result = await assemble({
      address: 'storefront.web',
      cwd,
      build: nextjs({ module: moduleUrl(root), appDir: '..' }),
    });

    const bundleStore = path.join(
      cwd,
      '.prisma-composer',
      'artifacts',
      'storefront.web',
      'bundle',
      'node_modules',
      '.pnpm',
    );
    expect(fs.readlinkSync(path.join(bundleStore, 'node_modules', 'semver'))).toBe(
      '../semver@6.3.1/node_modules/semver',
    );
    expect(
      fs.readFileSync(
        path.join(bundleStore, 'semver@6.3.1', 'node_modules', 'semver', 'index.js'),
        'utf8',
      ),
    ).toContain('6.3.1');
    expect(result.watch).toContain(source);
  }, 20_000);

  test('refuses a manifest whose app location escapes its tracing root', async () => {
    const root = makeAppRoot();
    writeNextBuild(root);
    const manifestPath = path.join(root, '.next', 'required-server-files.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ relativeAppDir: '../evil', config: {} }));

    await expect(
      assemble({
        address: 'storefront.web',
        cwd: root,
        build: nextjs({ module: moduleUrl(root), appDir: '..' }),
      }),
    ).rejects.toThrow(/escapes its tracing root/);
  }, 20_000);

  test('names the missing manifest field when links need repair and no tracing root is recorded', async () => {
    const root = makeAppRoot();
    writeNextBuild(root);
    const standalone = path.join(root, '.next', 'standalone');
    const linkDir = path.join(standalone, 'node_modules', '.pnpm', 'node_modules');
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync('../semver@6.3.1/node_modules/semver', path.join(linkDir, 'semver'));
    const manifestPath = path.join(root, '.next', 'required-server-files.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ relativeAppDir: 'apps/web', config: {} }));

    await expect(
      assemble({
        address: 'storefront.web',
        cwd: root,
        build: nextjs({ module: moduleUrl(root), appDir: '..' }),
      }),
    ).rejects.toThrow(/records no config\.outputFileTracingRoot/);
  }, 20_000);

  test('fails at assemble when a staged store payload carries an escaping link', async () => {
    const root = makeAppRoot();
    writeNextBuild(root);
    const standalone = path.join(root, '.next', 'standalone');
    const source = path.join(
      root,
      'node_modules',
      '.pnpm',
      'semver@6.3.1',
      'node_modules',
      'semver',
    );
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = "6.3.1";\n');
    fs.writeFileSync(path.join(root, 'outside-the-bundle.txt'), 'must not ship');
    // Copied verbatim into the bundle by staging, where it points outside.
    fs.symlinkSync(path.join(root, 'outside-the-bundle.txt'), path.join(source, 'escaped.txt'));
    const linkDir = path.join(standalone, 'node_modules', '.pnpm', 'node_modules');
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync('../semver@6.3.1/node_modules/semver', path.join(linkDir, 'semver'));

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-nextjs-cwd-'));
    tmpDirs.push(cwd);

    await expect(
      assemble({
        address: 'storefront.web',
        cwd,
        build: nextjs({ module: moduleUrl(root), appDir: '..' }),
      }),
    ).rejects.toThrow(/assembled bundle contains a symlink whose target escapes the bundle/);
  }, 20_000);

  test('assembles a complete standalone build when its recorded tracing root is absent', async () => {
    const root = makeAppRoot();
    writeNextBuild(root);
    const manifestPath = path.join(root, '.next', 'required-server-files.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.config.outputFileTracingRoot = path.join(root, 'missing-build-machine-root');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = await assemble({
      address: 'storefront.web',
      cwd: root,
      build: nextjs({ module: moduleUrl(root), appDir: '..' }),
    });

    expect(fs.existsSync(path.join(result.dir, result.entry))).toBe(true);
  }, 20_000);
});
