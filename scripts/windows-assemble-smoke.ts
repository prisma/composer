/**
 * One-off Windows assemble smoke: a Next standalone fixture with an in-tree
 * directory link, then assemble via @internal/nextjs. On win32, asserts the
 * assembled link is a junction (absolute readlink) and still resolves inside
 * the bundle — the path real users hit without Developer Mode.
 *
 * Usage (from repo root, after pnpm build):
 *   bun scripts/windows-assemble-smoke.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertBundleSymlinksStayInside } from '../packages/0-framework/2-authoring/bundle-paths/src/bundle-paths.ts';
import { assemble } from '../packages/0-framework/2-authoring/nextjs/src/exports/control.ts';
import nextjs from '../packages/0-framework/2-authoring/nextjs/src/exports/index.ts';

function log(step: string, detail?: string): void {
  console.log(detail === undefined ? `✓ ${step}` : `✓ ${step}: ${detail}`);
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Probe whether this process can create a normal directory symlink (not a junction). */
function probeDirSymlinkPrivilege(scratch: string): boolean {
  const target = path.join(scratch, 'probe-target');
  const link = path.join(scratch, 'probe-link');
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.symlinkSync(path.basename(target), link, 'dir');
    return fs.lstatSync(link).isSymbolicLink();
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    log('dir symlink probe failed', String(code ?? error));
    return false;
  }
}

function writeNextStandaloneFixture(root: string, options: { useJunction: boolean }): void {
  const standalone = path.join(root, '.next', 'standalone');
  const appOut = path.join(standalone, 'apps', 'web');
  fs.mkdirSync(appOut, { recursive: true });
  fs.writeFileSync(path.join(appOut, 'server.js'), '// standalone server\n');

  // Real package dir + in-tree directory link (pnpm/Next standalone shape).
  const nextDir = path.join(standalone, 'node_modules', 'next');
  const nextLinked = path.join(standalone, 'node_modules', 'next-linked');
  fs.mkdirSync(nextDir, { recursive: true });
  fs.writeFileSync(path.join(nextDir, 'marker.txt'), 'next-ok\n');
  // Stock Windows without Developer Mode cannot create dir symlinks — use a
  // junction (absolute target), which is also what pnpm emits on win32.
  if (options.useJunction) {
    fs.symlinkSync(nextDir, nextLinked, 'junction');
  } else {
    fs.symlinkSync('next', nextLinked, 'dir');
  }

  // Client assets Next omits from standalone.
  fs.mkdirSync(path.join(root, '.next', 'static'), { recursive: true });
  fs.writeFileSync(path.join(root, '.next', 'static', 'chunk.js'), '// static\n');
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'favicon.ico'), 'icon\n');

  fs.writeFileSync(
    path.join(root, '.next', 'required-server-files.json'),
    JSON.stringify({
      relativeAppDir: 'apps/web',
      config: { outputFileTracingRoot: root },
    }),
  );

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'service.ts'),
    'export default { hello: "windows-assemble-smoke" as const };\n',
  );
}

async function main(): Promise<void> {
  console.log(`platform=${process.platform} arch=${process.arch}`);
  if (process.platform !== 'win32') {
    console.warn('warning: not win32 — still runs assemble, but junction assertions are skipped');
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-assemble-smoke-'));
  const canDirSymlink = probeDirSymlinkPrivilege(scratch);
  log('SeCreateSymbolicLinkPrivilege / Developer Mode dir symlink', canDirSymlink ? 'yes' : 'no');

  const appRoot = path.join(scratch, 'app');
  fs.mkdirSync(appRoot, { recursive: true });
  const useJunction = process.platform === 'win32' && !canDirSymlink;
  writeNextStandaloneFixture(appRoot, { useJunction });
  log(
    'wrote Next standalone fixture',
    `${appRoot} (link=${useJunction ? 'junction' : 'dir-symlink'})`,
  );

  const cwd = path.join(scratch, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });

  const result = await assemble({
    address: 'smoke.web',
    cwd,
    build: nextjs({
      module: pathToFileURL(path.join(appRoot, 'src', 'service.ts')).href,
      appDir: '..',
    }),
  });
  log('assemble succeeded', result.dir);

  const nextLinked = path.join(result.dir, 'bundle', 'node_modules', 'next-linked');
  if (!fs.lstatSync(nextLinked).isSymbolicLink()) {
    fail(`expected ${nextLinked} to be a reparse point / symbolic link`);
  }

  const rawTarget = fs.readlinkSync(nextLinked);
  const resolved = path.resolve(path.dirname(nextLinked), rawTarget);
  const expected = path.resolve(result.dir, 'bundle', 'node_modules', 'next');
  if (resolved !== expected) {
    fail(`link resolves to ${resolved}, expected ${expected} (raw=${rawTarget})`);
  }
  log('next-linked resolves to node_modules/next', rawTarget);

  const marker = fs.readFileSync(path.join(nextLinked, 'marker.txt'), 'utf8');
  if (marker.trim() !== 'next-ok') {
    fail(`marker through link was ${JSON.stringify(marker)}`);
  }
  log('read marker through assembled link');

  if (process.platform === 'win32') {
    // Junctions store absolute targets; relative would mean we used a privileged symlink.
    if (!path.isAbsolute(rawTarget)) {
      fail(
        `on win32 expected a junction (absolute readlink), got relative ${JSON.stringify(rawTarget)} — assemble may still be creating privileged dir symlinks`,
      );
    }
    log('win32 link is absolute (junction semantics)');
  }

  await assertBundleSymlinksStayInside(path.join(result.dir, 'bundle'));
  log('assertBundleSymlinksStayInside passed');

  if (!fs.existsSync(path.join(result.dir, 'main.mjs'))) {
    fail('main.mjs missing at assemble root');
  }
  if (!fs.existsSync(path.join(result.dir, 'bundle', 'apps', 'web', 'server.js'))) {
    fail('bundled server.js missing');
  }
  log('main.mjs and server.js present');

  console.log('\nOK — Windows assemble smoke passed');
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        canDirSymlink,
        assembleDir: result.dir,
        entry: result.entry,
        linkRawTarget: rawTarget,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
