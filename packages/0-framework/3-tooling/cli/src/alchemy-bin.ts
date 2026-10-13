/**
 * Which Alchemy CLI runs a generated stack file: the `alchemy` that
 * `@prisma/composer` depends on, found from the app the way the stack file's
 * own `@prisma/composer/...` imports are. The CLI and the stack code then
 * come from one install, so the child loads one copy of `alchemy`.
 *
 * Node's resolver finds `@prisma/composer` from the app. It cannot find
 * `alchemy` from there: alchemy exports neither its `package.json` nor its
 * bin, and has no `require` condition. Bun has no `module.findPackageJSON`.
 * So the last step is Node's own lookup written out: each `node_modules`
 * above `@prisma/composer`'s real location, nearest first.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { CliStructuredError } from '@internal/foundation/errors';

const FIX =
  "Check that the app depends on @prisma/composer and that `alchemy`, which @prisma/composer depends on, is installed in a node_modules directory. Layouts without one, such as Yarn Plug'n'Play, are not supported.";

function binMissing(message: string): CliStructuredError {
  return new CliStructuredError('DEPLOY.ALCHEMY_BIN_MISSING', message, { fix: FIX });
}

function composerPackageDir(appDir: string): string | undefined {
  try {
    const manifest = createRequire(path.join(appDir, 'package.json')).resolve(
      '@prisma/composer/package.json',
    );
    return path.dirname(fs.realpathSync(manifest));
  } catch {
    return undefined;
  }
}

function alchemyPackageDirAbove(dir: string): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', 'alchemy');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(current) === current) return undefined;
  }
}

function readPackageJson(packageDir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function binOf(packageDir: string): string | undefined {
  const manifest = readPackageJson(packageDir);
  if (typeof manifest !== 'object' || manifest === null || !('bin' in manifest)) return undefined;
  const bin = manifest.bin;
  const relative =
    typeof bin === 'string'
      ? bin
      : typeof bin === 'object' && bin !== null && 'alchemy' in bin
        ? bin.alchemy
        : undefined;
  if (typeof relative !== 'string') return undefined;
  const entry = path.join(packageDir, relative);
  return fs.existsSync(entry) ? entry : undefined;
}

/**
 * The JavaScript file `alchemy`'s `bin` names, for the app in `appDir`.
 * Raises DEPLOY.ALCHEMY_BIN_MISSING when the app does not resolve
 * `@prisma/composer` or no usable `alchemy` is installed beside it.
 */
export function resolveAlchemyBin(appDir: string): string {
  const composerDir = composerPackageDir(appDir);
  if (composerDir === undefined) {
    throw binMissing(`Could not resolve @prisma/composer from "${appDir}".`);
  }
  const alchemyDir = alchemyPackageDirAbove(composerDir);
  const entry = alchemyDir === undefined ? undefined : binOf(alchemyDir);
  if (entry === undefined) {
    throw binMissing(
      `Could not resolve the bin of the \`alchemy\` package @prisma/composer depends on, from "${composerDir}".`,
    );
  }
  return entry;
}
