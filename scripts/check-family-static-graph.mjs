#!/usr/bin/env node
// Nothing statically reachable from `@prisma/composer/family` may import
// alchemy or effect.
//
// The `prisma` bin imports composer's command family directly, so every module
// in that entrypoint's static graph loads on `prisma --version`. Alchemy's
// provider tree is expensive to load, drags in the whole effect constellation,
// and — until alchemy-run/node-utils#6 is released — registers process signal
// handlers at import time, in a process where the engine owns signals. None of
// that may happen because someone ran an unrelated command.
//
// What keeps it out is the lazy boundary already inside the operation modules:
// operations/deploy.ts, destroy.ts, dev.ts and log.ts each `await import()`
// their executor, and it is the executors that reach the provider tree
// (execute-dev.ts and execute-log.ts reach effect/Layer through
// resolveLocalTargets). That boundary is a load-order mechanism, not an
// optimization — flattening any of those four dynamic imports breaks this
// check, which is the intended outcome, not a false positive.
//
// The same walk covers `dist/testing.mjs`: the control-API double's imports
// of the real operation modules are type-only, and type-only is a claim about
// built output — an accidental value import would inline the real control
// implementation (the @internal scope is bundled) and hand every consumer of
// the double the code it exists to avoid. The double's graph has no dynamic
// imports either, while the real operations always carry their executor
// `import()` — so a dynamic import in the testing graph IS the real
// implementation having leaked in, and fails the check on its own.
//
// The check runs against BUILT, PACKED output for two reasons: type-only
// imports must be proven erased rather than assumed erased, and the published
// tarball inlines the whole @internal scope, so only the packed graph shows
// what a consumer actually loads.
//
// Requires @prisma/composer to be built (`pnpm turbo run build
// --filter=@prisma/composer`).
//
// Usage: node scripts/check-family-static-graph.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bare specifiers that must never appear in either graph, matched on the package name. */
const FORBIDDEN = [/^alchemy(\/|$)/, /^effect(\/|$)/, /^@effect\//];

const CHECKS = [
  {
    entry: 'dist/family.mjs',
    // Must appear among the bare imports, or the walk found nothing and
    // would pass vacuously.
    expectedSpecifier: /^@prisma\/cli-engine(\/|$)/,
    expectedDescription: 'a @prisma/cli-engine import',
    // The operations' executor boundary lives in this graph, on purpose.
    allowDynamicImports: true,
  },
  {
    entry: 'dist/testing.mjs',
    // The non-vacuous marker here is chunk content, not an import: the
    // double's constructor must be defined in the walked source.
    expectedSource: /createControlDouble/,
    expectedDescription: 'the createControlDouble definition',
    allowDynamicImports: false,
  },
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composerDir = join(repoRoot, 'packages/9-public/composer');

/**
 * Static import specifiers of one built module. Deliberately does NOT match
 * `import(...)` — a dynamic import is exactly the boundary this check exists
 * to preserve, so following one would defeat the purpose. tsdown/rolldown
 * emits every static import as its own top-level statement, which is what
 * makes the line-anchored scan reliable here.
 */
function staticImports(source) {
  const specifiers = [];
  for (const line of source.split('\n')) {
    if (!/^\s*(?:import|export)\b/.test(line)) continue;
    const from = /(?:^\s*import|\bfrom)\s*["']([^"']+)["']/.exec(line);
    if (from !== null) specifiers.push(from[1]);
  }
  return specifiers;
}

/** Walks one entry's static graph inside the packed tree. */
function walk(packedRoot, entryRelative) {
  const entry = join(packedRoot, entryRelative);
  if (!existsSync(entry)) {
    throw new Error(
      `the packed tarball has no ${entryRelative} — is the entry in tsdown.config.ts?`,
    );
  }
  const bareSpecifiers = new Map();
  const sources = [];
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf-8');
    sources.push(source);
    for (const specifier of staticImports(source)) {
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier));
        continue;
      }
      if (!bareSpecifiers.has(specifier)) bareSpecifiers.set(specifier, file);
    }
  }
  process.stderr.write(
    `walked ${seen.size} module(s) from ${entryRelative}; bare imports: ${[...bareSpecifiers.keys()].sort().join(', ') || '(none)'}\n`,
  );
  return { bareSpecifiers, source: sources.join('\n'), moduleCount: seen.size };
}

let work;
const failures = [];
try {
  work = mkdtempSync(join(tmpdir(), 'family-graph-'));
  // pnpm pack, not npm pack: it rewrites `workspace:` specifiers the way a
  // real publish does.
  execFileSync('pnpm', ['pack', '--pack-destination', work], {
    cwd: composerDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('pnpm pack produced no tarball for @prisma/composer');
  execFileSync('tar', ['xzf', tarball], { cwd: work });
  const packedRoot = join(work, 'package');

  for (const check of CHECKS) {
    const { bareSpecifiers, source } = walk(packedRoot, check.entry);

    for (const [specifier, importer] of bareSpecifiers) {
      if (FORBIDDEN.some((pattern) => pattern.test(specifier))) {
        failures.push(
          `"${specifier}" is statically reachable from ${check.entry} (imported by ${importer.split('/package/')[1] ?? importer}). ` +
            'Something now imports an executor directly instead of behind its `await import()`.',
        );
      }
    }
    if (!check.allowDynamicImports && /\bimport\s*\(/.test(source)) {
      failures.push(
        `${check.entry}'s graph contains a dynamic import(). The double must reach the real operation modules through type-only imports; ` +
          'a dynamic import here means the real control implementation was inlined into the testing chunk.',
      );
    }
    const marker =
      check.expectedSpecifier !== undefined
        ? [...bareSpecifiers.keys()].some((s) => check.expectedSpecifier.test(s))
        : check.expectedSource.test(source);
    if (!marker) {
      failures.push(
        `the walk from ${check.entry} found no ${check.expectedDescription}, so it proved nothing. ` +
          'Either the entry is wrong, or the import scan failed to parse the built output.',
      );
    }
  }
} finally {
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(
    `\nFAIL — the published static graphs:\n${failures.map((f) => `  - ${f}\n`).join('')}`,
  );
  process.exit(1);
}
process.stderr.write(
  '\nOK — dist/family.mjs and dist/testing.mjs are free of alchemy and effect, and the testing graph carries no dynamic imports.\n',
);
