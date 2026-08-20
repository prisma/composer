/**
 * The programmatic `deploy` operation (`@prisma/composer/control`): typed
 * input, structured result, no argv, no console, no process.exit. The
 * prisma-composer CLI (main.ts) is a thin renderer over it. The executor
 * loads lazily, so importing this module executes nothing; an executor that
 * fails to load comes back as a structured failure, never a throw out of
 * the host.
 */
import type { CliStructuredError } from '@internal/foundation/errors';
import { notOk, type Result } from '@internal/foundation/result';
import type { DeploymentSummary } from '../deployment-summary.ts';
import { executorLoadFailure, type OperationDeps } from './shared.ts';

export interface DeployInput {
  /** Path to the entry module, resolved against `cwd` — same contract as `prisma-composer deploy <entry>`. */
  readonly entry: string;
  /** Override the root node's name (the `--name` flag's slot). */
  readonly name?: string | undefined;
  /** Target stage. ABSENT = production — bare deploy targets production (main.ts effectiveStage). */
  readonly stage?: string | undefined;
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
   * one. Absent falls back to whatever the target reads from the environment.
   */
  readonly reportId?: string | undefined;
}

export interface DeploySuccess {
  /** Parsed from the alchemy child's result file. Undefined when the child
   * did not write one (injected fake alchemy, or a report-less apply). */
  readonly summary: DeploymentSummary | undefined;
}

export async function deploy(
  input: DeployInput,
): Promise<Result<DeploySuccess, CliStructuredError>> {
  return deployWithDeps(input, {});
}

/** In-package variant threading the injection seam (the CLI's RunDeps, unit
 * tests). Deliberately NOT re-exported through `./control` — the seam mirrors
 * internal types and is not part of the published surface. */
export async function deployWithDeps(
  input: DeployInput,
  deps: OperationDeps,
): Promise<Result<DeploySuccess, CliStructuredError>> {
  const cwd = input.cwd ?? process.cwd();
  let executor: typeof import('./execute-deploy-destroy.ts');
  try {
    executor = await import('./execute-deploy-destroy.ts');
  } catch (error) {
    return notOk(executorLoadFailure('deploy', error, cwd));
  }
  return executor.executeDeploy(input, deps, cwd);
}
