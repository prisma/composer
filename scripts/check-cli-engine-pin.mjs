#!/usr/bin/env node
// `@prisma/cli-engine` must exist exactly once in any installed tree that
// runs the CLI. The model: product CLI packages declare the engine as an
// exact peerDependency, and the shell that hosts them (the `prisma` bin)
// carries the one real dependency — so every family mounts into the same
// engine instance, and a tree that cannot satisfy the peer fails at install
// time instead of at runtime. Libraries carry no engine relationship at all.
// This script checks both halves: @prisma/composer-cli declares the engine
// correctly and keeps it a REAL import, and @prisma/composer ships no trace
// of it.
//
// Why each part matters:
//
//   Exact + identical. Composer's command family runs inside whichever
//   process mounts it — composer's own CLI or the `prisma` bin — and both
//   sides must agree on the engine's types and its runtime classes. The
//   engine and composer are released in tandem (engine → composer →
//   prisma-cli), so the version is a hand-coordinated fact, not a range to be
//   resolved. Three declarations must agree: composer-cli's peerDependency
//   (what consumers' installs must satisfy), composer-cli's devDependency
//   (what the workspace builds and tests against — a peer alone installs
//   nothing here), and @internal/cli's dependency (the code that actually
//   imports it; the `@internal` scope is inlined at publish time, so the
//   relationship has to be mirrored into the public manifest). A drift among
//   them would ship a tarball whose declared engine is not the one the code
//   was built against. Dependabot is told to leave it alone
//   (.github/dependabot.yml), which is what makes this check the only guard.
//
//   External. Both of composer-cli's tsdown configs bundle node_modules
//   (`skipNodeModulesBundle: false`) so the @internal scope is inlined, and
//   what survives as a real import is then the bundler's decision — one it
//   can change without anyone editing a manifest. A private copy of the
//   engine is not a copy of a library: the `prisma` bin would mount
//   composer's family into its own engine while composer's handlers reached
//   for the inlined one, and every cross-boundary `instanceof` and every
//   module-level registry would silently disagree. Grepping the emitted
//   chunks for a surviving bare specifier is what proves externalization
//   actually happened, which the manifest alone cannot say (see the
//   inventory's hazard H7). The executable is checked BY NAME as well as in
//   the whole-dist sweep, because it is built by a second config with its own
//   externals and would otherwise ride on the library entries' specifier.
//
//   Engine-free library. @prisma/composer is the application-facing library;
//   it declares no engine relationship, so nothing in its packed dist may
//   import the engine (a surviving specifier would be an undeclared
//   dependency) and nothing may inline it either (a second copy is exactly
//   what the peer model exists to prevent). The manifest half of that is
//   checked on the packed tarball. The import scan below can only see a
//   SURVIVING specifier, so the library's tsdown config keeps the engine in
//   `external`: an accidental engine import then stays visible as a bare
//   specifier and fails here, instead of being inlined into a silent private
//   copy the scan cannot detect.
//
// Requires both public packages to be built (`pnpm turbo run build
// --filter=@prisma/composer --filter=@prisma/composer-cli`).
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
const cliDir = join(repoRoot, 'packages/9-public/composer-cli');
const libraryDir = join(repoRoot, 'packages/9-public/composer');
const internalCliDir = join(repoRoot, 'packages/0-framework/3-tooling/cli');

const failures = [];
function require_(condition, message) {
  if (!condition) failures.push(message);
}

function manifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
}

const cliPeerPin = manifest(cliDir).peerDependencies?.[ENGINE];
const cliDevPin = manifest(cliDir).devDependencies?.[ENGINE];
const internalPin = manifest(internalCliDir).dependencies?.[ENGINE];

require_(
  cliPeerPin !== undefined,
  `${ENGINE} is missing from @prisma/composer-cli's peerDependencies — the peer is what makes the host's engine the only engine.`,
);
require_(
  cliDevPin !== undefined,
  `${ENGINE} is missing from @prisma/composer-cli's devDependencies — a peer alone installs nothing in the workspace, so the build would have no engine to compile against.`,
);
require_(
  internalPin !== undefined,
  `${ENGINE} is missing from @internal/cli's dependencies — the code that imports it must declare it.`,
);
require_(
  cliPeerPin === cliDevPin,
  `${ENGINE} disagrees within @prisma/composer-cli: peerDependencies says "${cliPeerPin}", devDependencies says "${cliDevPin}". The workspace must build against the exact engine the peer demands.`,
);
require_(
  cliPeerPin === internalPin,
  `${ENGINE} disagrees between manifests: @prisma/composer-cli says "${cliPeerPin}", @internal/cli says "${internalPin}". They are released in tandem and must be identical.`,
);
for (const [label, pin] of [
  ['@prisma/composer-cli (peerDependencies)', cliPeerPin],
  ['@prisma/composer-cli (devDependencies)', cliDevPin],
  ['@internal/cli', internalPin],
]) {
  require_(
    pin === undefined || EXACT_VERSION.test(pin),
    `${label} declares ${ENGINE} as "${pin}" — it must be an exact version, with no range operator.`,
  );
}

