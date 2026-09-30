#!/usr/bin/env node
/**
 * Keeps the retired standalone Composer binary out of what users read. The
 * `prisma` CLI runs `deploy` and `dev`; `destroy` and `log` are operations on
 * `@prisma/composer/control`. Fails when a checked file names the old binary
 * as a command, or names the retired config file outside the migration
 * passages allowlisted below.
 *
 * Names that merely start with the old binary's name are not mentions: the
 * `prisma-composer-<name>` packages and skill, the `.prisma-composer/` state
 * directory, `prisma-composer.map.json` and the `prisma-composer-state`
 * project.
 *
 * Exits 1 (printing `file:line: <kind>: <line>`) on any finding; else 0.
 * An optional CLI arg overrides the scanned repo root (used by the tests).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKED_PATHS = [
  'README.md',
  'docs/guides',
  'skills',
  'skills-contrib',
  'examples',
  'website',
  '.github',
];

/**
 * The migration passages that name the retired config file on purpose, with
 * the number of mentions each holds. A count that differs fails the check, so
 * a new mention cannot hide behind an existing entry.
 */
export const ALLOWED_CONFIG_FILE_MENTIONS = {
  'docs/guides/deploying.md': 3,
  'skills/prisma-composer-core-concepts/SKILL.md': 2,
};

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.alchemy',
  '.next',
  '.turbo',
  '.prisma-composer',
  // website/src/generated: the guides rendered at build time, checked at their source.
  'generated',
]);

const OLD_NAME = 'prisma-composer';

const COMMAND_PATTERNS = [
  new RegExp(`(?<![\\w.@/-])${OLD_NAME}\\s+-{0,2}[a-z]`),
  new RegExp(`bin/${OLD_NAME}(?![\\w.-])`),
  new RegExp(`\\b(?:bunx|npx|pnpx|dlx|exec)\\s+${OLD_NAME}(?![\\w.-])`),
];

const CONFIG_FILE_PATTERN = new RegExp(`${OLD_NAME}\\.config`, 'g');

function* walk(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    yield path;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (!EXCLUDED_DIRECTORIES.has(entry)) yield* walk(join(path, entry));
  }
}

function checkedFiles(baseDir) {
  return CHECKED_PATHS.flatMap((path) => [...walk(join(baseDir, path))]);
}

/**
 * Every `{ file, line, kind, text }` finding under `baseDir`. Pure and
 * parameterised by base directory and allowlist so tests can use a fixture.
 */
export function findRetiredNameMentions(baseDir, allowedConfigFileMentions) {
  const findings = [];
  const configMentions = new Map();

  for (const path of checkedFiles(baseDir)) {
    const contents = readFileSync(path, 'utf8');
    if (!contents.includes(OLD_NAME)) continue;
    const file = relative(baseDir, path).split('\\').join('/');
    const lines = contents.split('\n');
    for (const [index, text] of lines.entries()) {
      if (!text.includes(OLD_NAME)) continue;
      if (COMMAND_PATTERNS.some((pattern) => pattern.test(text))) {
        findings.push({ file, line: index + 1, kind: 'command', text: text.trim() });
      }
      const count = text.match(CONFIG_FILE_PATTERN)?.length ?? 0;
      for (let i = 0; i < count; i++) {
        const mentions = configMentions.get(file) ?? [];
        mentions.push({ line: index + 1, text: text.trim() });
        configMentions.set(file, mentions);
      }
    }
  }

  const files = new Set([...configMentions.keys(), ...Object.keys(allowedConfigFileMentions)]);
  for (const file of [...files].sort()) {
    const mentions = configMentions.get(file) ?? [];
    const allowed = allowedConfigFileMentions[file] ?? 0;
    if (mentions.length === allowed) continue;
    const kind = `config file (${allowed} allowed, ${mentions.length} found)`;
    if (mentions.length === 0) {
      findings.push({
        file,
        line: 0,
        kind,
        text: 'update the allowlist in scripts/lint-retired-cli-name.mjs',
      });
    }
    for (const mention of mentions) findings.push({ file, kind, ...mention });
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function main() {
  const baseDir = process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const findings = findRetiredNameMentions(baseDir, ALLOWED_CONFIG_FILE_MENTIONS);

  if (findings.length > 0) {
    console.error(`Found ${findings.length} mention(s) of the retired ${OLD_NAME} binary:`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.kind}: ${f.text}`);
    console.error(
      '\nThe `prisma` CLI runs `deploy` and `dev`; teardown and logs are the `destroy` and ' +
        '`log` operations on @prisma/composer/control. Write those instead.',
    );
    process.exit(1);
  }

  console.log(`lint:retired-cli-name: no mentions of the retired ${OLD_NAME} binary.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
