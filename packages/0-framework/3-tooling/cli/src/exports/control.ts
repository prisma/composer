/**
 * Public surface (the `./control` subpath): the programmatic
 * deploy/destroy/dev/log operations. Implementation lives in ../operations/.
 * Import-safe in a broken effect tree — the heavy pipeline loads only behind
 * each operation's own preflight. Distinct from an EXTENSION's `/control`
 * entry (ADR-0017's control-plane descriptors, importable only from
 * `prisma-composer.config.ts`): this subpath is for hosts driving the deploy
 * pipeline in-process.
 */
export { deploy, destroy, dev, log } from '../operations/operations.ts';
export type {
  DeployInput,
  DeployResult,
  DestroyEvent,
  DestroyInput,
  DestroyResult,
  DestroyTarget,
  DevEndpoint,
  DevEvent,
  DevInput,
  DevSession,
  DevStartResult,
  LogEvent,
  LogInput,
  LogLine,
  LogResult,
  OperationDeps,
  OperationFailure,
} from '../operations/results.ts';
export type { DeployedNodeSummary, DeploymentSummary } from '../render-deployment.ts';
export { DEPLOYMENT_RESULT_FILE_ENV } from '../render-deployment.ts';
