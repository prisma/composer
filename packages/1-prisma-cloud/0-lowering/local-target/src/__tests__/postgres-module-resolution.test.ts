import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePrismaDevModulePath } from '../postgres.ts';

const localTargetDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function packageJsonAbove(file: string): { name: string; version: string } {
  let dir = path.dirname(file);
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${file}`);
    dir = parent;
  }
}

describe('resolvePrismaDevModulePath', () => {
  test("resolves the @prisma/dev that Composer's own package declares, not the app's", () => {
    const resolved = resolvePrismaDevModulePath();
    const manifest = packageJsonAbove(resolved);
    const declared = JSON.parse(fs.readFileSync(path.join(localTargetDir, 'package.json'), 'utf-8'))
      .dependencies['@prisma/dev'];

    expect(manifest.name).toBe('@prisma/dev');
    expect(declared).toBe('^0.25.2');
    expect(Bun.semver.satisfies(manifest.version, declared)).toBe(true);
  });

  test('does not depend on the working directory', () => {
    const fromRepo = resolvePrismaDevModulePath();
    const before = process.cwd();
    const emptyApp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-app-'));
    fs.writeFileSync(path.join(emptyApp, 'package.json'), JSON.stringify({ name: 'app' }));
    process.chdir(emptyApp);
    try {
      expect(resolvePrismaDevModulePath()).toBe(fromRepo);
    } finally {
      process.chdir(before);
      fs.rmSync(emptyApp, { recursive: true, force: true });
    }
  });
});
