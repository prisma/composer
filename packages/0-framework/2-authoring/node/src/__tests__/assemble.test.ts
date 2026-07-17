import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble } from '../control.ts';

const tmpDirs: string[] = [];

/** A tmp dir standing in for a service package: src/service.ts + a dist/ sibling. */
function makeServiceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-node-assemble-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

/** A tmp dir standing in for the deploy CLI's cwd — kept separate from the service package so staging-location assertions can't pass by accident. */
function makeCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-node-assemble-cwd-'));
  tmpDirs.push(dir);
  return dir;
}

/** The authoring module's import.meta.url for a service dir's src/service.ts. */
function moduleUrl(serviceDir: string): string {
  return pathToFileURL(path.join(serviceDir, 'src', 'service.ts')).href;
}

/**
 * Installs a real, resolvable package into the service dir's own node_modules,
 * so a bare specifier for it resolves the way it would in a real service
 * package. Returns a marker string the built wrapper contains iff the package
 * was inlined.
 */
function installFixturePackage(serviceDir: string, name: string): string {
  const marker = `INLINED_MARKER_${name.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  const pkgDir = path.join(serviceDir, 'node_modules', name);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }),
  );
  fs.writeFileSync(
    path.join(pkgDir, 'index.js'),
    `export const marker = ${JSON.stringify(marker)};\n`,
  );
  return marker;
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
          extension: '@prisma/composer/other',
          type: 'other',
          module: moduleUrl(serviceDir),
          entry: 'server.js',
        },
        address: 'svc',
        cwd: makeCwd(),
      }),
    ).rejects.toThrow(/expected a "node" build adapter/);
  });

  test('rejects when the declared build entry is missing — names the expected path', async () => {
    const serviceDir = makeServiceDir();
    await expect(
      assemble({
        build: {
          extension: '@prisma/composer/node',
          type: 'node',
          module: moduleUrl(serviceDir),
          entry: '../dist/server.js',
        },
        address: 'svc',
        cwd: makeCwd(),
      }),
    ).rejects.toThrow(/no built entry at .*dist\/server\.js/);
  });

  test('rejects an entry that resolves inside the deploy-owned working dir', async () => {
    const cwd = makeCwd();
    const address = 'svc';
    const workDir = path.join(cwd, '.prisma-composer', 'artifacts', address);
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'server.js'), 'export default "app-entry";\n');
    await expect(
      assemble({
        build: {
          extension: '@prisma/composer/node',
          type: 'node',
          module: pathToFileURL(path.join(workDir, 'src', 'service.ts')).href,
          entry: '../server.js',
        },
        address,
        cwd,
      }),
    ).rejects.toThrow(/resolves inside the deploy working dir/);
  });

  test('copies the built entry under bundle/, with main.mjs at the working-dir root', async () => {
    const serviceDir = makeServiceDir();
    const cwd = makeCwd();
    const address = 'shop.storefront';
    fs.mkdirSync(path.join(serviceDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'dist', 'server.js'), 'export default "app-entry";\n');
    fs.writeFileSync(
      path.join(serviceDir, 'src', 'service.ts'),
      'export default { hello: "wrapper" as const };\n',
    );

    const result = await assemble({
      build: {
        extension: '@prisma/composer/node',
        type: 'node',
        module: moduleUrl(serviceDir),
        entry: '../dist/server.js',
      },
      address,
      cwd,
    });

    expect(result.dir).toBe(path.join(cwd, '.prisma-composer', 'artifacts', address));
    expect(result.entry).toBe('bundle/server.js');
    expect(fs.existsSync(path.join(result.dir, 'bundle', 'server.js'))).toBe(true);
    // The wrapper sits at the working-dir root, not under bundle/.
    expect(fs.existsSync(path.join(result.dir, 'main.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'bundle', 'main.mjs'))).toBe(false);
    expect(fs.readFileSync(path.join(result.dir, 'bundle', 'server.js'), 'utf8')).toContain(
      'app-entry',
    );
    // Deploy-owned working dir — never the user's build output, never node_modules.
    expect(result.dir.startsWith(serviceDir)).toBe(false);
    expect(result.dir.includes('node_modules')).toBe(false);
  }, 20_000);

  test('assembles a build whose module basename is not "service" (cron scheduler shape) to main.mjs', async () => {
    // The cron scheduler's build.module is "scheduler-service.mjs", not
    // "service.ts" — a filename-discovery approach (readdir + regex on
    // "service.*") would miss it; an object entry keys the output by name
    // rather than by the input's basename, so it doesn't care.
    const serviceDir = makeServiceDir();
    const cwd = makeCwd();
    const address = 'jobs.scheduler';
    fs.mkdirSync(path.join(serviceDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(serviceDir, 'dist', 'scheduler-entrypoint.js'),
      'export default "app-entry";\n',
    );
    fs.writeFileSync(
      path.join(serviceDir, 'src', 'scheduler-service.ts'),
      'export default { hello: "wrapper" as const };\n',
    );

    const result = await assemble({
      build: {
        extension: '@prisma/composer/node',
        type: 'node',
        module: pathToFileURL(path.join(serviceDir, 'src', 'scheduler-service.ts')).href,
        entry: '../dist/scheduler-entrypoint.js',
      },
      address,
      cwd,
    });

    expect(result.entry).toBe('bundle/scheduler-entrypoint.js');
    expect(fs.existsSync(path.join(result.dir, 'main.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'bundle', 'scheduler-entrypoint.js'))).toBe(true);
  }, 20_000);

  test('fails assembly when the service module imports something the wrapper cannot resolve — no main.mjs emitted', async () => {
    // ADR-0008: the wrapper inlines every import except bun/bun:*/node:*. A
    // wrapper build that can't resolve one of those imports must fail loudly
    // rather than emit a wrapper that dies at boot.
    const serviceDir = makeServiceDir();
    const cwd = makeCwd();
    const address = 'shop.storefront';
    fs.mkdirSync(path.join(serviceDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'dist', 'server.js'), 'export default "app-entry";\n');
    fs.writeFileSync(
      path.join(serviceDir, 'src', 'service.ts'),
      "import { thing } from 'totally-unresolvable-package-xyz';\nexport default { hello: thing };\n",
    );

    const workDir = path.join(cwd, '.prisma-composer', 'artifacts', address);

    await expect(
      assemble({
        build: {
          extension: '@prisma/composer/node',
          type: 'node',
          module: moduleUrl(serviceDir),
          entry: '../dist/server.js',
        },
        address,
        cwd,
      }),
    ).rejects.toThrow(/Could not resolve/);

    expect(fs.existsSync(path.join(workDir, 'main.mjs'))).toBe(false);
  }, 20_000);

  test('the wrapper externalizes only runtime built-ins and inlines everything else (ADR-0008)', async () => {
    // ADR-0008's core property, asserted against a real build: `bun`, `bun:*`
    // and `node:*` resolve inside the deploy VM and must stay external;
    // everything else must be inlined, because the artifact's node_modules
    // holds only what the app's OWN build traced.
    //
    // `bunyan-ish` is the case that matters most here. A bare package whose
    // name merely STARTS with "bun" is not a runtime module, so it must
    // inline. Widening
    // the external list to a prefix match (`['bun*']`) would silently
    // externalize it — the build still succeeds and every other assertion here
    // still holds, so this is the only one that catches that regression. It
    // fails at boot, which is the exact bug this wrapper build exists to
    // prevent.
    const serviceDir = makeServiceDir();
    const cwd = makeCwd();
    const address = 'shop.storefront';
    fs.mkdirSync(path.join(serviceDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'dist', 'server.js'), 'export default "app-entry";\n');

    const bunPrefixedMarker = installFixturePackage(serviceDir, 'bunyan-ish');
    const plainMarker = installFixturePackage(serviceDir, 'plain-dep');
    fs.writeFileSync(
      path.join(serviceDir, 'src', 'service.ts'),
      [
        "import { readFileSync } from 'node:fs';",
        "import { SQL } from 'bun';",
        "import { Database } from 'bun:sqlite';",
        "import { marker as bunPrefixed } from 'bunyan-ish';",
        "import { marker as plain } from 'plain-dep';",
        'export default { readFileSync, SQL, Database, bunPrefixed, plain };',
      ].join('\n'),
    );

    const result = await assemble({
      build: {
        extension: '@prisma/composer/node',
        type: 'node',
        module: moduleUrl(serviceDir),
        entry: '../dist/server.js',
      },
      address,
      cwd,
    });

    const wrapper = fs.readFileSync(path.join(result.dir, 'main.mjs'), 'utf8');
    const importsExternally = (specifier: string): boolean =>
      new RegExp(`from\\s*["']${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(
        wrapper,
      );

    // The runtime provides these — they must survive as real imports.
    expect(importsExternally('node:fs')).toBe(true);
    expect(importsExternally('bun')).toBe(true);
    expect(importsExternally('bun:sqlite')).toBe(true);

    // Everything else must be inlined: contents present, no bare import left.
    expect(wrapper).toContain(bunPrefixedMarker);
    expect(importsExternally('bunyan-ish')).toBe(false);
    expect(wrapper).toContain(plainMarker);
    expect(importsExternally('plain-dep')).toBe(false);
  }, 20_000);
});
