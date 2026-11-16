import type * as Provider from 'alchemy/Provider';
import * as Data from 'effect/Data';
import * as Predicate from 'effect/Predicate';

export const PROVIDER_FAILURE_TAG = 'ProviderFailure';

/** A provider operation failed with an error that carries no `_tag` of its own; `cause` is that error. */
export class ProviderFailure extends Data.TaggedError(PROVIDER_FAILURE_TAG)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function isProviderError(cause: unknown): cause is Provider.ProviderError {
  return Predicate.hasProperty(cause, '_tag') && typeof cause._tag === 'string';
}

/** What a provider operation threw, as the error Alchemy's lifecycle methods fail with: an error with a `_tag` as it is, anything else wrapped in a `ProviderFailure`. */
export function toProviderError(cause: unknown): Provider.ProviderError {
  if (isProviderError(cause)) return cause;
  return new ProviderFailure({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}
