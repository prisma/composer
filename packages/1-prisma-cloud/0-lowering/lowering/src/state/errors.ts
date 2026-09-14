import * as Data from 'effect/Data';

/**
 * An operator-facing failure from the hosted-state bootstrap pipeline
 * (branch resolution, lease acquisition, or the migration guard) — what a
 * deployer actually sees, instead of a raw Effect defect.
 */
export class HostedStateBootstrapError extends Data.TaggedError('HostedStateBootstrapError')<{
  /** The container the state store lives in: a Project id, or `projectId/branchId` for a named stage. */
  readonly container: string;
  readonly step: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `hosted-state bootstrap failed in ${this.container}: ${this.step} — ${this.reason}`;
  }
}

/**
 * Builds a {@link HostedStateBootstrapError} from whatever the failed step
 * threw. Never retains the raw API error object as `cause`: only the
 * extracted message text survives into the operator-facing error, so a
 * credential or lease id carried on the raw error can never leak.
 */
export const hostedStateBootstrapError = (
  container: string,
  step: string,
  cause: unknown,
): HostedStateBootstrapError =>
  new HostedStateBootstrapError({
    container,
    step,
    reason: cause instanceof Error ? cause.message : String(cause),
  });
