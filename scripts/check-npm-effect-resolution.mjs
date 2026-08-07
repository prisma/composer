#!/usr/bin/env node
// Regression check for TML-3158: a standalone `npm install` of the public
// packages must resolve exactly ONE `effect` — the version the packages pin —
// and alchemy's position in the tree must resolve that copy.
//
// Why: alchemy declares floating ranges on the effect ecosystem
// (`@effect/vitest`, optional platform peers, `effect` itself). Without exact,
// mutually consistent pins of the whole constellation in the public packages,
// npm installs a second `effect` and hoists it where alchemy resolves it — the
// first `prisma-composer deploy` then dies inside a provider it never asked
// for, with a `TypeError` naming a combinator that version removed. pnpm in
// this workspace only warns, so the break is invisible in-repo; this check
// installs the real tarballs with real npm against the real registry.
//
// A third, adversarial shape puts an `effect` we did not pin where alchemy
// resolves it. In the field (0.6.0) that happened by hoisting: an app
// dependency whose own `effect` peer sat above our pin dragged its version to
// the root over our exact pins, with only a warning — empirically verified,
// and a peerDependency does not prevent it either. This shape builds the same
// end state with an npm `override` instead, because the hoisting route only
// reproduces while a suitable release exists relative to our pin, which made
// the check hostage to the registry. Nothing we declare can stop a consumer's
// tree going wrong, so the acceptance is the CLI's own start-up check: running
// the built `prisma-composer` there must exit non-zero with our actionable
// error rather than crashing inside alchemy. The healthy shapes assert the
// inverse: the check must NOT trip on a good tree, and the built bin must
// still start — which is what proves the resolved `effect` genuinely satisfies
// alchemy, since starting loads alchemy's provider tree.
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
import { fileURLToPath } from 'node:url';

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

// The consumer-side workaround for the upstream alchemy bug (the
// "TaggedErrorClass" drift): alchemy's own `effect`-family dependency and
// peer ranges float (`>=4.0.0-beta.100 || >=4.0.0`) past the versions its
// shipped code can actually run, so a fresh npm install resolves the floaters
// to the newest beta, whose peer floors reject our pin and drag in a second
// `effect`. Until alchemy fixes its ranges, every consumer tree (the
// examples, the getting-started guide, and the healthy shapes here) pins the
// whole constellation with this overrides block; delete it — here, in
// examples/*, and in the docs — when alchemy's ranges match its code.
const CONSTELLATION_OVERRIDES = {
  effect: pinnedEffect,
  '@effect/sql-d1': pinnedEffect,
  '@effect/sql-pg': pinnedEffect,
  '@effect/vitest': pinnedEffect,
  '@effect/platform-bun': pinnedEffect,
  '@effect/platform-node': pinnedEffect,
  '@effect/platform-node-shared': pinnedEffect,
};

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

/** Runs `npm install` for a scratch app; returns { appDir, status, output } instead of throwing so callers can judge HOW an install failed. */
function installApp(label, tarballs, extraDependencies = {}, overrides = undefined) {
  const appDir = join(work, label);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({
      name: label,
      private: true,
      dependencies: extraDependencies,
      ...(overrides === undefined ? {} : { overrides }),
    }),
  );
  process.stderr.write(`\n[${label}] npm install ${tarballs.length} tarball(s)...\n`);
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
    cwd: appDir,
    encoding: 'utf-8',
  });
  if (result.error) fail(`[${label}] failed to spawn npm: ${result.error}`);
  process.stderr.write(result.stderr);
  return { appDir, status: result.status, output: `${result.stdout}${result.stderr}` };
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

/** Runs the built prisma-composer bin in the scratch app; returns { status, output }. */
function runCli(label, appDir, args) {
  const bin = join(appDir, 'node_modules', '.bin', 'prisma-composer');
  if (!existsSync(bin)) fail(`[${label}] the prisma-composer bin is not installed`);
  const result = spawnSync(bin, args, { cwd: appDir, encoding: 'utf-8' });
  if (result.error) fail(`[${label}] failed to spawn the prisma-composer bin: ${result.error}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Asserts the bundled bin starts and reaches its own usage output. The proof is
 * the usage banner, not the exit code: a bare `--help` exits 1 on main too,
 * because clipanion reports it as a missing command.
 */
function assertCliStarts(label, appDir) {
  const help = runCli(label, appDir, ['--help']);
  if (!help.output.includes('prisma-composer <command>')) {
    fail(
      `[${label}] \`prisma-composer --help\` did not reach its usage output in a healthy tree ` +
        `(exit ${help.status}):\n${help.output}`,
    );
  }
  if (/is not a function|Cannot find module/.test(help.output)) {
    fail(`[${label}] the CLI crashed on its module graph in a healthy tree:\n${help.output}`);
  }
}

