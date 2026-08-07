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
export type { DeployInput, DeployResult, DeploySuccess } from '../operations/deploy.ts';
export { deploy } from '../operations/deploy.ts';
export type {
  DestroyEvent,
  DestroyInput,
  DestroyResult,
  DestroyTarget,
} from '../operations/destroy.ts';
export { destroy } from '../operations/destroy.ts';
export type { DevEvent, DevInput, DevSession, DevStartResult } from '../operations/dev.ts';
export { dev } from '../operations/dev.ts';
export type { LogAttached, LogEvent, LogInput, LogLine, LogResult } from '../operations/log.ts';
export { log } from '../operations/log.ts';
export type { ExecutionDiagnostics, ServiceEndpoint } from '../operations/shared.ts';
export { executionDiagnostics } from '../operations/shared.ts';
