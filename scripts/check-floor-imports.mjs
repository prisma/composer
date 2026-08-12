#!/usr/bin/env node
// Every published entry of @prisma/composer must load in a fresh `node`.
//
// `engines.node` is a promise about the version a consumer installs on, and
// until this existed nothing in CI kept that promise past `--version`. The
// node-floor job smoked `dist/bin.mjs --version` and `--help`, but composer
// keeps its executors behind `await import()` (scripts/check-family-static-
// graph.mjs enforces that boundary), so start-up deliberately loads none of
// alchemy or effect. The whole constellation a `deploy` run evaluates was
// therefore never imported on the floor version by anything here, and a
// consumer running `prisma-composer deploy` was the first to find out.
//
// Each entry gets a process of its own. Sharing one would let the first
// import's module cache satisfy the rest, so a single passing entry would
// vouch for entries that were never really loaded.
//
// This is a claim about NODE. It stays out of the bun suites on purpose: bun
// resolves alchemy through the `bun` export condition, to TypeScript sources
// node never sees, so passing there would say nothing about the floor.
//
// Requires @prisma/composer to be built (`pnpm turbo run build
// --filter=@prisma/composer`). Uses whichever `node` is running it, which is
// what lets the node-floor job aim it at 22.18.0.
//
// Usage: node scripts/check-floor-imports.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Reaches the executors, so it loads alchemy, effect and the whole provider
// tree. If the exports map ever stops naming it, every remaining entry is
// cheap start-up code and this check would pass while proving nothing.
const MUST_COVER = './deploy';

// An entry that hangs on import has to fail this check, not stall it. spawnSync
// blocks until the child exits, and ci.yml sets no timeout-minutes, so an
// unbounded wait would hold the runner for GitHub's six-hour default and end
// the log mid-list. SIGKILL rather than the SIGTERM default because spawnSync
// keeps waiting on a child that handles SIGTERM and declines to exit; on
// 22.18.0 that pairing never returns at all. The heaviest entry (./deploy)
// imports in about two seconds, so a minute is slack, not a deadline.
const IMPORT_TIMEOUT_MS = 60_000;
const IMPORT_KILL_SIGNAL = 'SIGKILL';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composerDir = join(repoRoot, 'packages/9-public/composer');

const manifest = JSON.parse(readFileSync(join(composerDir, 'package.json'), 'utf-8'));
const entries = Object.entries(manifest.exports)
  .map(([subpath, target]) => [subpath, typeof target === 'string' ? target : target.import])
  .filter(([, target]) => typeof target === 'string' && target.endsWith('.mjs'));

if (!entries.some(([subpath]) => subpath === MUST_COVER)) {
  process.stderr.write(
    `FAIL — the exports map of ${manifest.name} no longer has "${MUST_COVER}", so this check would ` +
      'cover only start-up code and pass vacuously. Point MUST_COVER at whatever entry now reaches ' +
      'the executors.\n',
  );
  process.exit(1);
}

process.stderr.write(`importing ${entries.length} entrypoint(s) with ${process.version}\n`);

// spawnSync signals a timeout by setting `error` alongside the signal it sent,
// and a child that never started by setting `error` with no signal at all.
// Both leave `status` null, so reading status alone prints them identically
// and tells whoever is looking at the log nothing about which one happened.
/** @param {ReturnType<typeof spawnSync>} result */
function describeFailure(result) {
  if (result.error && result.signal === IMPORT_KILL_SIGNAL) {
    return `was killed after ${IMPORT_TIMEOUT_MS / 1000}s without finishing its import`;
  }
  if (result.error) return `could not be started (${result.error.message})`;
  if (result.status === null) return `died on signal ${result.signal}`;
  return `exited ${result.status}`;
}

const failures = [];
for (const [subpath, target] of entries) {
  const file = join(composerDir, target);
  if (!existsSync(file)) {
    failures.push(`${subpath} -> ${target} is missing. Is the build stale?`);
    continue;
  }
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import ${JSON.stringify(pathToFileURL(file).href)}`],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: IMPORT_TIMEOUT_MS,
      killSignal: IMPORT_KILL_SIGNAL,
    },
  );
  if (result.status === 0) {
    process.stderr.write(`  ok   ${subpath}\n`);
    continue;
  }
  process.stderr.write(`  FAIL ${subpath}\n`);
  failures.push(
    `${subpath} ${describeFailure(result)} on ${process.version}:\n` +
      `${(result.stderr || '(no stderr)').trimEnd()}`,
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `\nFAIL — ${failures.length} of ${entries.length} entrypoint(s) do not load on ${process.version}, ` +
      `which is below what ${manifest.name} claims in engines.node (${manifest.engines.node}):\n\n` +
      `${failures.map((f) => `${f}\n\n`).join('')}`,
  );
  process.exit(1);
}
process.stderr.write(
  `\nOK — all ${entries.length} published entrypoint(s) of ${manifest.name} load on ${process.version}.\n`,
);
