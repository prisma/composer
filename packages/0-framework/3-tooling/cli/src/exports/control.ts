/**
 * Public surface (the `./control` subpath): the programmatic
 * deploy/destroy/dev/log operations. Implementation lives in ../operations/.
 * Importing it executes nothing — the heavy pipeline loads lazily inside
 * each operation. Distinct from an EXTENSION's `/control`
 * entry (ADR-0017's control-plane descriptors, importable only from
 * `prisma-composer.config.ts`): this subpath is for hosts driving the deploy
 * pipeline in-process.
 *
 * Failures are `CliStructuredError`s on the shared `Result` shape. The
 * class itself is deliberately not value-exported: hosts recognize failures
 * structurally, via their own foundation copy's predicates (ADR-0044's
 * structural recognition; ADR 239 in prisma/prisma).
 */

export type { CliStructuredError } from '@internal/foundation/errors';
export type { NotOk, Ok, Result } from '@internal/foundation/result';
export type { DeployedNodeSummary, DeploymentSummary } from '../deployment-summary.ts';
export type { DeployInput, DeploySuccess } from '../operations/deploy.ts';
export { deploy } from '../operations/deploy.ts';
export type {
  DestroyEvent,
  DestroyInput,
  DestroyTarget,
} from '../operations/destroy.ts';
export { destroy } from '../operations/destroy.ts';
export type { DevEvent, DevInput, DevSession } from '../operations/dev.ts';
export { dev } from '../operations/dev.ts';
export type { LogAttached, LogEvent, LogInput, LogLine } from '../operations/log.ts';
export { log } from '../operations/log.ts';
export type { ExecutionDiagnostics, ServiceEndpoint } from '../operations/shared.ts';
export { executionDiagnostics } from '../operations/shared.ts';
export type { RunReport, RunReportFailure } from '../run-report.ts';
export { RUN_REPORT_FILE_ENV, RUN_REPORT_VERSION } from '../run-report.ts';
