import type { ProviderError } from 'alchemy/Provider';
import * as Data from 'effect/Data';
import * as Predicate from 'effect/Predicate';

/** A failure a Composer provider caught that was not already tagged, under the message it carried. */
export class ProviderFailed extends Data.TaggedError('ProviderFailed')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const isProviderError = (value: unknown): value is ProviderError =>
  Predicate.isObject(value) && typeof value['_tag'] === 'string';

/** Alchemy requires a provider to fail with a tagged error; a tagged one passes through unchanged. */
export function providerError(cause: unknown): ProviderError {
  if (isProviderError(cause)) return cause;
  return new ProviderFailed({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}
