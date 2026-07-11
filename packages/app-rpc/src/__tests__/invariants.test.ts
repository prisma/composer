import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const pkgDir = path.join(import.meta.dir, '..', '..');
const srcDir = path.join(pkgDir, 'src');

// All shipped source files: every .ts under src, excluding __tests__.
function shippedSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push({ file: path.relative(srcDir, full), text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(srcDir);
  return out;
}

describe('entry map: @prisma/app-rpc ships a single entry', () => {
  test("package.json exports exactly '.'", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    // `./package.json` is a conventional manifest export, not a code entry.
    const codeEntries = Object.keys(pkg.exports).filter((k) => k !== './package.json');
    expect(codeEntries).toEqual(['.']);
  });
});

describe('invariant: the entry is web-standard only — no bun/node coupling', () => {
  test('bundling index.ts yields no bun/node-scheme tokens', async () => {
    const out = await Bun.build({
      entrypoints: [path.join(srcDir, 'index.ts')],
      target: 'bun',
    });
    expect(out.success).toBe(true);

    const js = await out.outputs[0]!.text();
    // Positive marker: the probe genuinely bundled this package's serve() logic.
    expect(js).toContain('RPC dispatch is flat');
    for (const token of ['from "bun"', '"node:']) {
      expect(js).not.toContain(token);
    }
  });

  test('src contains no bun or node imports, type-only included', () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(0);

    const importPattern =
      /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](bun|bun:[^"']*|node:[^"']*)["']/;
    for (const { file, text } of sources) {
      expect({ file, hasRuntimeImport: importPattern.test(text) }).toEqual({
        file,
        hasRuntimeImport: false,
      });
    }
  });

  test('src uses no ambient runtime globals (Bun./Deno.)', () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(0);

    const globalPattern = /\b(Bun|Deno)\./;
    for (const { file, text } of sources) {
      expect({ file, usesRuntimeGlobal: globalPattern.test(text) }).toEqual({
        file,
        usesRuntimeGlobal: false,
      });
    }
  });

  test('package.json runtime deps name no bun or node package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const runtimeDeps = Object.keys({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    });

    for (const dep of runtimeDeps) {
      expect(dep).not.toBe('bun');
      expect(dep).not.toMatch(/^@types\/(bun|node)$/);
      expect(dep).not.toMatch(/^node(-|:)/);
    }
  });
});
