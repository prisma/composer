/**
 * The programmatic `devUrl` and `devStop` operations
 * (`@prisma/composer/control`): they act on the app and environment they are
 * given, read from that environment's dev state in the directory — no
 * build. The executor loads lazily, so importing this module executes
 * nothing.
 */
import type { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import type { ComposerConfigSource } from '../composer-config.ts';
import { executorLoadFailure, type OperationName } from './shared.ts';

export interface DevUrlInput {
  /** Composer's configuration: the `composer` section of `prisma.config.ts` and that file. It names the extensions whose local targets recorded the app. */
  readonly config: ComposerConfigSource;
  /** A node's full dotted address, starting with the app name, such as `shop.gateway`. The app is read from it. */
  readonly address: string;
  /** The environment whose local copy to read. Defaults to `dev`. */
  readonly environment?: string | undefined;
  /** The directory `prisma dev` ran from. Defaults to the process's working directory. */
  readonly cwd?: string | undefined;
}

export interface DevUrl {
  readonly address: string;
  /** What the node is, in its target's words; Prisma Cloud's are `service`, `database` and `bucket`. */
  readonly kind: string;
  /** A service's URL, a database's connection string, or a bucket's S3 endpoint plus `/<bucket>`. */
  readonly url: string;
  /** Always `running`: a node that is not running is a failure. */
  readonly state: string;
  /** `"dev-server"` when a service runs its build adapter's dev server, `"artifact"` for every other service; absent for a database or bucket (ADR-0056). */
  readonly runs?: 'artifact' | 'dev-server';
}

export interface DevStopInput {
  readonly config: ComposerConfigSource;
  /** The entry module, resolved against `cwd`. Overrides the `entry` in `config`; the app is its root's name. */
  readonly entry?: string | undefined;
  /** The app to stop, in place of the entry root's name. */
  readonly name?: string | undefined;
  /** The environment whose local copy to stop. Defaults to `dev`. */
  readonly environment?: string | undefined;
  /** The directory `prisma dev` ran from. Defaults to the process's working directory. */
  readonly cwd?: string | undefined;
}

export interface DevStopped {
  /** The app that was stopped. */
  readonly app: string;
  /** The environment whose local copy was stopped. */
  readonly environment: string;
  /** Each node whose process or server was stopped. Data and ports are kept. */
  readonly stopped: readonly { readonly address: string; readonly kind: string }[];
}

async function loadExecutor(
  operation: OperationName,
): Promise<Result<typeof import('./execute-dev-current.ts'), CliStructuredError>> {
  try {
    return ok(await import('./execute-dev-current.ts'));
  } catch (error) {
    return notOk(executorLoadFailure(operation, error));
  }
}

/** Where the node at `input.address` runs locally in the environment. */
export async function devUrl(input: DevUrlInput): Promise<Result<DevUrl, CliStructuredError>> {
  const executor = await loadExecutor('dev url');
  if (!executor.ok) return executor;
  return executor.value.executeDevUrl(input, input.cwd ?? process.cwd());
}

/** Stops the app's local copy in the environment: its service processes and database servers. Data and ports stay. */
export async function devStop(
  input: DevStopInput,
): Promise<Result<DevStopped, CliStructuredError>> {
  const executor = await loadExecutor('dev stop');
  if (!executor.ok) return executor;
  return executor.value.executeDevStop(input, input.cwd ?? process.cwd());
}
