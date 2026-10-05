import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { checkHost } from './check-cli-engine-pin-host.mjs';

const ENGINE = '@prisma/cli-engine';

let root;
let cliDir;

function write(relativePath, content) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function writePackage(dir, manifest) {
  write(join(dir, 'package.json'), JSON.stringify(manifest));
}

/** A package that exports `./package.json`, the only path the checks resolve on it. */
function writeEngine(dir) {
  writePackage(dir, {
    name: ENGINE,
    version: '0.6.2',
    exports: { './package.json': './package.json' },
  });
}

/** The workspace family package; `built` controls whether dist/family.mjs exists. */
function writeWorkspaceCli({ built }) {
  writePackage('workspace/composer-cli', {
    name: '@prisma/composer-cli',
    exports: { './family': './dist/family.mjs' },
  });
  if (built) write('workspace/composer-cli/dist/family.mjs', 'export {};\n');
}

function linkWorkspaceCliAtRoot() {
  mkdirSync(join(root, 'node_modules/@prisma'), { recursive: true });
  symlinkSync(
    join(root, 'workspace/composer-cli'),
    join(root, 'node_modules/@prisma/composer-cli'),
  );
}

/** The healthy hoisted layout: host, engine and the family link all at the root. */
function healthyTree() {
  writePackage('node_modules/prisma', {
    name: 'prisma',
    version: '8.0.0',
    dependencies: { [ENGINE]: '0.6.1', '@prisma/composer-cli': '0.25.0' },
  });
  writeEngine('node_modules/@prisma/cli-engine');
  writeWorkspaceCli({ built: true });
  linkWorkspaceCliAtRoot();
}

function run() {
  return checkHost({
    hostManifestPath: join(root, 'node_modules/prisma/package.json'),
    cliDir,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-engine-pin-host-')));
  cliDir = join(root, 'workspace/composer-cli');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkHost', () => {
  it('passes when the host resolves the workspace family and both share one engine, whatever engine version the host declares', () => {
    healthyTree();

    assert.deepEqual(run(), []);
  });

  it('fails when the host resolves a registry copy of the family nested beside it', () => {
    healthyTree();
    writePackage('node_modules/prisma/node_modules/@prisma/composer-cli', {
      name: '@prisma/composer-cli',
      exports: { './family': './dist/family.mjs' },
    });
    write('node_modules/prisma/node_modules/@prisma/composer-cli/dist/family.mjs', 'export {};\n');

    const [failure, ...rest] = run();

    assert.equal(rest.length, 0);
    assert.match(failure, /resolves @prisma\/composer-cli to .*node_modules\/prisma\/node_modules/);
    assert.match(failure, /pnpm override/);
  });

  it('fails when the family cannot be resolved from the host, naming the override and the root link', () => {
    healthyTree();
    rmSync(join(root, 'node_modules/@prisma/composer-cli'));

    const [failure, ...rest] = run();

    assert.equal(rest.length, 0);
    assert.match(failure, /cannot resolve @prisma\/composer-cli\/family/);
    assert.match(failure, /pnpm override and its @prisma\/composer-cli devDependency/);
  });

  it('says to build the family first when the workspace package has no dist', () => {
    healthyTree();
    rmSync(join(cliDir, 'dist'), { recursive: true });

    assert.deepEqual(run(), [
      `${join(cliDir, 'dist/family.mjs')} does not exist: build @prisma/composer-cli first (pnpm turbo run build --filter=@prisma/composer-cli).`,
    ]);
  });

  it('fails when the host and the family load different copies of the engine', () => {
    healthyTree();
    writeEngine('node_modules/prisma/node_modules/@prisma/cli-engine');

    const [failure, ...rest] = run();

    assert.equal(rest.length, 0);
    assert.match(failure, /different copies of @prisma\/cli-engine/);
    assert.match(failure, /root pnpm override of @prisma\/cli-engine/);
  });
});
