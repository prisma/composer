/**
 * Each environment's folder records the environment's exact name. On a
 * case-insensitive filesystem `--environment Dev` would otherwise open the
 * folder of `dev` and run, or `--fresh` delete, that copy.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEV_ENVIRONMENT_NAME_FILE } from '@internal/core/local-target';
import { CliStructuredError } from '@internal/foundation/errors';

function recordedName(devDir: string): string | undefined {
  const file = path.join(devDir, DEV_ENVIRONMENT_NAME_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : undefined;
}

function nameMismatch(devDir: string, recorded: string, environment: string): CliStructuredError {
  return new CliStructuredError(
    'DEV.ENVIRONMENT_NAME_MISMATCH',
    `The folder ${devDir} holds the local copy of the environment ${recorded}, not ${environment}.`,
    {
      why: 'On a case-insensitive filesystem, such as the default on macOS, environment names that differ only in case share one folder, so they cannot be separate local copies.',
      fix: `Pass \`--environment ${recorded}\` for that copy, or pick a name that differs from ${recorded} by more than case.`,
      meta: { devDir, recorded, environment },
    },
  );
}

/** Fails when the folder records another environment's name; a folder with no name recorded passes. */
export function requireDevEnvironmentName(devDir: string, environment: string): void {
  const recorded = recordedName(devDir);
  if (recorded !== undefined && recorded !== environment) {
    throw nameMismatch(devDir, recorded, environment);
  }
}

/** Records the environment's name in its folder on first use; fails when the folder records another name. */
export function claimDevEnvironmentName(devDir: string, environment: string): void {
  const recorded = recordedName(devDir);
  if (recorded === environment) return;
  if (recorded !== undefined) throw nameMismatch(devDir, recorded, environment);
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, DEV_ENVIRONMENT_NAME_FILE), `${environment}\n`);
}
