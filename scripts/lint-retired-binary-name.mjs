#!/usr/bin/env node
/**
 * Keeps the retired standalone Composer binary's name out of what users read
 * and run. The `prisma` CLI runs `deploy` and `dev`; `destroy` and `log` are
 * operations on `@prisma/composer/control`. Fails on:
 *
 * - the old binary's name as a standalone token, in any form (a command, a
 *   wrapped shell line, `$ <name>`, a package runner, prose);
 * - `bin/<name>`;
 * - the retired config file's name.
 *
 * Names that only start with the old name are not tokens: the
 * `<name>-<suffix>` packages, skill and state project, the `.<name>/` state
 * directory and `<name>.map.json`.
 *
 * Scanned: the root Markdown files, docs/guides, docs/oss, skills,
 * skills-contrib, examples, website, .github, and the packages' shipped
 * source, whose error messages and generated-file headers users read at run
 * time. Package tests and fixtures are skipped: they assert on the legacy
 * diagnostics and use the state directory.
 *
 * Files that name the old binary or config file on purpose are allowlisted
 * with their exact number of findings, so an added mention still fails and a
 * removed one flags the stale entry.
 *
 * Exits 1 (printing `file:line: <kind>: <line>`) on any finding; else 0.
 * An optional CLI arg overrides the scanned repo root (used by the tests).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKED_PATHS = [
  'docs/guides',
  'docs/oss',
  'skills',
  'skills-contrib',
  'examples',
  'website',
  '.github',
  'packages',
];

/**
 * Files that name the old binary or config file on purpose, with their exact
 * number of findings.
 */
export const ALLOWED_MENTIONS = {
  // Migration passages: the retired config file is no longer read.
  'docs/guides/deploying.md': 3,
  'skills/prisma-composer-core-concepts/SKILL.md': 2,
  // The legacy-file diagnostic, which names the retired config file.
  'packages/0-framework/3-tooling/cli/src/composer-config.ts': 5,
  // Historical records of what was run at the time.
  'gotchas.md': 2,
  'open-chat-port-friction.md': 5,
};

/** Build output and state, skipped wherever they appear. */
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.alchemy',
  '.next',
  '.turbo',
  '.prisma-composer',
]);

/** Generated copies of checked sources, both gitignored. */
const EXCLUDED_PATHS = new Set([
  // The guides, rendered at build time.
  'website/src/generated',
  // The skill, staged into the package at pack time.
  'packages/9-public/composer/skills',
]);

/** Package tests and fixtures, which assert on the legacy diagnostics. */
const EXCLUDED_PACKAGE_DIRECTORIES = new Set(['__tests__', 'fixtures', 'test']);

const OLD_NAME = 'prisma-composer';

const PATTERNS = [
  // A `.` ends the token only at the end of a sentence; `.config` and `.map` continue a name.
  { kind: 'binary name', pattern: new RegExp(`(?<![\\w/.])${OLD_NAME}(?![\\w-]|\\.\\w)`, 'g') },
  { kind: 'binary path', pattern: new RegExp(`bin/${OLD_NAME}(?![\\w-]|\\.\\w)`, 'g') },
  { kind: 'config file', pattern: new RegExp(`${OLD_NAME}\\.config`, 'g') },
];

function isTestFile(name) {
  return /\.(test|test-d|spec)\.[cm]?[jt]sx?$/.test(name);
}

function* walk(baseDir, path) {
  const relativePath = relative(baseDir, path).split('\\').join('/');
  if (EXCLUDED_PATHS.has(relativePath) || !existsSync(path)) return;
  const inPackages = relativePath.startsWith('packages/');
  const stat = statSync(path);
  if (stat.isFile()) {
    if (!(inPackages && isTestFile(path))) yield relativePath;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (EXCLUDED_DIRECTORIES.has(entry)) continue;
    if (inPackages && EXCLUDED_PACKAGE_DIRECTORIES.has(entry)) continue;
    yield* walk(baseDir, join(path, entry));
  }
}

function checkedFiles(baseDir) {
  const rootMarkdown = readdirSync(baseDir).filter(
    (entry) => entry.endsWith('.md') && statSync(join(baseDir, entry)).isFile(),
  );
  return [
    ...rootMarkdown,
    ...CHECKED_PATHS.flatMap((path) => [...walk(baseDir, join(baseDir, path))]),
  ];
}

/**
 * Every `{ file, line, kind, text }` finding under `baseDir`. Pure and
 * parameterised by base directory and allowlist so tests can use a fixture.
 */
export function findRetiredNameMentions(baseDir, allowedMentions) {
  const byFile = new Map();
  for (const file of checkedFiles(baseDir)) {
    const contents = readFileSync(join(baseDir, file), 'utf8');
    if (!contents.includes(OLD_NAME)) continue;
    for (const [index, text] of contents.split('\n').entries()) {
      for (const { kind, pattern } of PATTERNS) {
        for (const _ of text.matchAll(pattern)) {
          const found = byFile.get(file) ?? [];
          found.push({ file, line: index + 1, kind, text: text.trim() });
          byFile.set(file, found);
        }
      }
    }
  }

  const findings = [];
  const files = new Set([...byFile.keys(), ...Object.keys(allowedMentions)]);
  for (const file of [...files].sort()) {
    const found = byFile.get(file) ?? [];
    const allowed = allowedMentions[file] ?? 0;
    if (found.length === allowed) continue;
    if (allowed === 0) {
      findings.push(...found);
      continue;
    }
    const note = `(${allowed} allowed, ${found.length} found)`;
    if (found.length === 0) {
      findings.push({
        file,
        line: 0,
        kind: `allowlist ${note}`,
        text: 'update ALLOWED_MENTIONS in scripts/lint-retired-binary-name.mjs',
      });
    }
    for (const finding of found) findings.push({ ...finding, kind: `${finding.kind} ${note}` });
  }
  return findings;
}

function main() {
  const baseDir = process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const findings = findRetiredNameMentions(baseDir, ALLOWED_MENTIONS);

  if (findings.length > 0) {
    console.error(`Found ${findings.length} mention(s) of the retired ${OLD_NAME} binary:`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.kind}: ${f.text}`);
    console.error(
      '\nThe `prisma` CLI runs `deploy` and `dev`; teardown and logs are the `destroy` and ' +
        '`log` operations on @prisma/composer/control. Write those instead.',
    );
    process.exit(1);
  }

  console.log(`lint:retired-binary-name: no mentions of the retired ${OLD_NAME} binary.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
