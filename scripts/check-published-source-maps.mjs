#!/usr/bin/env node
// Every source map the three public packages publish must lead a user back to
// our TypeScript, and `@prisma/composer-prisma-cloud/auth/testing` must not
// carry its own copy of the Prisma ORM.
//
// The public packages bundle the internal packages' built `dist`, which in
// turn bundles other internal packages' `dist`. Rolldown does not read the map
// beside a built input file on its own, so without the
// `carryIncomingSourceMaps` plugin in `@internal/tsdown-config` each step names
// the previous step's `dist` file as its source, and a stack trace or debugger
// lands in generated code the user does not have.
//
// For each map in each public package's `dist`, a source fails when it is an
// absolute path, or when it is our own code (not under `node_modules/`) and
// still sits in a `dist` folder. A JavaScript map also fails when it lacks
// `sourcesContent` for our own code. Declaration maps are exempt from that
// last rule: TypeScript never writes `sourcesContent` into them, and
// rolldown-plugin-dts strips it.
//
// The ORM is a peer dependency the app installs (ADR-0046). `auth/testing`
// once inlined it with `prettier`, about 8 MB, because its tsdown pass
// inlined every `@prisma/` package. The check reads the maps of
// `dist/auth/testing.mjs` and every chunk it imports, and fails on any
// source from `@prisma/orm-*` or `prettier`. That relies on the maps being
// composed: an uncomposed map names only the internal `dist` file, which the
// first half of this check already rejects.
//
// Requires the three public packages to be built.
//
// Usage: node scripts/check-published-source-maps.mjs

import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['composer', 'composer-cli', 'composer-prisma-cloud'].map((name) =>
  join(repoRoot, 'packages/9-public', name, 'dist'),
);
const AUTH_TESTING = join(
  repoRoot,
  'packages/9-public/composer-prisma-cloud/dist/auth/testing.mjs',
);
const FORBIDDEN_IN_AUTH_TESTING = /node_modules\/(?:@prisma\/orm-|prettier\/)/;

const failures = [];
const report = (file, message) => failures.push(`${relative(repoRoot, file)}: ${message}`);

function readMap(mapFile) {
  return JSON.parse(readFileSync(mapFile, 'utf8'));
}

function isThirdParty(source) {
  return source.includes('node_modules/');
}

for (const dist of PACKAGES) {
  if (!existsSync(dist)) {
    report(dist, 'missing; build the public packages first');
    continue;
  }
  const mapFiles = globSync('**/*.map', { cwd: dist }).sort();
  if (mapFiles.length === 0) report(dist, 'contains no source maps');
  for (const name of mapFiles) {
    const mapFile = join(dist, name);
    const map = readMap(mapFile);
    const isDeclarationMap = /\.d\.[cm]?ts\.map$/.test(name);
    for (const [index, source] of (map.sources ?? []).entries()) {
      if (isAbsolute(source)) {
        report(mapFile, `source is an absolute path: ${source}`);
        continue;
      }
      if (isThirdParty(source)) continue;
      if (/(?:^|\/)dist\//.test(source))
        report(mapFile, `source is built output, not our TypeScript: ${source}`);
      if (!isDeclarationMap && typeof map.sourcesContent?.[index] !== 'string') {
        report(mapFile, `no sourcesContent for ${source}`);
      }
    }
  }
}

function relativeImports(file) {
  const code = readFileSync(file, 'utf8');
  const specifiers = code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g);
  return [...specifiers]
    .map((match) => resolve(dirname(file), match[1]))
    .filter((imported) => existsSync(imported));
}

if (existsSync(AUTH_TESTING)) {
  const seen = new Set();
  const queue = [AUTH_TESTING];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...relativeImports(file));
    const mapFile = `${file}.map`;
    if (!existsSync(mapFile)) continue;
    const inlined = (readMap(mapFile).sources ?? []).filter((source) =>
      FORBIDDEN_IN_AUTH_TESTING.test(source),
    );
    if (inlined.length > 0) {
      report(
        file,
        `inlines ${inlined.length} source files of the Prisma ORM or prettier, which the app installs itself; first: ${inlined[0]}`,
      );
    }
  }
} else {
  report(AUTH_TESTING, 'missing; build @prisma/composer-prisma-cloud first');
}

if (failures.length > 0) {
  console.error(`Published source maps: ${failures.length} problem(s)\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('Published source maps name our TypeScript, and auth/testing inlines no Prisma ORM.');
