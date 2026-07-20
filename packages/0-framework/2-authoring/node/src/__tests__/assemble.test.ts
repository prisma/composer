import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assemble } from '../exports/control.ts';
import node from '../exports/index.ts';

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

/** The service module the wrapper is built from — every assemble that gets past validation bundles this. */
function writeServiceModule(serviceDir: string): void {
  fs.writeFileSync(
    path.join(serviceDir, 'src', 'service.ts'),
    'export default { hello: "wrapper" as const };\n',
  );
}

/** Writes `files` (paths relative to `dir`, POSIX-separated) under `dir`, creating parents. */
function writeTree(dir: string, files: Record<string, string>): string {
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

/** Every file inside `dir`, as POSIX-separated paths relative to it — sorted, so a copy's contents can be asserted exactly. */
function treeContents(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .sort();
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

  test('copies exactly the named file — the siblings sitting beside it in the build dir are not swept in', async () => {
    // The single-file form's contract, and the boundary against the directory
    // form: `entry` alone means one file, however much else the author's build
    // left next to it. Only `dir` opts into copying a tree.
    const serviceDir = makeServiceDir();
    const cwd = makeCwd();
    writeTree(path.join(serviceDir, 'dist'), {
      'server.js': 'export default "app-entry";\n',
      'chunk-abc.js': 'export const shared = 1;\n',
      'assets/app.css': 'body { color: red }\n',
    });
    writeServiceModule(serviceDir);

    const result = await assemble({
      build: node({ module: moduleUrl(serviceDir), entry: '../dist/server.js' }),
      address: 'svc',
      cwd,
    });

    expect(result.entry).toBe('bundle/server.js');
    expect(treeContents(path.join(result.dir, 'bundle'))).toEqual(['server.js']);
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

describe('assemble() — the directory form', () => {
  test('copies the whole tree verbatim under bundle/ and boots the named entry', async () => {
    // The reason this form exists: a build whose server needs the siblings it
    // emitted (a client bundle, CSS, an image) at runtime. All of it must
    // arrive, byte-for-byte, laid out as the author's build left it.
    const serviceDir = makeServiceDir();
    const cwd = makeCwd();
    const logo = 'PNG binary-ish bytes';
    writeTree(path.join(serviceDir, 'dist', 'server'), {
      'start.js': 'export default "app-entry";\n',
      'index.html': '<link rel="stylesheet" href="/assets/app.css">\n',
      'assets/app.css': 'body { color: red }\n',
      'assets/logo.png': logo,
    });
    writeServiceModule(serviceDir);

    const result = await assemble({
      build: node({ module: moduleUrl(serviceDir), dir: '../dist/server', entry: 'start.js' }),
      address: 'chat.web',
      cwd,
    });

    expect(result.dir).toBe(path.join(cwd, '.prisma-composer', 'artifacts', 'chat.web'));
    expect(result.entry).toBe('bundle/start.js');
    // The whole tree, and nothing but the tree.
    expect(treeContents(path.join(result.dir, 'bundle'))).toEqual([
      'assets/app.css',
      'assets/logo.png',
      'index.html',
      'start.js',
    ]);
    expect(fs.readFileSync(path.join(result.dir, 'bundle', 'assets', 'logo.png'), 'utf8')).toBe(
      logo,
    );
    // The wrapper still sits at the working-dir root, outside the copied tree.
    expect(fs.existsSync(path.join(result.dir, 'main.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'bundle', 'main.mjs'))).toBe(false);
  }, 20_000);

  test('boots an entry nested inside the tree, reported relative to bundle/', async () => {
    const serviceDir = makeServiceDir();
    const cwd = makeCwd();
    writeTree(path.join(serviceDir, 'dist', 'app'), {
      'server/start.js': 'export default "app-entry";\n',
      'client/main.js': 'console.log("client");\n',
    });
    writeServiceModule(serviceDir);

    const result = await assemble({
      build: node({ module: moduleUrl(serviceDir), dir: '../dist/app', entry: 'server/start.js' }),
      address: 'svc',
      cwd,
    });

    expect(result.entry).toBe('bundle/server/start.js');
    expect(fs.existsSync(path.join(result.dir, 'bundle', 'server', 'start.js'))).toBe(true);
    expect(fs.existsSync(path.join(result.dir, 'bundle', 'client', 'main.js'))).toBe(true);
  }, 20_000);

  test('rejects a missing dir — names the expected path', async () => {
    const serviceDir = makeServiceDir();
    writeServiceModule(serviceDir);

    await expect(
      assemble({
        build: node({ module: moduleUrl(serviceDir), dir: '../dist/server', entry: 'start.js' }),
        address: 'svc',
        cwd: makeCwd(),
      }),
    ).rejects.toThrow(/no built directory at .*dist\/server/);
  });

  test('rejects a dir that is a file — that is the single-file form, without dir', async () => {
    const serviceDir = makeServiceDir();
    writeTree(path.join(serviceDir, 'dist'), { 'server.js': 'export default "app-entry";\n' });
    writeServiceModule(serviceDir);

    await expect(
      assemble({
        build: node({ module: moduleUrl(serviceDir), dir: '../dist/server.js', entry: 'start.js' }),
        address: 'svc',
        cwd: makeCwd(),
      }),
    ).rejects.toThrow(/is not a directory/);
  });

  test('rejects an entry that is missing inside dir — names both', async () => {
    const serviceDir = makeServiceDir();
    writeTree(path.join(serviceDir, 'dist', 'server'), { 'index.html': '<html>\n' });
    writeServiceModule(serviceDir);

    await expect(
      assemble({
        build: node({ module: moduleUrl(serviceDir), dir: '../dist/server', entry: 'start.js' }),
        address: 'svc',
        cwd: makeCwd(),
      }),
    ).rejects.toThrow(/no built entry at .*server\/start\.js.*resolves inside dir/s);
  });

  test('rejects an entry that escapes dir with ../ — the file it names exists, so only the escape can reject it', async () => {
    const serviceDir = makeServiceDir();
    writeTree(path.join(serviceDir, 'dist'), {
      'server/index.html': '<html>\n',
      'outside.js': 'export default "not in the tree";\n',
    });
    writeServiceModule(serviceDir);

    await expect(
      assemble({
        build: node({
          module: moduleUrl(serviceDir),
          dir: '../dist/server',
          entry: '../outside.js',
        }),
        address: 'svc',
        cwd: makeCwd(),
      }),
    ).rejects.toThrow(/is not inside dir/);
  });

  test('rejects an absolute entry pointing outside dir', async () => {
    const serviceDir = makeServiceDir();
    writeTree(path.join(serviceDir, 'dist'), {
      'server/index.html': '<html>\n',
      'outside.js': 'export default "not in the tree";\n',
    });
    writeServiceModule(serviceDir);

    await expect(
      assemble({
        build: node({
          module: moduleUrl(serviceDir),
          dir: '../dist/server',
          entry: path.join(serviceDir, 'dist', 'outside.js'),
        }),
        address: 'svc',
        cwd: makeCwd(),
      }),
    ).rejects.toThrow(/is not inside dir/);
  });

  test('rejects a dir that resolves inside the deploy-owned working dir', async () => {
    const cwd = makeCwd();
    const address = 'svc';
    const workDir = path.join(cwd, '.prisma-composer', 'artifacts', address);
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    writeTree(path.join(workDir, 'build'), { 'start.js': 'export default "app-entry";\n' });

    await expect(
      assemble({
        build: node({
          module: pathToFileURL(path.join(workDir, 'src', 'service.ts')).href,
          dir: '../build',
          entry: 'start.js',
        }),
        address,
        cwd,
      }),
    ).rejects.toThrow(/dir \(.*\) resolves inside the deploy working dir/);
  });

  test('rejects a dir that contains the deploy working dir — the copy would recurse into its own output', async () => {
    const serviceDir = makeServiceDir();
    const buildDir = path.join(serviceDir, 'dist', 'server');
    writeTree(buildDir, { 'start.js': 'export default "app-entry";\n' });
    writeServiceModule(serviceDir);
    // The deploy runs from inside the very tree it is told to copy.
    const cwd = path.join(buildDir, 'deploy');
    fs.mkdirSync(cwd, { recursive: true });

    await expect(
      assemble({
        build: node({ module: moduleUrl(serviceDir), dir: '../dist/server', entry: 'start.js' }),
        address: 'svc',
        cwd,
      }),
    ).rejects.toThrow(/sits inside the build adapter's dir .* copy the artifact into itself/s);
  });

  test('rejects a tree containing a symlink, naming it — the packager rejects symlinks, and we ship what the build produced', async () => {
    // Decided over dereferencing on copy: the artifact must be the tree the
    // author's build produced (ADR-0005), and following a link could pull in
    // files from outside dir that the author never named. Failing here beats
    // failing in the packager, which reports it far from the cause.
    const serviceDir = makeServiceDir();
    writeTree(path.join(serviceDir, 'dist'), {
      'server/start.js': 'export default "app-entry";\n',
      'shared/util.js': 'export const shared = 1;\n',
    });
    fs.symlinkSync(
      path.join(serviceDir, 'dist', 'shared', 'util.js'),
      path.join(serviceDir, 'dist', 'server', 'util.js'),
    );
    writeServiceModule(serviceDir);

    await expect(
      assemble({
        build: node({ module: moduleUrl(serviceDir), dir: '../dist/server', entry: 'start.js' }),
        address: 'svc',
        cwd: makeCwd(),
      }),
    ).rejects.toThrow(/contains symlinks.*server\/util\.js/s);
  });

  test('reports a symlinked directory without descending into it', async () => {
    const serviceDir = makeServiceDir();
    writeTree(path.join(serviceDir, 'dist'), {
      'server/start.js': 'export default "app-entry";\n',
      'shared/util.js': 'export const shared = 1;\n',
    });
    fs.symlinkSync(
      path.join(serviceDir, 'dist', 'shared'),
      path.join(serviceDir, 'dist', 'server', 'vendor'),
    );
    writeServiceModule(serviceDir);

    await expect(
      assemble({
        build: node({ module: moduleUrl(serviceDir), dir: '../dist/server', entry: 'start.js' }),
        address: 'svc',
        cwd: makeCwd(),
      }),
    ).rejects.toThrow(/contains symlinks.*server\/vendor/s);
  });
});
