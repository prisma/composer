/**
 * Pipeline step 7 (deploy-cli.md § The pipeline; design-notes.md's "Driving
 * Alchemy" call): shell out to the generated stack file. Resolves the
 * `alchemy` package owned by Composer rather than looking in the app's
 * `node_modules/.bin`, so isolated package-manager layouts work without
 * requiring the app to depend on Alchemy or hoist Composer's dependencies.
 * The package's declared bin launcher does its own node/bun dispatch, driven
 * by the runtime and env it inherits.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodeModule from 'node:module';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliStructuredError } from '@internal/foundation/errors';

/** Resolves Composer's installed Alchemy package and returns its declared CLI entry. */
export function resolveAlchemyBin(resolveFrom: string | URL = import.meta.url): string {
  let manifestPath: string;
  try {
    const modulePath =
      resolveFrom instanceof URL || resolveFrom.startsWith('file:')
        ? fileURLToPath(resolveFrom)
        : resolveFrom;
    const realModulePath = fs.realpathSync(modulePath);
    const foundManifest =
      typeof nodeModule.findPackageJSON === 'function'
        ? nodeModule.findPackageJSON('alchemy', pathToFileURL(realModulePath))
        : createRequire(realModulePath).resolve('alchemy/package.json');
    if (foundManifest === undefined) throw new Error('Alchemy has no package manifest.');
    manifestPath = foundManifest;
  } catch (cause) {
    throw new CliStructuredError(
      'DEPLOY.ALCHEMY_BIN_MISSING',
      'Composer could not resolve its installed `alchemy` dependency.',
      { fix: 'Reinstall @prisma/composer.', cause },
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    throw new CliStructuredError(
      'DEPLOY.ALCHEMY_BIN_MISSING',
      'Composer could not read its installed `alchemy` dependency metadata.',
      { fix: 'Reinstall @prisma/composer.', cause },
    );
  }
  const bin =
    typeof manifest === 'object' &&
    manifest !== null &&
    'bin' in manifest &&
    typeof manifest.bin === 'object' &&
    manifest.bin !== null &&
    'alchemy' in manifest.bin
      ? manifest.bin.alchemy
      : undefined;

  if (typeof bin !== 'string') {
    throw new CliStructuredError(
      'DEPLOY.ALCHEMY_BIN_MISSING',
      'Composer resolved `alchemy`, but the package does not declare an `alchemy` bin.',
      { fix: 'Reinstall @prisma/composer.' },
    );
  }

  return path.resolve(path.dirname(manifestPath), bin);
}

export interface RunAlchemyInput {
  readonly command: 'deploy' | 'destroy';
  /** The generated stack file's path, relative to `cwd`. */
  readonly stackFileRelativePath: string;
  readonly cwd: string;
  /** The resolved Alchemy stage: the state-owning container's `alchemyStage` when it supplies one, else the user `--stage`. Always required — alchemy's own default (`dev_$USER`) is machine-dependent and must never apply. */
  readonly stage: string;
  /** Every extension's resolved container, serialized — one env var per extension (core's container-transport naming). Content-blind: the CLI never reads these values, only writes them. */
  readonly containerEnv: Readonly<Record<string, string>>;
  /** Defaults to `process.env`; overridable so tests can pin a fake bin's inputs. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunAlchemyDeps {
  /** Test seam; production resolves Composer's own dependency. */
  readonly resolveBin?: () => string;
}

/** Runs `alchemy deploy|destroy <stack file> --yes --stage <stage>`, inheriting stdio + env, plus every extension's resolved container. */
export function runAlchemy(input: RunAlchemyInput, deps: RunAlchemyDeps = {}): number {
  const bin = (deps.resolveBin ?? resolveAlchemyBin)();
  const args = [input.command, input.stackFileRelativePath, '--yes', '--stage', input.stage];

  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: input.cwd,
    stdio: 'inherit',
    env: {
      ...(input.env ?? process.env),
      ...input.containerEnv,
    },
  });

  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}
