#!/usr/bin/env node
// Every published entry of @prisma/composer and @prisma/composer-cli must
// load in a fresh `node`.
//
// `engines.node` is a promise about the version a consumer installs on, and
// until this existed nothing in CI kept that promise past `--version`. The
// node-floor job smoked `dist/bin.mjs --version` and `--help`, but the CLI
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
// Requires both packages to be built (`pnpm turbo run build
// --filter=@prisma/composer --filter=@prisma/composer-cli`). Uses whichever
// `node` is running it, which is what lets the node-floor job aim it at
// 22.18.0.
//
// Usage: node scripts/check-floor-imports.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Only @prisma/composer has a MUST_COVER: its ./deploy entry reaches the
// executors, so it loads alchemy, effect and the whole provider tree — if
// the exports map ever stops naming it, every remaining entry is cheap
// start-up code and this check would pass while proving nothing.
// @prisma/composer-cli has none on purpose: its family/testing entries are
// start-up code by design (the executor boundary keeps the heavy graph
// behind `await import()`), so there is no executor-reaching export to
// demand — every export must still import cleanly.
const PACKAGES = [
  { dir: 'packages/9-public/composer', mustCover: './deploy' },
  { dir: 'packages/9-public/composer-cli', mustCover: undefined },
];

// An entry that hangs on import has to fail this check, not stall it. spawnSync
// blocks until the child exits, and ci.yml sets no timeout-minutes, so an
// unbounded wait would hold the runner for GitHub's six-hour default and end
// the log mid-list. SIGKILL rather than the SIGTERM default because spawnSync
// keeps waiting on a child that handles SIGTERM and declines to exit; on
// 22.18.0 that pairing never returns at all. The heaviest entry (./deploy)
// imports in about two seconds, so a minute is slack, not a deadline.
const IMPORT_TIMEOUT_MS = 60_000;
const IMPORT_KILL_SIGNAL = 'SIGKILL';

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
let total = 0;

for (const { dir, mustCover } of PACKAGES) {
  const pkgDir = join(repoRoot, dir);
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
  const entries = Object.entries(manifest.exports)
    .map(([subpath, target]) => [subpath, typeof target === 'string' ? target : target.import])
    .filter(([, target]) => typeof target === 'string' && target.endsWith('.mjs'));

  if (mustCover !== undefined && !entries.some(([subpath]) => subpath === mustCover)) {
    process.stderr.write(
      `FAIL — the exports map of ${manifest.name} no longer has "${mustCover}", so this check would ` +
        'cover only start-up code and pass vacuously. Point mustCover at whatever entry now reaches ' +
        'the executors.\n',
    );
    process.exit(1);
  }

  process.stderr.write(
    `importing ${entries.length} entrypoint(s) of ${manifest.name} with ${process.version}\n`,
  );
  total += entries.length;

  for (const [subpath, target] of entries) {
    const file = join(pkgDir, target);
    if (!existsSync(file)) {
      failures.push(`${manifest.name} ${subpath} -> ${target} is missing. Is the build stale?`);
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
      process.stderr.write(`  ok   ${manifest.name} ${subpath}\n`);
      continue;
    }
    process.stderr.write(`  FAIL ${manifest.name} ${subpath}\n`);
    failures.push(
      `${manifest.name} ${subpath} ${describeFailure(result)} on ${process.version} ` +
        `(engines.node: ${manifest.engines.node}):\n` +
        `${(result.stderr || '(no stderr)').trimEnd()}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `\nFAIL — ${failures.length} of ${total} entrypoint(s) do not load on ${process.version}:\n\n` +
      `${failures.map((f) => `${f}\n\n`).join('')}`,
  );
  process.exit(1);
}
process.stderr.write(`\nOK — all ${total} published entrypoint(s) load on ${process.version}.\n`);
