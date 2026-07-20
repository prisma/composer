import { StateStoreError } from 'alchemy/State';
import * as Data from 'effect/Data';

/** Collapses any thrown value (postgres.js failures included) into a {@link StateStoreError}. */
export const toStateStoreError = (cause: unknown): StateStoreError =>
  cause instanceof Error
    ? new StateStoreError({ message: cause.message, cause })
    : new StateStoreError({ message: String(cause) });

/**
 * An operator-facing failure from the hosted-state bootstrap pipeline
 * (branch/database discovery, connection creation, schema migration, or lock
 * acquisition) — what a deployer actually sees, instead of a raw Effect
 * defect.
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
 * threw. Never retains the raw driver/API error object as `cause`: a
 * postgres.js connection failure's `.message`/properties are not verified to
 * omit the DSN or credentials, so only the extracted message text survives
 * into the operator-facing error.
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
