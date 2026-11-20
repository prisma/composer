import type { CallerCredentials } from '@internal/core/config';
import { createManagementApiClient } from '@prisma/management-api-sdk';
import type * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import {
  deploySourceHeaders,
  fromEnv,
  PrismaCredentials,
  tokenClientOrigin,
} from './credentials.ts';

export type ManagementApiClient = ReturnType<typeof createManagementApiClient>;

/**
 * The typed Prisma Management API client, built once from the resolved
 * credentials. Providers yield this in their outer Effect and call it inside
 * `reconcile` / `delete`.
 */
export class ManagementClient extends Context.Service<ManagementClient, ManagementApiClient>()(
  'PrismaManagementClient',
) {}

const REQUEST_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'PUT',
  'POST',
  'DELETE',
  'OPTIONS',
  'HEAD',
  'PATCH',
  'TRACE',
]);

const headersWithIdentity = (headers: unknown): Headers | Record<string, unknown> => {
  const identity = deploySourceHeaders();
  if (headers instanceof Headers || Array.isArray(headers)) {
    const merged = new Headers(headers);
    for (const [name, value] of Object.entries(identity)) merged.set(name, value);
    return merged;
  }
  // A plain record keeps its form: openapi-fetch reads a `null` value as
  // "remove this header", which a `Headers` cannot hold.
  return typeof headers === 'object' && headers !== null ? { ...headers, ...identity } : identity;
};

const initWithIdentity = (init: unknown): Record<string, unknown> =>
  typeof init === 'object' && init !== null
    ? { ...init, headers: headersWithIdentity(Reflect.get(init, 'headers')) }
    : { headers: deploySourceHeaders() };

/** The caller's client is not changed. */
export const withComposerIdentity = (client: ManagementApiClient): ManagementApiClient =>
  new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'request') {
        return (method: unknown, url: unknown, init?: unknown) =>
          Reflect.apply(value, target, [method, url, initWithIdentity(init)]);
      }
      if (typeof property === 'string' && REQUEST_METHODS.has(property)) {
        return (url: unknown, init?: unknown) =>
          Reflect.apply(value, target, [url, initWithIdentity(init)]);
      }
      return value;
    },
  });

export const composerClientOf = (
  credentials: Pick<CallerCredentials<ManagementApiClient>, 'client'> | undefined,
): ManagementApiClient | undefined =>
  credentials?.client === undefined ? undefined : withComposerIdentity(credentials.client);

/**
 * A client built from the resolved token, on `apiOrigin`, or on
 * `tokenClientOrigin()` when none is given.
 */
export const layer = (options?: {
  readonly apiOrigin?: string;
}): Layer.Layer<ManagementClient, Config.ConfigError | Error, PrismaCredentials> =>
  Layer.effect(
    ManagementClient,
    Effect.gen(function* () {
      const { token } = yield* PrismaCredentials;
      const baseUrl = options?.apiOrigin ?? (yield* tokenClientOrigin());
      return createManagementApiClient({
        token: Redacted.value(token),
        baseUrl,
        headers: deploySourceHeaders(),
      });
    }),
  );

/** The caller's already-authenticated client, or one built from `PRISMA_SERVICE_TOKEN` on `apiOrigin` when the caller supplies none. */
export const suppliedOrFromEnv = (
  credentials: Pick<CallerCredentials<ManagementApiClient>, 'client'> | undefined,
  apiOrigin: string,
): Layer.Layer<ManagementClient, Config.ConfigError | Error> => {
  const supplied = composerClientOf(credentials);
  return supplied === undefined
    ? layer({ apiOrigin }).pipe(Layer.provide(fromEnv()))
    : Layer.succeed(ManagementClient, supplied);
};
