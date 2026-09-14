#!/usr/bin/env node
// Every `@prisma/orm-*` dependency spec must be a single exact version, and
// every spec across the workspace must name the same one.
//
// The Prisma ORM shells are one system split across several published
// packages, and their types are only compatible within a version. Resolve two
// versions of one shell into a tree and the codec and operation registries
// silently diverge, `instanceof` stops holding, and a value produced by one
// copy is rejected by the other. That is why `@prisma/composer-prisma-cloud`
// declares the postgres facade as a peer rather than a dependency — a
// mismatched pair then fails at install instead.
//
// `check-publish-deps.mjs` enforces exact pins too, but only for packages the
// workspace itself publishes (membership comes from `pnpm list -r`). The
// `@prisma/orm-*` packages are external, so nothing checked them: a range on
// the peer would reintroduce, one shell over, the exact split the peer exists
// to prevent.
//
// Usage: node scripts/lint-orm-pins.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SHELL = /^@prisma\/orm-/;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const manifests = execFileSync('git', ['ls-files', '-z', '*package.json', 'package.json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean);

const problems = [];
const versions = new Map();
let specs = 0;

for (const manifest of manifests) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    continue;
  }
  for (const field of FIELDS) {
    const deps = parsed[field];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!SHELL.test(name)) continue;
      specs += 1;
      if (typeof spec !== 'string' || !EXACT.test(spec)) {
        problems.push(`${manifest} → ${field}.${name} is "${spec}", not a single exact version`);
        continue;
      }
      const seen = versions.get(spec) ?? [];
      seen.push(`${manifest} (${field}.${name})`);
      versions.set(spec, seen);
    }
  }
}

if (versions.size > 1) {
  problems.push(
    `the workspace names ${versions.size} different @prisma/orm-* versions:\n` +
      [...versions]
        .map(
          ([version, sites]) => `      ${version}\n${sites.map((s) => `        ${s}`).join('\n')}`,
        )
        .join('\n'),
  );
}

if (problems.length > 0) {
  console.error('✖ orm-pins: the Prisma ORM shells are not pinned consistently:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nEvery @prisma/orm-* spec must be one exact version, and all of them the same version.',
  );
  process.exit(1);
}

const [version] = [...versions.keys()];
console.log(`✔ orm-pins: ${specs} @prisma/orm-* spec(s), all exactly ${version ?? 'n/a'}`);
