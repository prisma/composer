#!/usr/bin/env node
// `@prisma/cli-engine` must be exact-pinned, declared identically in the two
// manifests that carry it, and reach the registry as a REAL import.
//
// Why each half matters:
//
//   Exact + identical. Composer's command family runs inside whichever process
//   mounts it — composer's own CLI or the `prisma` bin — and both sides must
//   agree on the engine's types and its runtime classes. The engine and
//   composer are released in tandem (engine → composer → prisma-cli), so the
//   version is a hand-coordinated fact, not a range to be resolved. The public
//   manifest and the internal CLI manifest declare it separately (the
//   `@internal` scope is inlined at publish time, so a dependency that must
//   survive as a real import has to be mirrored into the public manifest), and
//   a drift between the two would ship a tarball whose declared engine is not
//   the one the code was built against. Dependabot is told to leave it alone
//   (.github/dependabot.yml), which is what makes this check the only guard.
//
//   External. tsdown bundles by default here (`skipNodeModulesBundle: false`),
//   so without an explicit `external` entry the engine would be INLINED into
//   the tarball. A private copy of the engine is not a copy of a library — the
//   `prisma` bin would mount composer's family into its own engine while
//   composer's handlers reached for the inlined one, and every cross-boundary
//   `instanceof` and every module-level registry would silently disagree.
//   Grepping the emitted chunks for a surviving bare specifier is what proves
//   externalization actually happened, which the manifest alone cannot say
//   (see the inventory's hazard H7).
//
// Requires @prisma/composer to be built (`pnpm turbo run build
// --filter=@prisma/composer`).
//
// Usage: node scripts/check-cli-engine-pin.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = '@prisma/cli-engine';
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(repoRoot, 'packages/9-public/composer');
const internalCliDir = join(repoRoot, 'packages/0-framework/3-tooling/cli');

const failures = [];
function require_(condition, message) {
  if (!condition) failures.push(message);
}

function manifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
}

const publicPin = manifest(publicDir).dependencies?.[ENGINE];
const internalPin = manifest(internalCliDir).dependencies?.[ENGINE];

require_(
  publicPin !== undefined,
  `${ENGINE} is missing from @prisma/composer's dependencies — the public manifest is what the registry sees.`,
);
require_(
  internalPin !== undefined,
  `${ENGINE} is missing from @internal/cli's dependencies — the code that imports it must declare it.`,
);
require_(
  publicPin === internalPin,
  `${ENGINE} disagrees between manifests: @prisma/composer says "${publicPin}", @internal/cli says "${internalPin}". They are released in tandem and must be identical.`,
);
for (const [label, pin] of [
  ['@prisma/composer', publicPin],
  ['@internal/cli', internalPin],
]) {
  require_(
    pin === undefined || EXACT_VERSION.test(pin),
    `${label} declares ${ENGINE} as "${pin}" — it must be an exact version, with no range operator.`,
  );
}

// The tarball is the only thing that proves externalization: the manifest can
// declare the engine while the bundler has quietly inlined it anyway.
let work;
try {
  work = mkdtempSync(join(tmpdir(), 'cli-engine-pin-'));
  // pnpm pack, not npm pack: it rewrites `workspace:` specifiers the way a
  // real publish does.
  execFileSync('pnpm', ['pack', '--pack-destination', work], {
    cwd: publicDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('pnpm pack produced no tarball for @prisma/composer');
  execFileSync('tar', ['xzf', tarball], { cwd: work });

  const packedRoot = join(work, 'package');
  const packedPin = JSON.parse(readFileSync(join(packedRoot, 'package.json'), 'utf-8'))
    .dependencies?.[ENGINE];
  require_(
    packedPin === publicPin,
    `the packed tarball declares ${ENGINE} as "${packedPin}", not the manifest's "${publicPin}".`,
  );

  const distDir = join(packedRoot, 'dist');
  const chunks = readdirSync(distDir).filter((f) => f.endsWith('.mjs'));
  // A surviving bare specifier is the externalization proof. An inlined engine
  // leaves no specifier at all, so "no chunk mentions it" is the failure, not
  // the pass.
  const importing = chunks.filter((f) =>
    new RegExp(`from\\s*["']${ENGINE}(/[^"']*)?["']`).test(readFileSync(join(distDir, f), 'utf-8')),
  );
  require_(
    importing.length > 0,
    `no chunk in the packed dist/ imports ${ENGINE} by specifier — it has been inlined into the tarball instead of left external. Add it to tsdown.config.ts's \`external\` array.`,
  );
  if (importing.length > 0) {
    process.stderr.write(`${ENGINE} stays external in: ${importing.join(', ')}\n`);
  }
} finally {
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(
    `\nFAIL — ${ENGINE} pin check:\n${failures.map((f) => `  - ${f}\n`).join('')}`,
  );
  process.exit(1);
}
process.stderr.write(
  `\nOK — ${ENGINE}@${publicPin} is exact, agreed across manifests, and external in the tarball.\n`,
);
