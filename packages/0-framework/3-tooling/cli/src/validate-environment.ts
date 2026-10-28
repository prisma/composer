import { spawnSync } from 'node:child_process';
import { CliStructuredError } from '@internal/foundation/errors';

/** Letters, digits, `-` and `_`, starting with a letter or digit: always a valid git ref, so no `git` is needed to check it. */
const PLAIN_ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type GitSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore' },
) => {
  readonly error?: Error | undefined;
  readonly status: number | null;
};

/** An environment name must be a valid git ref (deploy-cli.md) — checked via `git check-ref-format`, never silently normalized. Runs before anything platform-specific. */
export function validateEnvironmentName(environment: string, spawn: GitSpawn = spawnSync): void {
  if (PLAIN_ENVIRONMENT_NAME.test(environment)) return;
  const result = spawn('git', ['check-ref-format', `refs/heads/${environment}`], {
    stdio: 'ignore',
  });
  if (result.error) {
    throw new CliStructuredError(
      'DEPLOY.ENVIRONMENT_UNVALIDATABLE',
      `git is required to validate --environment "${environment}" (git check-ref-format): ${result.error.message}.`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new CliStructuredError(
      'DEPLOY.ENVIRONMENT_INVALID',
      `Invalid --environment "${environment}": must be a valid git ref name (git check-ref-format rejected "refs/heads/${environment}").`,
    );
  }
}
