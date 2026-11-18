import type * as Provider from 'alchemy/Provider';
import * as Data from 'effect/Data';
import * as Predicate from 'effect/Predicate';

const PROVIDER_FAILURE_TAG = 'ProviderFailure';

/** A provider operation failed with an error that carries no `_tag` of its own; `cause` is that error. */
class ProviderFailure extends Data.TaggedError(PROVIDER_FAILURE_TAG)<{
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

/** The original error of a provider failure `toProviderError` wrapped, or `undefined` for any other error. */
export function wrappedProviderError(error: unknown): unknown {
  return Predicate.isTagged(error, PROVIDER_FAILURE_TAG) && 'cause' in error
    ? error.cause
    : undefined;
}
