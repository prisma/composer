/**
 * Pipeline pre-container step: validates `--stage` as a git ref name before
 * anything platform-specific runs — the framework's own documented contract
 * (deploy-cli.md), platform-free and uniform across extensions.
 */
import { spawnSync } from 'node:child_process';
import { CliError } from './cli-error.ts';

/** Validates `stage` as a git ref name via `git check-ref-format` — no silent normalization. */
export function validateStageName(stage: string): void {
  const result = spawnSync('git', ['check-ref-format', `refs/heads/${stage}`], {
    stdio: 'ignore',
  });
  if (result.error) {
    throw new CliError(
      `git is required to validate --stage "${stage}" (git check-ref-format): ${result.error.message}.`,
    );
  }
  if (result.status !== 0) {
    throw new CliError(
      `Invalid --stage "${stage}": must be a valid git ref name (git check-ref-format rejected "refs/heads/${stage}").`,
    );
  }
}
