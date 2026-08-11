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
//   External. Both of composer's tsdown configs bundle node_modules
//   (`skipNodeModulesBundle: false`) so the @internal scope is inlined, and
//   what survives as a real import is then the bundler's decision — one it can
//   change without anyone editing a manifest. A private copy of the engine is
//   not a copy of a library: the `prisma` bin would mount composer's family
//   into its own engine while composer's handlers reached for the inlined one,
//   and every cross-boundary `instanceof` and every module-level registry
//   would silently disagree. Grepping the emitted chunks for a surviving bare
//   specifier is what proves externalization actually happened, which the
//   manifest alone cannot say (see the inventory's hazard H7). The executable
//   is checked BY NAME as well as in the whole-dist sweep, because it is built
//   by a second config with its own externals and would otherwise ride on the
//   library entries' specifier.
//
// Requires @prisma/composer to be built (`pnpm turbo run build
// --filter=@prisma/composer`).
//
// Usage: node scripts/check-cli-engine-pin.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = '@prisma/cli-engine';
/** The published executable, built by its own tsdown config — see the bin-specific check below. */
const BIN = 'bin.mjs';
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
  if (!existsSync(distDir)) {
    // Not a finding about the code: the operator packed a package that was
    // never built. Say so here rather than dying on ENOENT and discarding the
    // manifest findings already collected above.
    require_(
      false,
      'the packed tarball has no dist/ — build the package first: `pnpm turbo run build --filter=@prisma/composer`.',
    );
  } else {
    // Recursive: code splitting can put a chunk in a subdirectory, and a
    // surviving import down there is just as much proof as one at the top.
    // The returned paths stay relative to distDir.
    const chunks = readdirSync(distDir, { recursive: true, encoding: 'utf-8' }).filter((f) =>
      f.endsWith('.mjs'),
    );
    // A surviving bare specifier is the externalization proof. An inlined engine
    // leaves no specifier at all, so "no chunk mentions it" is the failure, not
    // the pass.
    const imports = (file) =>
      new RegExp(`from\\s*["']${ENGINE}(/[^"']*)?["']`).test(
        readFileSync(join(distDir, file), 'utf-8'),
      );
    const importing = chunks.filter(imports);
    require_(
      importing.length > 0,
      `no chunk in the packed dist/ imports ${ENGINE} by specifier — it has been inlined into the tarball instead of left external. Add it to tsdown.config.ts's \`external\` array.`,
    );
    // The executable specifically. The whole-dist check above passes as soon
    // as ONE chunk keeps the specifier, so the library entries alone would
    // satisfy it while the bin — built by a second tsdown config, with its own
    // externals — carried a private copy of the engine.
    require_(
      !chunks.includes(BIN) || imports(BIN),
      `the packed ${BIN} does not import ${ENGINE} by specifier — the executable's tsdown config has inlined its own copy of the engine. Add it to that config's \`external\` array.`,
    );
    require_(
      chunks.includes(BIN),
      `the packed dist/ has no ${BIN} — the executable @prisma/composer publishes as its bin is missing from the tarball.`,
    );
    if (importing.length > 0) {
      process.stderr.write(`${ENGINE} stays external in: ${importing.join(', ')}\n`);
    }
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