async function checkShape(label, tarballs) {
  // Healthy shapes install the way a scaffolded consumer does: with the
  // constellation overrides block the examples and getting-started guide
  // ship. The check proves that shape genuinely dedupes.
  const {
    appDir,
    status: installStatus,
    output: installOutput,
  } = installApp(label, tarballs, {}, CONSTELLATION_OVERRIDES);
  if (installStatus !== 0) {
    fail(`[${label}] npm install failed (exit ${installStatus}):\n${installOutput}`);
  }

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

  // Proof the resolved effect actually satisfies alchemy, not just that the
  // version string matches: importing the bin loads alchemy's provider tree,
  // which is where a wrong effect blows up. `assertCliStarts` below does that
  // against the built bin — a stronger check than probing for any single
  // combinator, which only ever stood in for "alchemy can run on this".

  // Positive proof the CLI actually starts in this healthy tree — without it,
  // "the failure marker is absent" would also hold for a CLI that never ran.
  assertCliStarts(label, appDir);

  // The start-up check must NOT trip on this healthy tree — the deploy should
  // get past it and fail on the app itself (no entry/config here), never on a
  // broken module graph.
  const cli = runCli(label, appDir, ['deploy', 'app.ts']);
  if (cli.output.includes(CLI_CHECK_MARKER)) {
    fail(`[${label}] the CLI's effect check misfired on a healthy tree:\n${cli.output}`);
  }
  if (/is not a function|Cannot find module/.test(cli.output)) {
    fail(`[${label}] the CLI crashed on its module graph in a healthy tree:\n${cli.output}`);
  }

  process.stderr.write(
    `[${label}] OK — single effect@${pinnedEffect}, resolved by alchemy, CLI starts\n`,
  );
}

/**
 * A published `effect` that is NOT our pin. In the field the wrong copy arrived
 * by hoisting — an app dependency whose own `effect` peer differed from ours
 * dragged its version to the root. That mechanism only reproduces while a
 * suitable release exists relative to wherever our pin sits, which made the
 * test hostage to the registry. This shape builds the same end state directly,
 * with an override, so it keeps proving the thing that matters: when alchemy
 * resolves an `effect` we did not pin, the CLI says so instead of crashing.
 */
const WRONG_EFFECT = '4.0.0-beta.93';

async function checkAdversarialShape(tarballs) {
  const label = 'adversarial-wrong-effect';
  const { appDir, status, output } = installApp(label, tarballs, {}, { effect: WRONG_EFFECT });
  if (status !== 0) {
    // Also acceptable: npm refuses the conflicted install outright — but ONLY
    // when it actually failed on the dependency conflict. Any other failure
    // (registry outage, a bug here) must fail the check, not silently pass it.
    if (/ERESOLVE|Conflicting peer dependency|unable to resolve dependency tree/i.test(output)) {
      process.stderr.write(`[${label}] OK — npm refused the conflicting install\n`);
      return;
    }
    fail(`[${label}] npm install failed for a reason other than the conflict:\n${output}`);
  }

  const { version: resolvedVersion } = effectSeenByAlchemy(label, appDir);
  process.stderr.write(`[${label}] alchemy resolves effect@${resolvedVersion}\n`);
  if (resolvedVersion === pinnedEffect) {
    fail(
      `[${label}] the override did not take: alchemy still resolves our pinned ` +
        `effect@${pinnedEffect}, so this shape proves nothing. Point WRONG_EFFECT at a ` +
        'published version other than the pin.',
    );
  }

  const cli = runCli(label, appDir, ['deploy', 'app.ts']);
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

  // Every command loads the graph that crashes, so every command must hit the
  // check first — `--help` included, or the user meets the raw TypeError there.
  const help = runCli(label, appDir, ['--help']);
  if (
    help.status === 0 ||
    !help.output.includes(CLI_CHECK_MARKER) ||
    /is not a function/.test(help.output)
  ) {
    fail(
      `[${label}] \`prisma-composer --help\` did not fail with the effect check in a broken tree ` +
        `(exit ${help.status}):\n${help.output}`,
    );
  }

  process.stderr.write(
    `[${label}] OK — broken tree caught at start-up with the actionable error, deploy and --help alike\n`,
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
