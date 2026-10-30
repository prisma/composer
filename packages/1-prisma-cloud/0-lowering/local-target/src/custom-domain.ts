import { CustomDomain } from '@alchemy.run/prisma';
import type { LocalTargetProvidersInput } from '@internal/core/config';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import { DEV_TIMESTAMP } from './upstream-attributes.ts';

function appIdOfInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Predicate.isObject(value) && typeof value['appId'] === 'string') return value['appId'];
  return 'local';
}

/** `CustomDomain` → nothing: local dev serves each service on its local URL and calls no platform. */
export function LocalCustomDomainProvider(
  _input: LocalTargetProvidersInput,
): Layer.Layer<Provider.Provider<CustomDomain>> {
  const service: Provider.ProviderService<CustomDomain> = {
    list: () => Effect.succeed([]),
    reconcile: ({ id, news }) =>
      Effect.succeed({
        customDomainId: `local-${id}`,
        hostname: news.hostname,
        appId: appIdOfInput(news.app),
        status: 'active',
        foundryStatus: 'active',
        failureReason: null,
        failureCategory: null,
        certExpiresAt: null,
        dnsRecords: [],
        createdAt: DEV_TIMESTAMP,
        updatedAt: DEV_TIMESTAMP,
      } satisfies CustomDomain['Attributes']),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  };
  return Provider.effect(CustomDomain, Effect.succeed(service));
}
