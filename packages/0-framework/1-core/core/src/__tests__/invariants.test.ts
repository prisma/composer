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
  ['@internal', 'lowering'].join('/'), // no cross-domain package leaks into core's authoring bundle
  'new SQL(',
  'ProviderCollection',
  'from "bun"',
  '"node:', // a node:-scheme import always appears quoted in a bundle
];

describe('entry map: core splits into authoring + deploy + local-target — no runtime entry', () => {
  test("package.json exports '.', './deploy', './config', './local-target', and './testing' (casts/assertions live in @internal/foundation)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    // `./package.json` is a conventional manifest export, not a code entry.
    const codeEntries = Object.keys(pkg.exports).filter((k) => k !== './package.json');
    expect(codeEntries.sort()).toEqual([
      '.',
      './config',
      './deploy',
      './local-target',
      './testing',
    ]);
  });

  // ADR-0041's own firewall: `/deploy` and the root `.` entry must never
  // carry anything local-target-flavored — `lower()` is provenance-ignorant
  // (REVISED, operator review of #162), so nothing in its own module or the
  // authoring barrel should mention the local target's own vocabulary at
  // all. "dev" names the user-facing feature only (naming, operator
  // 2026-07-23); DEV_DIR is exempt from that check since it's the
  // user-facing state dir, not seam vocabulary.
  test("'./deploy' and '.' export no local-target-flavored name — /local-target is the only door to it", () => {
    const deployText = fs.readFileSync(path.join(srcDir, 'exports', 'deploy.ts'), 'utf8');
    const indexText = fs.readFileSync(path.join(srcDir, 'exports', 'index.ts'), 'utf8');
    const devTokens = [
      'localTargetProviders',
      'resolveLocalTargets',
      'LocalTargetDescriptor',
      'LocalTargetProvidersInput',
      'DEV_DIR',
    ];
    for (const token of devTokens) {
      expect({ file: 'exports/deploy.ts', containsToken: deployText.includes(token) }).toEqual({
        file: 'exports/deploy.ts',
        containsToken: false,
      });
      expect({ file: 'exports/index.ts', containsToken: indexText.includes(token) }).toEqual({
        file: 'exports/index.ts',
        containsToken: false,
      });
    }
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

describe('invariant 4: core touches the environment only to read back the container transport it wrote', () => {
  test("the process-env token appears only in control/deploy.ts (deserializeContainers(config, process.env), read-back for the parent→child container transport core itself owns — never a target's own vars)", () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(0);

    const token = ['process', 'env'].join('.');
    const hits = sources.flatMap(({ file, text }) => {
      const count = text.split(token).length - 1;
      return count > 0 ? [{ file, count }] : [];
    });

    expect(hits).toEqual([{ file: 'control/deploy.ts', count: 2 }]);
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
