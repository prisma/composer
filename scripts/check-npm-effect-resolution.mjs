#!/usr/bin/env node
// Regression check for TML-3158: a standalone `npm install` of the public
// packages must resolve exactly ONE `effect` — the version the packages pin —
// and alchemy's position in the tree must resolve that copy (with
// `Schedule.either`, removed in later betas, still present).
//
// Why: alchemy declares floating ranges on the effect ecosystem
// (`@effect/vitest`, optional platform peers, `effect` itself as
// `>=4.0.0-beta.84 || >=4.0.0`). Without exact, mutually consistent pins of
// the whole constellation in the public packages, npm installs a second,
// newer `effect` and hoists it where alchemy resolves it — the first
// `prisma-composer deploy` then dies with
// `TypeError: Schedule.either is not a function`. pnpm in this workspace only
// warns, so the break is invisible in-repo; this check installs the real
// tarballs with real npm against the real registry.
//
// Requires the two public packages to be built (`pnpm turbo build
// --filter=@prisma/composer --filter=@prisma/composer-prisma-cloud`) and
// network access to the npm registry.
//
// Usage: node scripts/check-npm-effect-resolution.mjs

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composerDir = join(repoRoot, 'packages/9-public/composer');
const prismaCloudDir = join(repoRoot, 'packages/9-public/composer-prisma-cloud');

/** Scratch dir holding the packed tarballs and the shape installs. */
let work;

const pinnedEffect = JSON.parse(readFileSync(join(composerDir, 'package.json'), 'utf-8'))
  .dependencies.effect;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinnedEffect)) {
  fail(`@prisma/composer's effect dependency must be an exact version, got "${pinnedEffect}"`);
}

// `process.exit` skips the normal-path cleanup, so a failure deliberately
// keeps the scratch installs and prints where they are for inspection.
function fail(message) {
  process.stderr.write(`\nFAIL — ${message}\n`);
  if (work !== undefined) {
    process.stderr.write(`Keeping the scratch installs for inspection: ${work}\n`);
  }
  process.exit(1);
}

function packInto(pkgDir, destDir) {
  // pnpm pack, not npm pack: it rewrites `workspace:` specifiers the way a
  // real publish does.
  execFileSync('pnpm', ['pack', '--pack-destination', destDir], {
    cwd: pkgDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const tarball = readdirSync(destDir).find(
    (f) => f.endsWith('.tgz') && !usedTarballs.has(join(destDir, f)),
  );
  if (!tarball) throw new Error(`pnpm pack produced no tarball for ${pkgDir}`);
  const path = join(destDir, tarball);
  usedTarballs.add(path);
  return path;
}
const usedTarballs = new Set();

/** Collects every distinct effect version in an `npm ls --json` tree. */
function collectEffectVersions(node, found = new Map()) {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (name === 'effect' && child.version) {
      found.set(child.version, (found.get(child.version) ?? 0) + 1);
    }
    collectEffectVersions(child, found);
  }
  return found;
}

async function checkShape(label, tarballs) {
  const appDir = join(work, label);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: label, private: true }));
  process.stderr.write(`\n[${label}] npm install ${tarballs.length} tarball(s)...\n`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
    cwd: appDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const tree = JSON.parse(
    execFileSync('npm', ['ls', 'effect', '--all', '--json'], { cwd: appDir, encoding: 'utf-8' }),
  );
  const versions = collectEffectVersions(tree);
  process.stderr.write(`[${label}] effect versions in tree: ${[...versions.keys()].join(', ')}\n`);
  if (versions.size !== 1 || !versions.has(pinnedEffect)) {
    fail(
      `[${label}] expected exactly one effect@${pinnedEffect} in the npm tree, ` +
        `got: ${[...versions.keys()].join(', ') || '(none)'}`,
    );
  }

  const alchemyDir = join(appDir, 'node_modules', 'alchemy');
  if (!existsSync(alchemyDir)) fail(`[${label}] alchemy is not installed`);
  const requireFromAlchemy = createRequire(join(alchemyDir, 'noop.js'));
  const effectEntry = requireFromAlchemy.resolve('effect');
  let pkgDir = dirname(effectEntry);
  while (!existsSync(join(pkgDir, 'package.json'))) pkgDir = dirname(pkgDir);
  const resolvedVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')).version;
  process.stderr.write(`[${label}] alchemy resolves effect@${resolvedVersion} (${effectEntry})\n`);
  if (resolvedVersion !== pinnedEffect) {
    fail(`[${label}] alchemy resolves effect@${resolvedVersion}, expected ${pinnedEffect}`);
  }

  const { Schedule } = await import(pathToFileURL(effectEntry).href);
  if (typeof Schedule.either !== 'function') {
    fail(`[${label}] Schedule.either is missing from the effect alchemy resolves`);
  }
  process.stderr.write(`[${label}] OK — single effect@${pinnedEffect}, Schedule.either present\n`);
}

work = mkdtempSync(join(tmpdir(), 'npm-effect-check-'));
try {
  const tarballDir = join(work, 'tarballs');
  mkdirSync(tarballDir, { recursive: true });
  const composerTgz = packInto(composerDir, tarballDir);
  const prismaCloudTgz = packInto(prismaCloudDir, tarballDir);

  await checkShape('composer-only', [composerTgz]);
  await checkShape('composer-and-prisma-cloud', [composerTgz, prismaCloudTgz]);

  process.stderr.write(`\nOK — npm dedupes to a single effect@${pinnedEffect} in both shapes.\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
