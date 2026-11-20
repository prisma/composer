#!/usr/bin/env node
// Reads the built `dist` of the three public packages and fails when:
// - a `.mjs` file has no `.map` beside it, unless it only re-exports other
//   chunks or is rolldown's runtime chunk;
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

import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceMapProblems } from './check-published-source-maps-utils.mjs';

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
