/**
 * The `SentKeys` Alchemy resource: every key name a service's deployments have
 * been sent, kept in deploy state so a key the service stops sending can be
 * sent as `null`, which deletes it from the service. It holds names, never
 * values. Its output changes only when its input names a key it has not seen.
 */
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';

export interface SentKeysProps {
  /** This deploy's key names, sorted. */
  readonly keys: readonly string[];
}

export interface SentKeysAttributes {
  /** Every key name this resource has been given, sorted. */
  readonly keys: readonly string[];
}

export type SentKeys = Resource<'PrismaCloud.SentKeys', SentKeysProps, SentKeysAttributes>;

export const SentKeys = Resource<SentKeys>('PrismaCloud.SentKeys');

export function sentKeysUnion(
  recorded: readonly string[] | undefined,
  sent: readonly string[],
): SentKeysAttributes {
  return { keys: [...new Set([...(recorded ?? []), ...sent])].sort() };
}

export const sentKeysProviderService: Provider.ProviderService<SentKeys> = {
  list: () => Effect.succeed([]),
  reconcile: ({ news, output }) => Effect.sync(() => sentKeysUnion(output?.keys, news.keys)),
  delete: () => Effect.void,
};

export const SentKeysProvider = () =>
  Provider.effect(SentKeys, Effect.succeed(sentKeysProviderService));
