/**
 * The run report: one deploy's outcome as JSON, for tools that consume a
 * deploy rather than watch one — the Prisma GitHub Action reads it to build a
 * pull-request comment carrying preview links.
 *
 * Deliberately separate from `deployment-summary.ts`. That file is a private
 * carrier between the alchemy child and this process, written to a
 * per-run path the parent deletes in a `finally` so resource ids and URLs do
 * not accumulate on disk. This one is written where the operator asked for
 * it, survives the run, is written on the failure path too, and carries a
 * version so a consumer can depend on its shape.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DeployedNodeSummary, DeploymentSummary } from './deployment-summary.ts';

/** Bump when a change would break a consumer that reads the current shape. */
export const RUN_REPORT_VERSION = 1;

/** Names the file to write the run report to, when `--report` is not passed. */
export const RUN_REPORT_FILE_ENV = 'PRISMA_COMPOSER_REPORT_FILE';

export interface RunReportFailure {
  /** The deploy's own error code, e.g. `DEPLOY.PREFLIGHT_FAILED`. */
  readonly code: string;
  readonly message: string;
}

/**
 * Every field is always present, and absent scalars are `null` rather than
 * omitted — a consumer can read `report.failure` without first testing
 * whether the key exists.
 */
export interface RunReport {
  readonly version: number;
  readonly outcome: 'succeeded' | 'failed';
  /** Null when the run failed before it produced a deployment summary. */
  readonly app: string | null;
  /** Null for the default stage. */
  readonly stage: string | null;
  readonly nodes: readonly DeployedNodeSummary[];
  readonly failure: RunReportFailure | null;
}

export interface RunReportInput {
  readonly summary: DeploymentSummary | undefined;
  readonly stage: string | undefined;
  readonly failure: RunReportFailure | undefined;
}

export function toRunReport(input: RunReportInput): RunReport {
  return {
    version: RUN_REPORT_VERSION,
    outcome: input.failure === undefined ? 'succeeded' : 'failed',
    app: input.summary?.app ?? null,
    stage: input.stage ?? null,
    nodes: input.summary?.nodes ?? [],
    failure: input.failure ?? null,
  };
}

/**
 * The path to write to: the `--report` flag first, then the env var. Relative
 * paths resolve against the deploy's cwd. `undefined` means no report was
 * asked for, which is the common case and writes nothing.
 */
export function resolveRunReportPath(
  flag: string | undefined,
  env: string | undefined,
  cwd: string,
): string | undefined {
  const requested = flag !== undefined && flag.length > 0 ? flag : env;
  if (requested === undefined || requested.length === 0) return undefined;
  return path.resolve(cwd, requested);
}

/**
 * Writes the report, creating the parent directory if needed. A write failure
 * warns and returns false rather than failing a deploy that already
 * converged — but it is never silent, because the operator asked for this
 * file and a consumer is waiting on it.
 */
export function writeRunReport(filePath: string, report: RunReport): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`\nCould not write the run report to ${filePath}: ${detail}`);
    return false;
  }
}
