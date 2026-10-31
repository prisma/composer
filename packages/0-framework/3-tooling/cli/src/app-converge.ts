/**
 * Which copy of Composer's lowering and in-process converge runs `deploy`:
 * the one the app installs, found from the directory of the app's
 * `prisma.config.ts`, the file its extensions are imported from. The stack,
 * Alchemy and the providers then share one copy of `alchemy` and `effect`
 * even when the `prisma` host pins another Composer (ADR-0050, ADR-0064).
 * The host calls that copy across a version boundary, and Composer's
 * packages release in lockstep, so the two versions must be equal.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { lower } from '@internal/core/deploy';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import manifest from '../package.json' with { type: 'json' };
import type { Converge } from './converge-in-process.ts';

const ENTRY = '@prisma/composer/internal/converge';

/** The Composer version this host runs; every Composer package carries the same one. */
export const HOST_COMPOSER_VERSION: string = manifest.version;

/** The app install's `lower` and `convergeInProcess`. */
export interface AppConverge {
  readonly lower: typeof lower;
  readonly converge: Converge;
}

function unresolvable(appDir: string, detail: string, cause?: unknown): CliStructuredError {
  return new CliStructuredError(
    'DEPS.CONVERGE_UNRESOLVABLE',
    `Could not load the converge from the app's @prisma/composer in "${appDir}": ${detail}`,
    {
      why: "`prisma deploy` runs the lowering and Alchemy from the app's own install of @prisma/composer, so the app, its extensions and Alchemy share one copy of alchemy.",
      fix: 'Install @prisma/composer in the app, at the same version as the Composer the `prisma` CLI runs.',
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

function installedVersion(require: NodeJS.Require): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(require.resolve('@prisma/composer/package.json'), 'utf8'),
    );
    return typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
      ? parsed.version
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The app's converge, from the install `appDir` resolves. Raises
 * DEPS.CONVERGE_UNRESOLVABLE when it is missing or predates the in-process
 * converge, and DEPS.CONVERGE_VERSION_MISMATCH when its version is not
 * `hostVersion`.
 */
export async function loadAppConverge(
  appDir: string,
  hostVersion: string = HOST_COMPOSER_VERSION,
): Promise<AppConverge> {
  const require = createRequire(path.join(appDir, 'package.json'));
  let file: string;
  try {
    file = require.resolve(ENTRY);
  } catch (error) {
    throw unresolvable(appDir, `${ENTRY} does not resolve.`, error);
  }
  const appVersion = installedVersion(require);
  if (appVersion !== hostVersion) {
    throw new CliStructuredError(
      'DEPS.CONVERGE_VERSION_MISMATCH',
      `The app's @prisma/composer is ${appVersion ?? 'of an unknown version'}, and the \`prisma\` CLI runs Composer ${hostVersion}.`,
      {
        why: "Deploy calls the app's @prisma/composer from the CLI's Composer, and Composer's packages work together only at one version.",
        fix: `Install @prisma/composer ${hostVersion} in the app, or a \`prisma\` CLI that runs Composer ${appVersion ?? "the app's version"}, so the two versions match.`,
      },
    );
  }
  let loaded: Record<string, unknown>;
  try {
    loaded = await import(pathToFileURL(file).href);
  } catch (error) {
    throw unresolvable(
      appDir,
      `${file} failed to load: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  const { lower: appLower, convergeInProcess } = loaded;
  if (typeof appLower !== 'function' || typeof convergeInProcess !== 'function') {
    throw unresolvable(appDir, `${file} exports no lower and convergeInProcess.`);
  }
  return blindCast<
    AppConverge,
    "the typeof checks above prove both are functions, and the version check proves the entry is this package's own src/exports/converge.ts at this version"
  >({ lower: appLower, converge: convergeInProcess });
}
