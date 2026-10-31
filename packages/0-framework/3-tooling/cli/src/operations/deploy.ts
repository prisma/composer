/**
 * The programmatic `deploy` operation (`@prisma/composer/control`): typed
 * input, structured result, no argv, no console, no process.exit. The
 * family's `deploy` command is a thin renderer over it. The executor
 * loads lazily, so importing this module executes nothing; an executor that
 * fails to load comes back as a structured failure, never a throw out of
 * the host.
 */
import type { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, type Result } from '@internal/foundation/result';
import type { ComposerConfigSource } from '../composer-config.ts';
import type { DeploymentSummary } from '../deployment-summary.ts';
import { executorLoadFailure, type OperationDeps } from './shared.ts';

/** A deploy step. `assemble-service` steps run inside `assemble`, one per service, and `apply-resource` steps inside `apply`, one per resource Alchemy touches. */
export type DeployStep =
  | { readonly name: 'prepare' | 'assemble' | 'connect' | 'preflight' | 'apply' | 'record' }
  | { readonly name: 'assemble-service'; readonly address: string }
  | {
      readonly name: 'apply-resource';
      /** The resource's id in the stack. */
      readonly fqn: string;
      readonly resourceType: string;
      /** Alchemy's status word for what is happening to it, such as `creating` or `created`. */
      readonly status: string;
    };

export type DeployEvent =
  | { readonly kind: 'step-started'; readonly step: DeployStep }
  | {
      readonly kind: 'message';
      readonly severity: 'info' | 'warn' | 'verbose';
      /** A line Alchemy logged while it planned or applied. */
      readonly text: string;
    }
  | {
      readonly kind: 'step-finished';
      readonly step: DeployStep;
      readonly outcome: 'ok' | 'failed';
      readonly durationMs: number;
      /** What the step measured, as its build adapter or deploy target reported it. The fields vary by adapter and target. */
      readonly data?: Readonly<Record<string, string | number>> | undefined;
    };

/** The environment `deploy` targets when none is named. */
export const DEFAULT_DEPLOY_ENVIRONMENT = 'production';

export interface DeployInput {
  /**
   * Composer's configuration: the `composer` section of `prisma.config.ts` and that file. The operation does not look for a config file; it refuses a section the CLI would refuse, before any work starts.
   */
  readonly config: ComposerConfigSource;
  /** The entry module, resolved against `cwd`. Overrides the `entry` in `config`; without either the operation fails with `CONFIG.ENTRY_MISSING`. */
  readonly entry?: string | undefined;
  /** Override the root node's name (the `--name` flag's slot). */
  readonly name?: string | undefined;
  /** The environment to deploy to. Defaults to `production`. */
  readonly environment?: string | undefined;
  /** Defaults to process.cwd(); the directory `.prisma-composer/` and `.alchemy` state live under. */
  readonly cwd?: string | undefined;
  /**
   * Where to write the run report — the deploy's outcome as JSON, for a tool
   * that consumes a deploy rather than watches one. Relative paths resolve
   * against `cwd`. Absent falls back to `PRISMA_COMPOSER_REPORT_FILE`, and
   * absent from both writes no report.
   */
  readonly reportPath?: string | undefined;
  /**
   * An existing report record this deploy belongs to — the `--build-id` flag's
   * slot. A CI job that opens the record before invoking Composer passes the
   * id here, and the target's reporter joins that record instead of creating
   * one. Absent falls back to whatever the target reads from environment variables.
   */
  readonly reportId?: string | undefined;
  /** Each step as it starts and finishes, in real time. Rendering is the host's. */
  readonly onEvent?: ((event: DeployEvent) => void) | undefined;
  /** Interrupts the plan or apply when it aborts. The deploy then fails with `DEPLOY.INTERRUPTED`, after releasing the environment's state lease. */
  readonly signal?: AbortSignal | undefined;
}

export interface DeploySuccess {
  /** What the apply deployed. Undefined when the apply produced no report. */
  readonly summary: DeploymentSummary | undefined;
  /** How long the whole deploy took, from the call to its result. */
  readonly durationMs: number;
}

export async function deploy(
  input: DeployInput,
): Promise<Result<DeploySuccess, CliStructuredError>> {
  return deployWithDeps(input, {});
}

/** In-package variant threading the injection seam, which the family's
 * commands and the unit tests use. Deliberately NOT re-exported through `./control` — the seam mirrors
 * internal types and is not part of the published surface. */
export async function deployWithDeps(
  input: DeployInput,
  deps: OperationDeps,
): Promise<Result<DeploySuccess, CliStructuredError>> {
  const startedAt = performance.now();
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-deploy-destroy.ts');
  try {
    executor = await import('./execute-deploy-destroy.ts');
  } catch (error) {
    return notOk(executorLoadFailure('deploy', error));
  }
  const result = await executor.executeDeploy(input, deps, cwd);
  if (!result.ok) return result;
  return ok({ ...result.value, durationMs: Math.round(performance.now() - startedAt) });
}
