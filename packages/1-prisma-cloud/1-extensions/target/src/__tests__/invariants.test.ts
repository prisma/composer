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

// A built dist entry PLUS every relative chunk it (transitively) imports or
// re-exports, concatenated. tsup/rolldown hoists code shared between entries
// (e.g. pg-connection.ts, used by both control.ts and prisma-next.ts) into a
// chunk, leaving the entry file a thin re-export shim — so a token check that
// reads only the entry file would go vacuous. Following the shim's own imports
// makes the check see the real code again.
function builtEntryGraph(entryFileName: string): string {
  const distDir = path.join(pkgDir, 'dist');
  const relImport = /(?:from|import)\s*["'](\.[^"']+)["']/g;
  const seen = new Set<string>();
  const parts: string[] = [];
  const queue = [path.join(distDir, entryFileName)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    parts.push(text);
    for (const match of text.matchAll(relImport)) {
      const spec = match[1];
      if (spec === undefined) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(resolved)) queue.push(resolved);
    }
  }
  return parts.join('\n');
}

describe('entry map: authoring + control + prisma-next + testing, no other runtime entry', () => {
  test("package.json exports '.', './connection', './control', './prisma-next', and './testing' (cron lives in @internal/cron)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    // `./package.json` is a conventional manifest export, not a code entry.
    const codeEntries = Object.keys(pkg.exports).filter((k) => k !== './package.json');
    expect(codeEntries.sort()).toEqual([
      '.',
      './connection',
      './control',
      './prisma-next',
      './testing',
    ]);
  });
});

describe('invariant 2: authoring imports stay lean (core + pack)', () => {
  test('bundling both authoring entries yields no control/execution-plane tokens', async () => {
    const out = await Bun.build({
      entrypoints: [path.join(import.meta.dir, 'fixtures', 'probe-authoring.ts')],
      target: 'bun',
    });
    expect(out.success).toBe(true);

    const js = await out.outputs[0]!.text();
    // Positive marker: the probe genuinely bundled the pack's vocabulary.
    expect(js).toContain('@prisma/composer-prisma-cloud');
    for (const token of [
      'alchemy',
      'effect',
      'prisma-alchemy',
      'new SQL(',
      'ProviderCollection',
      'from "bun"',
      '"node:', // a node:-scheme import always appears quoted in a bundle
    ]) {
      expect(js).not.toContain(token);
    }
  });
});

