#!/usr/bin/env node
// Architecture-coverage gate (ADR-0028): makes the dependency-cruiser rules
// fail-closed. The cruiser can only rule on an edge it can see, and each of
// these was independently enough to let a plane violation land on a green gate:
//
//   1. Classification — a file matching no glob in architecture.config.json
//      joins no module group, so NO domain/layer/plane rule applies to it.
//      This is the default for every newly added file.
//   2. Aliasing — a workspace specifier missing from tsconfig.depcruise.json
//      `paths` resolves through node_modules to the package's `exports` map,
//      which points at built dist. dist is excluded, so the edge is dropped
//      entirely and no rule can fire on it.
//
// These are checks rather than defaults because neither can be guessed: a
// plane is a judgement about when code runs, and a file wrongly defaulted to
// `shared` would also weaken the rules applied to files importing it
// (ADR-0005 — we don't guess).
//
// Wired into `pnpm lint:deps` (local, lint-staged, and CI).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import architectureConfig from '../architecture.config.json' with { type: 'json' };
import cruiserConfig from '../dependency-cruiser.config.mjs';
import depcruiseTsConfig from '../tsconfig.depcruise.json' with { type: 'json' };
import {
  findUnaliasedSpecifiers,
  findUnclassifiedFiles,
  readImportSpecifiers,
} from './architecture-coverage.mjs';

// `--others` so a new, not-yet-staged file is checked too: an unclassified file
// is only ever a new one, and waiting for `git add` would miss it exactly when
// the check is most needed. `--exclude-standard` keeps .gitignore respected.
const gitLsFiles = (...globs) =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...globs], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

// The cruiser's own exclusions, so the two always agree on what is cruised.
const excluded = cruiserConfig.options.exclude.path.map((pattern) => new RegExp(pattern));

const sourceFiles = gitLsFiles('packages/**/*.ts', 'packages/**/*.mjs').filter(
  (file) => !excluded.some((pattern) => pattern.test(file)),
);

const workspacePackageNames = gitLsFiles('packages/**/package.json')
  .filter((file) => !file.includes('node_modules'))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')).name)
  .filter(Boolean);

const specifiers = sourceFiles.flatMap((file) => readImportSpecifiers(readFileSync(file, 'utf8')));

const failures = [];

const unclassified = findUnclassifiedFiles(sourceFiles, architectureConfig.packages);
if (unclassified.length > 0) {
  failures.push(
    `Unclassified source files (${unclassified.length}) — no architecture rule applies to these:\n` +
      unclassified.map((file) => `  - ${file}`).join('\n') +
      '\n  Add each to architecture.config.json with its {domain, layer, plane}.\n' +
      '  Plane: `control` = deploy-time, `execution` = runs in the deployed app, `shared` = both.',
  );
}

const unaliased = findUnaliasedSpecifiers(
  specifiers,
  workspacePackageNames,
  depcruiseTsConfig.compilerOptions.paths,
);
if (unaliased.length > 0) {
  failures.push(
    `Unaliased workspace specifiers (${unaliased.length}) — the cruiser cannot see these edges:\n` +
      unaliased.map((specifier) => `  - ${specifier}`).join('\n') +
      '\n  Add each to tsconfig.depcruise.json `paths`, pointing at the source file.\n' +
      '  Without it the import resolves to built dist, which is excluded, and the edge is dropped.',
  );
}

if (failures.length > 0) {
  console.error(`${failures.join('\n\n')}\n`);
  process.exit(1);
}
console.log(
  `✔ architecture-coverage: ${sourceFiles.length} source files classified, ` +
    `${new Set(specifiers).size} specifiers checked — every edge is visible to the cruiser`,
);
