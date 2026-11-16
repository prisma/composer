import type * as Provider from 'alchemy/Provider';
import * as Data from 'effect/Data';
import * as Predicate from 'effect/Predicate';

/** A provider operation failed with an error that carries no `_tag` of its own. */
export class ProviderFailure extends Data.TaggedError('ProviderFailure')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function isProviderError(cause: unknown): cause is Provider.ProviderError {
  return Predicate.hasProperty(cause, '_tag') && typeof cause._tag === 'string';
}

/** Turns what a provider operation threw into the error type Alchemy's lifecycle methods fail with. */
export function providerFailure(cause: unknown): Provider.ProviderError {
  if (isProviderError(cause)) return cause;
  return new ProviderFailure({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}
