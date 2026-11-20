/**
 * The `SentVariableNames` Alchemy resource: every variable name a service's deployments have been sent, kept in
 * deploy state so a name Composer no longer sends can be sent as `null`, which deletes it from the service.
 */
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';

export interface SentVariableNamesProps {
  /** This deploy's variable names, sorted. */
  readonly names: readonly string[];
}

export interface SentVariableNamesAttributes {
  /** Every variable name this resource has been given, sorted. */
  readonly names: readonly string[];
}

export type SentVariableNames = Resource<
  'PrismaCloud.SentVariableNames',
  SentVariableNamesProps,
  SentVariableNamesAttributes
>;

export const SentVariableNames = Resource<SentVariableNames>('PrismaCloud.SentVariableNames');

function union(recorded: readonly string[] | undefined, sent: readonly string[]) {
  return { names: [...new Set([...(recorded ?? []), ...sent])].sort() };
}

const sentVariableNamesProviderService: Provider.ProviderService<SentVariableNames> = {
  list: () => Effect.succeed([]),
  reconcile: ({ news, output }) => Effect.sync(() => union(output?.names, news.names)),
  delete: () => Effect.void,
};

export const SentVariableNamesProvider = () =>
  Provider.effect(SentVariableNames, Effect.succeed(sentVariableNamesProviderService));
