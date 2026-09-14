import { spawnSync } from 'node:child_process';
import { CliStructuredError } from '@internal/foundation/errors';

/** A stage name must be a valid git ref (deploy-cli.md) — checked via `git check-ref-format`, never silently normalized. Runs before anything platform-specific. */
export function validateStageName(stage: string): void {
  const result = spawnSync('git', ['check-ref-format', `refs/heads/${stage}`], {
    stdio: 'ignore',
  });
  if (result.error) {
    throw new CliStructuredError(
      'DEPLOY.STAGE_UNVALIDATABLE',
      `git is required to validate --stage "${stage}" (git check-ref-format): ${result.error.message}.`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new CliStructuredError(
      'DEPLOY.STAGE_INVALID',
      `Invalid --stage "${stage}": must be a valid git ref name (git check-ref-format rejected "refs/heads/${stage}").`,
    );
  }
}
