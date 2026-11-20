#!/usr/bin/env node
// Reads the built `dist` of the three public packages and fails when:
// - a `.mjs` file has no `.map` beside it, unless it holds only import and
//   export lines or is rolldown's runtime chunk;
// - a map source is an absolute path (POSIX or Windows) or a URL;
// - a map names our own code (not under `node_modules/`, or under
//   `node_modules/@internal/`) inside a `dist` folder instead of its `.ts`;
// - a JavaScript map has no `sourcesContent` for our own code;
// - a map has a source from `@prisma/orm-*` or `prettier`: the app installs
//   the Prisma ORM, and Composer must not ship a copy (ADR-0046).
//
// Declaration maps are exempt from the `sourcesContent` rule: TypeScript does
// not write it into them, and rolldown-plugin-dts strips it.
//
// Requires the three public packages to be built.
//
// Usage: node scripts/check-published-source-maps.mjs

import { existsSync, globSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ABSOLUTE_OR_URL = /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i;
const ORM_OR_PRETTIER = /(?:^|\/)node_modules\/(?:@prisma\/orm-|prettier\/)/;
const IN_DIST = /(?:^|\/)dist\//;

function isOwnCode(source) {
  return !source.includes('node_modules/') || source.includes('node_modules/@internal/');
}

function needsNoMap(file) {
  if (basename(file).startsWith('rolldown-runtime-')) return true;
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  return lines.every((line) => /^(?:import|export)\b/.test(line));
}

/** Every problem with the source maps in `distDirs`, one message each. */
export function sourceMapProblems(distDirs) {
  const problems = [];
  for (const dist of distDirs) {
    if (!existsSync(dist)) {
      problems.push(`${dist}: missing; build the public packages first`);
      continue;
    }
    for (const name of globSync('**/*.mjs', { cwd: dist }).sort()) {
      const file = join(dist, name);
      if (!existsSync(`${file}.map`) && !needsNoMap(file))
        problems.push(`${file}: has no source map`);
    }
    for (const name of globSync('**/*.map', { cwd: dist }).sort()) {
      const mapFile = join(dist, name);
      const map = JSON.parse(readFileSync(mapFile, 'utf8'));
      const isDeclarationMap = /\.d\.[cm]?ts\.map$/.test(name);
      const inlined = [];
      for (const [index, source] of (map.sources ?? []).entries()) {
        if (ABSOLUTE_OR_URL.test(source)) {
          problems.push(`${mapFile}: source is an absolute path or URL: ${source}`);
          continue;
        }
        if (ORM_OR_PRETTIER.test(source)) inlined.push(source);
        if (!isOwnCode(source)) continue;
        if (IN_DIST.test(source))
          problems.push(`${mapFile}: source is built output, not our TypeScript: ${source}`);
        if (!isDeclarationMap && typeof map.sourcesContent?.[index] !== 'string') {
          problems.push(`${mapFile}: no sourcesContent for ${source}`);
        }
      }
      if (inlined.length > 0) {
        problems.push(
          `${mapFile}: inlines ${inlined.length} source files of the Prisma ORM or prettier, which the app installs itself; first: ${inlined[0]}`,
        );
      }
    }
  }
  return problems;
}

function isDirectRun() {
  return (
    process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())
  );
}

if (isDirectRun()) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dists = ['composer', 'composer-cli', 'composer-prisma-cloud'].map((name) =>
    join(repoRoot, 'packages/9-public', name, 'dist'),
  );
  const problems = sourceMapProblems(dists).map((problem) =>
    problem.replace(`${repoRoot}${sep}`, ''),
  );
  if (problems.length > 0) {
    console.error(`Published source maps: ${problems.length} problem(s)\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    'Every published source map names our TypeScript, and none carries the Prisma ORM or prettier.',
  );
}
