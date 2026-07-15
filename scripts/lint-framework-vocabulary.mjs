#!/usr/bin/env node
/**
 * Domain-vocabulary guardrail (ported from prisma-next's
 * lint-framework-target-imports.mjs). Fails if a forbidden vocabulary word
 * appears anywhere in a domain's shipped source — including comments and
 * naming, not just import specifiers.
 *
 * The framework domain (`@prisma/compose` core, `packages/0-framework`) is
 * target-agnostic: it must never name a specific database/target, so a helper
 * whose Postgres-ness lives in a doc comment or an identifier is exactly the
 * leak this catches (unlike `lint:deps`'s import graph, which sees only real
 * `import` statements). Scoped per domain and extensible via
 * FORBIDDEN_VOCABULARY.
 *
 * Exits 1 (printing `file:line: <term>: <line>`) on any violation; else 0.
 * An optional CLI arg overrides the scanned repo root (used by the tests).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * domain root (relative to the repo root) → forbidden terms. Each term is
 * matched case-insensitively as a substring, so `postgres`, `Postgres`, and
 * `PostgreSQL` all trip. Add domains/terms here as the layering rules grow.
 */
export const FORBIDDEN_VOCABULARY = {
  // The framework domain is target-agnostic — it must not name a specific
  // database/target, not even in a comment.
  'packages/0-framework': ['postgres'],
};

const INCLUDED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.tmp-output',
  // Generated-for-user-projects / non-shipped code (matches the source).
  'templates',
  'recordings',
  'fixtures',
  // Framework tests legitimately use `postgres://x` as example data — not a
  // domain leak; the guard is for shipped framework code.
  '__tests__',
]);

/** A directory to skip entirely during the walk. */
function isExcludedDir(name) {
  return EXCLUDED_DIRECTORIES.has(name) || name.startsWith('dist-tsc');
}

/** A test file (by name) — excluded, like the `__tests__/` dirs. */
function isTestFile(name) {
  return /\.(test|test-d|spec)\./.test(name);
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!isExcludedDir(entry)) yield* walk(full);
    } else if (
      stat.isFile() &&
      INCLUDED_EXTENSIONS.has(extname(full)) &&
      !isTestFile(basename(full))
    ) {
      yield full;
    }
  }
}

/**
 * Every `{ file, line, term, text }` violation of `forbiddenVocabulary` under
 * `baseDir`. Scans EVERY line (comments included — a doc comment naming a
 * forbidden term is the leak). Pure and base-dir-parameterised so tests can
 * point it at a fixture.
 */
export function findVocabularyViolations(baseDir, forbiddenVocabulary) {
  const violations = [];
  for (const [domainRoot, terms] of Object.entries(forbiddenVocabulary)) {
    const lowerTerms = terms.map((term) => term.toLowerCase());
    for (const file of walk(join(baseDir, domainRoot))) {
      const contents = readFileSync(file, 'utf8');
      const contentsLower = contents.toLowerCase();
      if (!lowerTerms.some((term) => contentsLower.includes(term))) continue;
      const lines = contents.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        for (let t = 0; t < terms.length; t++) {
          if (lineLower.includes(lowerTerms[t])) {
            violations.push({
              file: relative(baseDir, file),
              line: i + 1,
              term: terms[t],
              text: lines[i].trim(),
            });
          }
        }
      }
    }
  }
  return violations;
}

function main() {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const baseDir = process.argv[2] ?? repoRoot;
  const violations = findVocabularyViolations(baseDir, FORBIDDEN_VOCABULARY);

  if (violations.length > 0) {
    console.error(
      `Found ${violations.length} forbidden-vocabulary violation(s) in a framework domain:`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}: ${v.term}: ${v.text}`);
    }
    console.error(
      '\nA framework domain must stay target-agnostic — do not name a specific ' +
        'database/target in shipped source, even in a comment or identifier. Move ' +
        'target-specific code to its domain (e.g. packages/1-prisma-cloud).',
    );
    process.exit(1);
  }

  console.log('lint:framework-vocabulary: no forbidden vocabulary found in the framework domains.');
}

// Run only when invoked directly, so tests can import the helpers.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
