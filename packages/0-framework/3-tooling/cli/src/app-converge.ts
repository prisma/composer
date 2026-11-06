/**
 * Which copy of Composer's lowering and in-process converge runs `deploy`:
 * the one the app installs, found from the directory of the app's
 * `prisma.config.ts`, the file its extensions are imported from. The stack,
 * Alchemy and the providers then share one copy of `alchemy` and `effect`
 * even when the `prisma` host pins another Composer (ADR-0050, ADR-0064).
 * The host calls that copy across a version boundary, so the two must speak
 * the same converge contract (`CONVERGE_CONTRACT`); their package versions
 * may differ.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { lower } from '@internal/core/deploy';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import manifest from '../package.json' with { type: 'json' };
import { CONVERGE_CONTRACT } from './converge-contract.ts';
import type { Converge } from './converge-in-process.ts';

const ENTRY = '@prisma/composer/internal/converge';
const CONTRACT_ENTRY = '@prisma/composer/internal/converge-contract';

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

async function importFile(appDir: string, file: string): Promise<Record<string, unknown>> {
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    throw unresolvable(
      appDir,
      `${file} failed to load: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

function contractMismatch(
  host: { readonly contract: number; readonly version: string },
  app: { readonly contract: number; readonly version: string | undefined },
): CliStructuredError {
  const appVersion = app.version ?? 'an unknown version';
  const update =
    app.contract < host.contract
      ? `Upgrade the app's @prisma/composer to a release that speaks converge contract ${host.contract}, such as ${host.version}.`
      : `Upgrade the \`prisma\` CLI to one that runs a Composer speaking converge contract ${app.contract}, such as ${appVersion}.`;
  return new CliStructuredError(
    'DEPS.CONVERGE_CONTRACT_MISMATCH',
    `The app's @prisma/composer ${appVersion} speaks converge contract ${app.contract}, and the \`prisma\` CLI's Composer ${host.version} speaks contract ${host.contract}.`,
    {
      why: "Deploy calls the app's @prisma/composer from the CLI's Composer, and the two read each other's data only when they speak the same converge contract.",
      fix: update,
    },
  );
}

/**
 * The app's converge, from the install `appDir` resolves. Reads the app's
 * converge contract before loading anything else. Raises
 * DEPS.CONVERGE_UNRESOLVABLE when the install is missing or predates the
 * in-process converge, and DEPS.CONVERGE_CONTRACT_MISMATCH when it speaks
 * another contract than `host`.
 */
export async function loadAppConverge(
  appDir: string,
  host: { readonly contract: number; readonly version: string } = {
    contract: CONVERGE_CONTRACT,
    version: HOST_COMPOSER_VERSION,
  },
): Promise<AppConverge> {
  const require = createRequire(path.join(appDir, 'package.json'));
  let contractFile: string;
  let file: string;
  try {
    contractFile = require.resolve(CONTRACT_ENTRY);
    file = require.resolve(ENTRY);
  } catch (error) {
    throw unresolvable(appDir, `${CONTRACT_ENTRY} or ${ENTRY} does not resolve.`, error);
  }
  const { CONVERGE_CONTRACT: appContract } = await importFile(appDir, contractFile);
  if (typeof appContract !== 'number') {
    throw unresolvable(appDir, `${contractFile} exports no CONVERGE_CONTRACT.`);
  }
  if (appContract !== host.contract) {
    throw contractMismatch(host, { contract: appContract, version: installedVersion(require) });
  }
  const { lower: appLower, convergeInProcess } = await importFile(appDir, file);
  if (typeof appLower !== 'function' || typeof convergeInProcess !== 'function') {
    throw unresolvable(appDir, `${file} exports no lower and convergeInProcess.`);
  }
  return blindCast<
    AppConverge,
    "the typeof checks above prove both are functions, and the contract check proves the entry speaks this host's converge contract"
  >({ lower: appLower, converge: convergeInProcess });
}
