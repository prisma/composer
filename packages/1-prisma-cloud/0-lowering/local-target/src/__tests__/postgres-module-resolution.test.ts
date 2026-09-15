import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePrismaDevModulePath } from '../postgres.ts';

describe('resolvePrismaDevModulePath', () => {
  let cwd: string;

  beforeEach(() => {
    // realpath'd — node's own module resolution resolves symlinks (macOS's
    // `/tmp` → `/private/tmp`), and the assertions below compare against it.
    cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'dev-postgres-module-resolution-test-')),
    );
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'app' }));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function writeModule(dir: string, name: string): void {
    const modDir = path.join(dir, ...name.split('/'));
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    fs.writeFileSync(path.join(modDir, 'index.js'), 'module.exports = {};\n');
  }

  test('resolves @prisma/dev directly when the app depends on it', () => {
    writeModule(path.join(cwd, 'node_modules'), '@prisma/dev');

    const resolved = resolvePrismaDevModulePath(cwd);

    expect(resolved).toBe(path.join(cwd, 'node_modules', '@prisma', 'dev', 'index.js'));
  });

  test('resolves an installed @prisma/dev through a CLI with no root export', () => {
    writeModule(path.join(cwd, 'node_modules'), 'prisma');
    fs.writeFileSync(
      path.join(cwd, 'node_modules', 'prisma', 'package.json'),
      JSON.stringify({ name: 'prisma', exports: { './package.json': './package.json' } }),
    );
    writeModule(path.join(cwd, 'node_modules', 'prisma', 'node_modules'), '@prisma/dev');

    const resolved = resolvePrismaDevModulePath(cwd);

    expect(resolved).toBe(
      path.join(cwd, 'node_modules', 'prisma', 'node_modules', '@prisma', 'dev', 'index.js'),
    );
  });

  test('neither @prisma/dev nor prisma installed throws the pinned error', () => {
    expect(() => resolvePrismaDevModulePath(cwd)).toThrow(
      'local dev needs @prisma/dev for its local Postgres emulator — add "@prisma/dev" to the devDependencies of the project where you run Composer.',
    );
  });

  test('prisma installed but without @prisma/dev throws the pinned error', () => {
    writeModule(path.join(cwd, 'node_modules'), 'prisma');
    fs.writeFileSync(
      path.join(cwd, 'node_modules', 'prisma', 'package.json'),
      JSON.stringify({ name: 'prisma', exports: { './package.json': './package.json' } }),
    );

    expect(() => resolvePrismaDevModulePath(cwd)).toThrow(
      'local dev needs @prisma/dev for its local Postgres emulator — add "@prisma/dev" to the devDependencies of the project where you run Composer.',
    );
  });
});