/** Packs one package and returns the extracted tarball's `package/` root. */
function packAndExtract(pkgDir, label) {
  const dest = mkdtempSync(join(tmpdir(), 'cli-engine-pin-'));
  // pnpm pack, not npm pack: it rewrites `workspace:` specifiers the way a
  // real publish does.
  execFileSync('pnpm', ['pack', '--pack-destination', dest], {
    cwd: pkgDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const tarball = readdirSync(dest).find((f) => f.endsWith('.tgz'));
  if (tarball === undefined) throw new Error(`pnpm pack produced no tarball for ${label}`);
  execFileSync('tar', ['xzf', tarball], { cwd: dest });
  return { work: dest, packedRoot: join(dest, 'package') };
}

/** Every .mjs under a packed dist/, paths relative to it. */
function distChunks(distDir) {
  return readdirSync(distDir, { recursive: true, encoding: 'utf-8' }).filter((f) =>
    f.endsWith('.mjs'),
  );
}

function importsEngine(distDir, file) {
  return new RegExp(`from\\s*["']${ENGINE}(/[^"']*)?["']`).test(
    readFileSync(join(distDir, file), 'utf-8'),
  );
}

// The tarball is the only thing that proves externalization: the manifest can
// declare the engine while the bundler has quietly inlined it anyway.
const scratchDirs = [];
try {
  // Half one: the CLI package. The packed peer must survive packing, and the
  // packed chunks must still import the engine by name.
  const cli = packAndExtract(cliDir, '@prisma/composer-cli');
  scratchDirs.push(cli.work);
  const packedPeerPin = JSON.parse(readFileSync(join(cli.packedRoot, 'package.json'), 'utf-8'))
    .peerDependencies?.[ENGINE];
  require_(
    packedPeerPin === cliPeerPin,
    `the packed tarball declares ${ENGINE} as a "${packedPeerPin}" peer, not the manifest's "${cliPeerPin}".`,
  );

  const distDir = join(cli.packedRoot, 'dist');
  if (!existsSync(distDir)) {
    // Not a finding about the code: the operator packed a package that was
    // never built. Say so here rather than dying on ENOENT and discarding the
    // manifest findings already collected above.
    require_(
      false,
      'the packed @prisma/composer-cli tarball has no dist/ — build the package first: `pnpm turbo run build --filter=@prisma/composer-cli`.',
    );
  } else {
    // Recursive: code splitting can put a chunk in a subdirectory, and a
    // surviving import down there is just as much proof as one at the top.
    const chunks = distChunks(distDir);
    // A surviving bare specifier is the externalization proof. An inlined engine
    // leaves no specifier at all, so "no chunk mentions it" is the failure, not
    // the pass.
    const importing = chunks.filter((f) => importsEngine(distDir, f));
    require_(
      importing.length > 0,
      `no chunk in the packed dist/ imports ${ENGINE} by specifier — it has been inlined into the tarball instead of left external. Add it to tsdown.config.ts's \`external\` array.`,
    );
    // The executable specifically. The whole-dist check above passes as soon
    // as ONE chunk keeps the specifier, so the library entries alone would
    // satisfy it while the bin — built by a second tsdown config, with its own
    // externals — carried a private copy of the engine.
    require_(
      !chunks.includes(BIN) || importsEngine(distDir, BIN),
      `the packed ${BIN} does not import ${ENGINE} by specifier — the executable's tsdown config has inlined its own copy of the engine. Add it to that config's \`external\` array.`,
    );
    require_(
      chunks.includes(BIN),
      `the packed dist/ has no ${BIN} — the executable @prisma/composer-cli publishes as its bin is missing from the tarball.`,
    );
    if (importing.length > 0) {
      process.stderr.write(`${ENGINE} stays external in: ${importing.join(', ')}\n`);
    }
  }

  // Half two: the library must be engine-free — no declaration in any field
  // that ships to consumers, and no chunk importing the engine.
  const library = packAndExtract(libraryDir, '@prisma/composer');
  scratchDirs.push(library.work);
  const libraryManifest = JSON.parse(
    readFileSync(join(library.packedRoot, 'package.json'), 'utf-8'),
  );
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    require_(
      libraryManifest[field]?.[ENGINE] === undefined,
      `@prisma/composer's packed ${field} declares ${ENGINE} — the library must carry no engine relationship at all; only @prisma/composer-cli (peer) and the hosting shell (dependency) may.`,
    );
  }
  const libraryDist = join(library.packedRoot, 'dist');
  if (!existsSync(libraryDist)) {
    require_(
      false,
      'the packed @prisma/composer tarball has no dist/ — build the package first: `pnpm turbo run build --filter=@prisma/composer`.',
    );
  } else {
    const engineImporters = distChunks(libraryDist).filter((f) => importsEngine(libraryDist, f));
    require_(
      engineImporters.length === 0,
      `@prisma/composer's packed dist imports ${ENGINE} (${engineImporters.join(', ')}) — the library declares no engine, so a surviving specifier is an undeclared dependency that breaks a plain \`npm install @prisma/composer\`.`,
    );
  }
} finally {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(
    `\nFAIL — ${ENGINE} pin check:\n${failures.map((f) => `  - ${f}\n`).join('')}`,
  );
  process.exit(1);
}
process.stderr.write(
  `\nOK — ${ENGINE}@${cliPeerPin} is exact, agreed across manifests, external in the CLI tarball, and absent from the library.\n`,
);
