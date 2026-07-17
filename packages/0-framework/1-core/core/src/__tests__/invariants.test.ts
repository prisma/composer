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

const leanTokens = [
  'alchemy',
  'effect',
  '@internal/lowering',
  'new SQL(',
  'ProviderCollection',
  'from "bun"',
  '"node:', // a node:-scheme import always appears quoted in a bundle
];

describe('entry map: core splits into authoring + deploy — no runtime entry', () => {
  test("package.json exports '.', './deploy', './config', and './testing' (casts/assertions live in @internal/foundation)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    // `./package.json` is a conventional manifest export, not a code entry.
    const codeEntries = Object.keys(pkg.exports).filter((k) => k !== './package.json');
    expect(codeEntries.sort()).toEqual(['.', './config', './deploy', './testing']);
  });
});

describe('invariant 1: core has no target or runtime dependency', () => {
  test('package.json runtime deps name no prisma-*, bun, or node package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const runtimeDeps = Object.keys({
      ...pkg.dependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    });

    for (const dep of runtimeDeps) {
      expect(dep).not.toMatch(/prisma/i);
      expect(dep).not.toBe('bun');
      expect(dep).not.toMatch(/^@types\/(bun|node)$/);
      expect(dep).not.toMatch(/^node(-|:)/);
    }
    // Target coupling must not hide in devDependencies either. Build-only config
    // (the shared tsdown base) ships nothing and is not target/runtime coupling.
    const buildOnly = new Set(['@internal/tsdown-config']);
    for (const dep of Object.keys(pkg.devDependencies ?? {})) {
      if (buildOnly.has(dep)) continue;
      expect(dep).not.toMatch(/prisma/i);
    }
  });
});

describe("invariant 2: the '.' authoring entry bundles lean", () => {
  test('bundling the core authoring entry yields no control/execution-plane tokens', async () => {
    const out = await Bun.build({
      entrypoints: [path.join(import.meta.dir, 'fixtures', 'probe-core-authoring.ts')],
      target: 'bun',
    });
    expect(out.success).toBe(true);

    const js = await out.outputs[0]!.text();
    // Positive marker: the probe genuinely bundled core's factories.
    expect(js).toContain('prisma:node');
    for (const token of leanTokens) {
      expect(js).not.toContain(token);
    }
  });

  test('the ecosystem-seam adapters (@prisma/composer/node, @prisma/composer/nextjs) are equally lean', async () => {
    const out = await Bun.build({
      entrypoints: [
        path.join(pkgDir, '..', '..', '2-authoring', 'node', 'src', 'exports', 'index.ts'),
        path.join(pkgDir, '..', '..', '2-authoring', 'nextjs', 'src', 'exports', 'index.ts'),
      ],
      target: 'bun',
    });
    expect(out.success).toBe(true);
    expect(out.outputs.length).toBe(2);

    for (const output of out.outputs) {
      const js = await output.text();
      for (const token of leanTokens) {
        expect(js).not.toContain(token);
      }
    }
  });
});

describe('invariant 4: core contains zero environment reads', () => {
  test("the process-env token appears nowhere in core's src", () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(0);

    const token = ['process', 'env'].join('.');
    for (const { file, text } of sources) {
      expect({ file, count: text.split(token).length - 1 }).toEqual({ file, count: 0 });
    }
  });
});

describe('invariant 5: no runtime coupling in shipped surface', () => {
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
});
