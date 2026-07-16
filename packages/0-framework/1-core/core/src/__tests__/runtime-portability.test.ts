import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Repo-wide (not just this package): every service must be deployable under
 * node OR bun (design-notes' "CLI runtime: runtime-agnostic bin, node +
 * bun"). `bun` implements node:'s builtins, so `node:` imports are fine in
 * deploy-only code (e.g. the /assemble entries) — the existing per-package
 * invariant tests already ban `node:` in the pure authoring entries. What no
 * package source may ever do, anywhere, is assume the bun runtime itself:
 * that would make bun the only way to run the deploy pipeline.
 */
const packagesDir = path.join(import.meta.dir, '..', '..', '..');

interface SourceFile {
  readonly file: string;
  readonly text: string;
}

/** Every shipped .ts file under every package's src/, excluding __tests__. */
function allPackageSources(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const pkg of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = path.join(packagesDir, pkg.name, 'src');
    if (!fs.existsSync(srcDir)) continue;

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.ts')) {
          out.push({ file: path.relative(packagesDir, full), text: fs.readFileSync(full, 'utf8') });
        }
      }
    };
    walk(srcDir);
  }
  return out;
}

describe('runtime-portability invariant: no package source may assume the bun runtime', () => {
  test('no shipped source imports "bun" or a bun: scheme module', () => {
    const sources = allPackageSources();
    expect(sources.length).toBeGreaterThan(0);

    // Import/require syntax only — a config array like `external: ['bun']`
    // (esbuild's runtime-external list, e.g. in the assemble entries) is data,
    // not an import, and must not trip this.
    const importPattern = /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](bun|bun:[^"']*)["']/;
    for (const { file, text } of sources) {
      expect({ file, hasBunImport: importPattern.test(text) }).toEqual({
        file,
        hasBunImport: false,
      });
    }
  });

  test('no shipped source references the Bun. global', () => {
    const sources = allPackageSources();
    const globalPattern = /\bBun\./;
    for (const { file, text } of sources) {
      expect({ file, usesBunGlobal: globalPattern.test(text) }).toEqual({
        file,
        usesBunGlobal: false,
      });
    }
  });
});
