/**
 * The programmatic `destroy` operation (`@prisma/composer/control`): typed
 * input, structured result, no argv, no console, no process.exit. No CLI
 * command wraps it. The executor
 * loads lazily, so importing this module executes nothing; an executor that
 * fails to load comes back as a structured failure, never a throw out of
 * the host.
 */
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, type Result } from '@internal/foundation/result';
import type { ComposerConfigSource } from '../composer-config.ts';
import { executorLoadFailure, type OperationDeps } from './shared.ts';

export type DestroyEvent =
  /** Emitted before the pipeline when `<cwd>/.alchemy` is missing/empty. */
  { readonly kind: 'no-local-deploy-state'; readonly cwd: string };

export interface DestroyInput {
  /**
   * Composer's configuration: the `composer` section of `prisma.config.ts` and that file. The operation does not look for a config file; it refuses a section the CLI would refuse, before any work starts.
   */
  readonly config: ComposerConfigSource;
  /** The entry module, resolved against `cwd`. Overrides the `entry` in `config`; without either the operation fails with `CONFIG.ENTRY_MISSING`. */
  readonly entry?: string | undefined;
  readonly name?: string | undefined;
  /** The environment to destroy. Required: destroy never defaults to production. */
  readonly environment: string;
  readonly cwd?: string | undefined;
  /** Mid-operation notifications, in real time. Rendering is the host's. */
  readonly onEvent?: ((event: DestroyEvent) => void) | undefined;
}

export async function destroy(input: DestroyInput): Promise<Result<void, CliStructuredError>> {
  return destroyWithDeps(input, {});
}

/** In-package variant threading the injection seam, for the unit tests.
 * Deliberately NOT re-exported through `./control` — the seam mirrors
 * internal types and is not part of the published surface. */
export async function destroyWithDeps(
  input: DestroyInput,
  deps: OperationDeps,
): Promise<Result<void, CliStructuredError>> {
  if (typeof input.environment !== 'string' || input.environment.length === 0) {
    return notOk(environmentRequired());
  }
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-deploy-destroy.ts');
  try {
    executor = await import('./execute-deploy-destroy.ts');
  } catch (error) {
    return notOk(executorLoadFailure('destroy', error));
  }
  return executor.executeDestroy(input, deps, cwd);
}

function environmentRequired(): CliStructuredError {
  return new CliStructuredError(
    'DEPLOY.ENVIRONMENT_REQUIRED',
    'destroy needs the name of the environment to destroy.',
    {
      why: 'Destroy never defaults to production, so a call without a name has no target.',
      fix: "Pass `environment`, for example `destroy({ environment: 'staging', config })`.",
    },
  );
}
