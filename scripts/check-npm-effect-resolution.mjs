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
// A third, adversarial shape reproduces the tree that broke 0.6.0 in the
// field: the app ALSO depends on `@effect/platform-node-shared@^4.0.0-beta.93`,
// which npm floats to the newest beta, dragging its newer `effect` peer to the
// root — over our exact pins, with only a warning (empirically verified; a
// peerDependency does not prevent it either). Nothing we declare can stop
// that, so the acceptance there is the CLI's own start-up check: running the
// built `prisma-composer` in that broken tree must exit non-zero with our
// actionable error, not the Schedule TypeError. The healthy shapes assert the
// inverse: the check must NOT trip on a good tree.
//
// Requires the two public packages to be built (`pnpm turbo build
// --filter=@prisma/composer --filter=@prisma/composer-prisma-cloud`) and
// network access to the npm registry.
//
// Usage: node scripts/check-npm-effect-resolution.mjs

import { execFileSync, spawnSync } from 'node:child_process';
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

/** The stable marker of the CLI's own start-up check (check-effect-resolution.ts). */
const CLI_CHECK_MARKER = 'alchemy resolves effect@';

function installApp(label, tarballs, extraDependencies = {}) {
  const appDir = join(work, label);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: label, private: true, dependencies: extraDependencies }),
  );
  process.stderr.write(`\n[${label}] npm install ${tarballs.length} tarball(s)...\n`);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
    cwd: appDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return appDir;
}

/** The version of the `effect` that Node resolves from alchemy's installed position, plus its entry path. */
function effectSeenByAlchemy(label, appDir) {
  const alchemyDir = join(appDir, 'node_modules', 'alchemy');
  if (!existsSync(alchemyDir)) fail(`[${label}] alchemy is not installed`);
  const requireFromAlchemy = createRequire(join(alchemyDir, 'noop.js'));
  const entry = requireFromAlchemy.resolve('effect');
  let pkgDir = dirname(entry);
  while (!existsSync(join(pkgDir, 'package.json'))) pkgDir = dirname(pkgDir);
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')).version;
  return { version, entry };
}

/** Runs the built prisma-composer bin with `deploy app.ts` in the scratch app; returns { status, output }. */
function runCli(label, appDir) {
  const bin = join(appDir, 'node_modules', '.bin', 'prisma-composer');
  if (!existsSync(bin)) fail(`[${label}] the prisma-composer bin is not installed`);
  const result = spawnSync(bin, ['deploy', 'app.ts'], { cwd: appDir, encoding: 'utf-8' });
  if (result.error) fail(`[${label}] failed to spawn the prisma-composer bin: ${result.error}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function checkShape(label, tarballs) {
  const appDir = installApp(label, tarballs);

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

  const { version: resolvedVersion, entry: effectEntry } = effectSeenByAlchemy(label, appDir);
  process.stderr.write(`[${label}] alchemy resolves effect@${resolvedVersion} (${effectEntry})\n`);
  if (resolvedVersion !== pinnedEffect) {
    fail(`[${label}] alchemy resolves effect@${resolvedVersion}, expected ${pinnedEffect}`);
  }

  const { Schedule } = await import(pathToFileURL(effectEntry).href);
  if (typeof Schedule.either !== 'function') {
    fail(`[${label}] Schedule.either is missing from the effect alchemy resolves`);
  }

  // The CLI's start-up check must NOT trip on this healthy tree — the deploy
  // should get past it and fail on the app itself (no entry/config here).
  const cli = runCli(label, appDir);
  if (cli.output.includes(CLI_CHECK_MARKER)) {
    fail(`[${label}] the CLI's effect check misfired on a healthy tree:\n${cli.output}`);
  }

  process.stderr.write(`[${label}] OK — single effect@${pinnedEffect}, Schedule.either present\n`);
}

// The operator's failing chain: a direct dependency on
// `@effect/platform-node-shared@^4.0.0-beta.93` floats to the newest beta and
// hoists its newer `effect` peer over our pins (install still exits 0). In
// that tree the built CLI must refuse to deploy with our clear error.
async function checkAdversarialShape(tarballs) {
  const label = 'adversarial-node-shared-float';
  let appDir;
  try {
    appDir = installApp(label, tarballs, {
      '@effect/platform-node-shared': '^4.0.0-beta.93',
    });
  } catch {
    // Also acceptable: npm refuses the conflicted install outright.
    process.stderr.write(`[${label}] OK — npm refused the conflicting install\n`);
    return;
  }

  const { version: resolvedVersion } = effectSeenByAlchemy(label, appDir);
  process.stderr.write(`[${label}] alchemy resolves effect@${resolvedVersion}\n`);
  if (resolvedVersion === pinnedEffect) {
    process.stderr.write(
      `[${label}] note: npm kept the pinned effect at alchemy's position — the shape is no ` +
        'longer adversarial under this npm version\n',
    );
    return;
  }

  const cli = runCli(label, appDir);
  if (cli.status === 0) {
    fail(`[${label}] the CLI exited 0 in a tree where alchemy resolves effect@${resolvedVersion}`);
  }
  if (!cli.output.includes(CLI_CHECK_MARKER)) {
    fail(
      `[${label}] the CLI failed without the effect check's error (expected "${CLI_CHECK_MARKER}"):\n` +
        cli.output,
    );
  }
  if (/is not a function/.test(cli.output)) {
    fail(`[${label}] the CLI crashed with a TypeError instead of the effect check:\n${cli.output}`);
  }
  process.stderr.write(
    `[${label}] OK — broken tree detected at start-up with the actionable error\n`,
  );
}

work = mkdtempSync(join(tmpdir(), 'npm-effect-check-'));
try {
  const tarballDir = join(work, 'tarballs');
  mkdirSync(tarballDir, { recursive: true });
  const composerTgz = packInto(composerDir, tarballDir);
  const prismaCloudTgz = packInto(prismaCloudDir, tarballDir);

  await checkShape('composer-only', [composerTgz]);
  await checkShape('composer-and-prisma-cloud', [composerTgz, prismaCloudTgz]);
  await checkAdversarialShape([composerTgz, prismaCloudTgz]);

  process.stderr.write(
    `\nOK — npm dedupes to a single effect@${pinnedEffect} in the healthy shapes, and the CLI ` +
      'catches the adversarial tree at start-up.\n',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
