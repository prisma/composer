import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkEffectResolution,
  effectMismatchError,
  findAlchemyPackageDir,
  requiredEffectVersion,
  resolveEffectVersionFrom,
} from '../check-effect-resolution.ts';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-effect-')),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Lays down a resolvable package at `root/<...segments>` with the given manifest fields. */
function writePackage(
  root: string,
  segments: readonly string[],
  manifest: Record<string, unknown>,
): string {
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ main: 'index.js', ...manifest }),
  );
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
  return dir;
}

function writeHealthyTree(root: string, version = '4.0.0-beta.93'): void {
  writePackage(root, ['node_modules', 'alchemy'], { name: 'alchemy', version: '2.0.0-beta.59' });
  writePackage(root, ['node_modules', 'effect'], { name: 'effect', version });
  writePackage(root, ['node_modules', '@prisma', 'composer'], {
    name: '@prisma/composer',
    version: '0.0.0',
    dependencies: { effect: version },
  });
}

describe('findAlchemyPackageDir()', () => {
  test('finds node_modules/alchemy in the starting directory', () => {
    const root = makeTmpDir();
    const dir = writePackage(root, ['node_modules', 'alchemy'], { name: 'alchemy' });
    expect(findAlchemyPackageDir(root)).toBe(dir);
  });

  test('walks up through parents (hoisted layouts)', () => {
    const root = makeTmpDir();
    const dir = writePackage(root, ['node_modules', 'alchemy'], { name: 'alchemy' });
    const nested = path.join(root, 'apps', 'my-app');
    fs.mkdirSync(nested, { recursive: true });
    expect(findAlchemyPackageDir(nested)).toBe(dir);
  });

  test('returns undefined when alchemy is not installed anywhere above', () => {
    expect(findAlchemyPackageDir(makeTmpDir())).toBeUndefined();
  });
});

describe('resolveEffectVersionFrom()', () => {
  test("returns the version of the effect the package's position resolves", () => {
    const root = makeTmpDir();
    writeHealthyTree(root, '4.0.0-beta.102');
    const alchemyDir = path.join(root, 'node_modules', 'alchemy');
    expect(resolveEffectVersionFrom(alchemyDir)).toBe('4.0.0-beta.102');
  });

  test('a copy nested inside the package wins over the root copy (Node resolution order)', () => {
    const root = makeTmpDir();
    writeHealthyTree(root, '4.0.0-beta.102');
    writePackage(root, ['node_modules', 'alchemy', 'node_modules', 'effect'], {
      name: 'effect',
      version: '4.0.0-beta.93',
    });
    const alchemyDir = path.join(root, 'node_modules', 'alchemy');
    expect(resolveEffectVersionFrom(alchemyDir)).toBe('4.0.0-beta.93');
  });

  test('returns undefined when effect is not resolvable from there', () => {
    const root = makeTmpDir();
    const alchemyDir = writePackage(root, ['node_modules', 'alchemy'], { name: 'alchemy' });
    expect(resolveEffectVersionFrom(alchemyDir)).toBeUndefined();
  });
});

describe('requiredEffectVersion()', () => {
  test("reads the pin from @prisma/composer's installed package.json", () => {
    const root = makeTmpDir();
    writeHealthyTree(root);
    expect(requiredEffectVersion(root)).toBe('4.0.0-beta.93');
  });

  test('returns undefined when @prisma/composer is not resolvable', () => {
    expect(requiredEffectVersion(makeTmpDir())).toBeUndefined();
  });
});

describe('effectMismatchError()', () => {
  test('healthy: same version on both sides yields no error', () => {
    expect(effectMismatchError('4.0.0-beta.93', '4.0.0-beta.93')).toBeUndefined();
  });

  test('unknown on either side yields no error (the check must not misfire on unusual layouts)', () => {
    expect(effectMismatchError(undefined, '4.0.0-beta.93')).toBeUndefined();
    expect(effectMismatchError('4.0.0-beta.102', undefined)).toBeUndefined();
  });

  test('mismatch names found + required versions and the overrides fix, rendered from the pin', () => {
    const message = effectMismatchError('4.0.0-beta.102', '4.0.0-beta.93');
    expect(message).toContain('alchemy resolves effect@4.0.0-beta.102');
    expect(message).toContain('requires effect@4.0.0-beta.93');
    expect(message).toContain('"overrides": { "effect": "4.0.0-beta.93" }');
  });
});

describe('checkEffectResolution()', () => {
  test('no-op on a healthy tree', () => {
    const root = makeTmpDir();
    writeHealthyTree(root);
    expect(() => checkEffectResolution(root)).not.toThrow();
  });

  test("no-op when alchemy isn't installed (later steps report that with their own error)", () => {
    expect(() => checkEffectResolution(makeTmpDir())).not.toThrow();
  });

  test("throws the actionable CliError on the operator's broken shape: root effect@beta.102, composer's pin nested", () => {
    const root = makeTmpDir();
    writeHealthyTree(root, '4.0.0-beta.102');
    // The composer package pins beta.93 and got its own nested copy — exactly
    // the tree npm builds when a floating @effect/* range hoists beta.102.
    const composerDir = path.join(root, 'node_modules', '@prisma', 'composer');
    fs.writeFileSync(
      path.join(composerDir, 'package.json'),
      JSON.stringify({
        name: '@prisma/composer',
        version: '0.0.0',
        main: 'index.js',
        dependencies: { effect: '4.0.0-beta.93' },
      }),
    );
    expect(() => checkEffectResolution(root)).toThrow(
      /alchemy resolves effect@4\.0\.0-beta\.102, but @prisma\/composer requires effect@4\.0\.0-beta\.93/,
    );
  });

  test('runs from a nested app directory below the install root', () => {
    const root = makeTmpDir();
    writeHealthyTree(root, '4.0.0-beta.102');
    const composerDir = path.join(root, 'node_modules', '@prisma', 'composer');
    fs.writeFileSync(
      path.join(composerDir, 'package.json'),
      JSON.stringify({
        name: '@prisma/composer',
        version: '0.0.0',
        main: 'index.js',
        dependencies: { effect: '4.0.0-beta.93' },
      }),
    );
    const nested = path.join(root, 'apps', 'my-app');
    fs.mkdirSync(nested, { recursive: true });
    expect(() => checkEffectResolution(nested)).toThrow(/Dependency conflict/);
  });
});