describe('invariant 4: environment touches are confined to the config serializer and the control factory', () => {
  test("the process-env token appears only in serializer.ts (param read+stash, secret double-lookup+stash), control.ts's prismaCloud(), preflight.ts (shell token + fill-missing lookup), and compute.ts (boot exposes the resolved port as PORT; ADR-0030's accepted-keys re-stash) (the extension factory's env read, ADR-0017 — PRISMA_WORKSPACE_ID + optional PRISMA_REGION; ADR-0019 — PRISMA_PROJECT_ID + optional PRISMA_BRANCH_ID)", () => {
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(0);

    const token = ['process', 'env'].join('.');
    const hits = sources.flatMap(({ file, text }) => {
      const count = text.split(token).length - 1;
      return count > 0 ? [{ file, count }] : [];
    });

    expect(hits.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: 'compute.ts', count: 3 },
      { file: 'control.ts', count: 4 },
      { file: 'preflight.ts', count: 2 },
      { file: 'serializer.ts', count: 6 },
    ]);
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

describe('invariant 6 (ADR-0017, extension config): the authoring entry never reaches the control entry', () => {
  test('no module reachable from src/index.ts imports a /control entry — the firewall by file boundary', () => {
    // Control-plane code (this extension's control.ts, and transitively
    // prisma-alchemy/alchemy/effect) is imported ONLY by prisma-composer.config.ts.
    // A control import reachable from the authoring barrel would get followed
    // and inlined by the wrapper's own bundler (tsdown/rolldown), dragging
    // deploy-only tooling into the runtime artifact.
    const importPattern =
      /(?:import|export)\s+[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
    const importSpecifiers = (text: string): string[] => {
      const out: string[] = [];
      for (const match of text.matchAll(importPattern)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec !== undefined) out.push(spec);
      }
      return out;
    };

    const seen = new Map<string, string[]>();
    const queue = [path.join(srcDir, 'index.ts')];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      const specs = importSpecifiers(fs.readFileSync(file, 'utf8'));
      seen.set(file, specs);
      for (const spec of specs) {
        if (!spec.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        if (fs.existsSync(resolved)) queue.push(resolved);
      }
    }

    expect(seen.size).toBeGreaterThan(0);
    for (const [file, specs] of seen) {
      const offending = specs.filter((spec) => /\/control(\.ts)?$/.test(spec));
      expect({ file: path.relative(srcDir, file), offending }).toEqual({
        file: path.relative(srcDir, file),
        offending: [],
      });
    }
  });
});

describe('invariant 7 (ADR-0022): the authoring entry never reaches the prisma-next entry', () => {
  test('no module reachable from src/index.ts imports the /prisma-next entry — Prisma Next stays opt-in', () => {
    // prisma-next.ts (and transitively @prisma-next/postgres + pg) is
    // imported only by an app that explicitly imports the ./prisma-next
    // subpath. A reachable import from the authoring barrel would drag that
    // dependency tree into every service, defeating the whole point of the
    // dedicated subpath entry (ADR-0022, design-notes.md "opt-out stays real").
    const importPattern =
      /(?:import|export)\s+[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
    const importSpecifiers = (text: string): string[] => {
      const out: string[] = [];
      for (const match of text.matchAll(importPattern)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec !== undefined) out.push(spec);
      }
      return out;
    };

    const seen = new Map<string, string[]>();
    const queue = [path.join(srcDir, 'index.ts')];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      const specs = importSpecifiers(fs.readFileSync(file, 'utf8'));
      seen.set(file, specs);
      for (const spec of specs) {
        if (!spec.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        if (fs.existsSync(resolved)) queue.push(resolved);
      }
    }

    expect(seen.size).toBeGreaterThan(0);
    for (const [file, specs] of seen) {
      const offending = specs.filter(
        (spec) =>
          /\/prisma-next(\.ts)?$/.test(spec) || spec.startsWith('@prisma-next/') || spec === 'pg',
      );
      expect({ file: path.relative(srcDir, file), offending }).toEqual({
        file: path.relative(srcDir, file),
        offending: [],
      });
    }
  });

  test('the built dist/index.mjs graph contains no @prisma-next/* or pg tokens', () => {
    const built = builtEntryGraph('index.mjs');
    expect(built.length).toBeGreaterThan(0);
    expect(built).not.toContain('@prisma-next/');
    expect(built.includes('"pg"') || built.includes("'pg'")).toBe(false);
  });

  // The ./prisma-next authoring entry legitimately bundles
  // @prisma-next/postgres/runtime (the typed client) and pg (its runtime
  // connect-retry, slice 3). But the deploy-only machinery — the CLI config
  // loader, the control client, and the migration/config/resource/warm modules
  // — must NEVER leak into it, or every service using pnPostgres would pull the
  // CLI into its runtime bundle. The entry file is a re-export shim whose real
  // code lives in a chunk (pg-connection.ts is shared with control.ts), so we
  // check the whole reachable graph, not just the shim.
  test('the built dist/prisma-next.mjs graph contains no deploy-only machinery', () => {
    const built = builtEntryGraph('prisma-next.mjs');
    // Positive marker: the graph reached the real runtime code in the chunk,
    // so the forbidden-token checks below are not vacuous.
    expect(built).toContain('@prisma-next/postgres/runtime');
    for (const token of [
      '@prisma-next/cli',
      'postgres/control',
      'pn-config',
      'pn-migration-resource',
      'prisma-next-migrate',
      'pg-warm-resource',
    ]) {
      expect({ token, present: built.includes(token) }).toEqual({ token, present: false });
    }
  });
});
