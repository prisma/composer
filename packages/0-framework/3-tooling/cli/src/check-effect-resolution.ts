/**
 * Deploy preflight (TML-3158): verify that alchemy resolves the exact `effect`
 * version @prisma/composer pins. Package managers cannot be made to enforce
 * this — alchemy's own peer range accepts newer effect betas, and npm resolves
 * transitive peer conflicts with a warning, not a failure — so a floating
 * `@effect/*` range anywhere in the consumer's tree can hoist a newer effect
 * to the root, where alchemy picks it up and crashes mid-deploy
 * (`TypeError: Schedule.either is not a function`). This check turns that
 * silent break into a start-up error naming the fix.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { CliError } from './cli-error.ts';

/** Walks up from `startDir` looking for `node_modules/alchemy` (mirrors resolveAlchemyBin). Undefined when absent — the check skips rather than second-guessing later, clearer failures. */
export function findAlchemyPackageDir(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', 'alchemy');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The `effect` version Node gives `packageDir`'s code, resolved exactly as
 * Node would: from the package's real path (so pnpm symlink layouts resolve
 * from the package's own store position, like at runtime). Undefined when
 * `effect` is not resolvable from there.
 */
export function resolveEffectVersionFrom(packageDir: string): string | undefined {
  let entry: string;
  try {
    const requireFrom = createRequire(path.join(fs.realpathSync(packageDir), 'noop.js'));
    entry = requireFrom.resolve('effect');
  } catch {
    return undefined;
  }
  let dir = path.dirname(entry);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  const version: unknown = JSON.parse(
    fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'),
  ).version;
  return typeof version === 'string' ? version : undefined;
}

/**
 * The `effect` version @prisma/composer pins, read from its own installed
 * package.json — the single source of truth; never hardcoded here. Undefined
 * when @prisma/composer is not resolvable from `startDir` (e.g. the CLI is
 * driven some other way), in which case the check skips.
 */
export function requiredEffectVersion(startDir: string): string | undefined {
  let manifestPath: string;
  try {
    const requireFrom = createRequire(path.join(startDir, 'noop.js'));
    manifestPath = requireFrom.resolve('@prisma/composer/package.json');
  } catch {
    return undefined;
  }
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (typeof manifest !== 'object' || manifest === null || !('dependencies' in manifest)) {
    return undefined;
  }
  const dependencies = manifest.dependencies;
  if (typeof dependencies !== 'object' || dependencies === null || !('effect' in dependencies)) {
    return undefined;
  }
  const version = dependencies.effect;
  return typeof version === 'string' ? version : undefined;
}

/** Pure comparison + message rendering, separated so tests cover the rule without a filesystem. Returns the error message, or undefined when the tree is healthy or either side is unknown. */
export function effectMismatchError(
  found: string | undefined,
  required: string | undefined,
): string | undefined {
  if (found === undefined || required === undefined || found === required) return undefined;
  return (
    `Dependency conflict: alchemy resolves effect@${found}, but @prisma/composer requires ` +
    `effect@${required}. Your package manager installed a second effect that alchemy picks up; ` +
    'deploying with it would crash inside alchemy.\n\n' +
    "Fix: add this to your app's package.json, then reinstall:\n\n" +
    `  "overrides": { "effect": "${required}" }\n\n` +
    '(npm uses "overrides"; yarn calls it "resolutions", pnpm "pnpm.overrides".)'
  );
}

/** Runs the preflight from the app's directory; throws CliError on a mismatched tree, no-op otherwise. */
export function checkEffectResolution(cwd: string): void {
  const alchemyDir = findAlchemyPackageDir(cwd);
  if (alchemyDir === undefined) return;
  const message = effectMismatchError(
    resolveEffectVersionFrom(alchemyDir),
    requiredEffectVersion(cwd),
  );
  if (message !== undefined) throw new CliError(message);
}
