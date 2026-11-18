import { createManagementApiClient } from '@prisma/management-api-sdk';
import type * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { deploySourceHeaders, managementApiBaseUrl, PrismaCredentials } from './credentials.ts';

export type ManagementApiClient = ReturnType<typeof createManagementApiClient>;

/**
 * The typed Prisma Management API client, built once from the resolved
 * credentials. Providers yield this in their outer Effect and call it inside
 * `reconcile` / `delete`.
 */
export class ManagementClient extends Context.Service<ManagementClient, ManagementApiClient>()(
  'PrismaManagementClient',
) {}

const PATH_METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE']);

/** A request's own headers with the deploy-source headers set over them. */
const withDeploySourceHeadersIn = (headers: unknown): Headers | Record<string, unknown> => {
  const own = deploySourceHeaders();
  if (headers instanceof Headers || Array.isArray(headers)) {
    const merged = new Headers(headers);
    for (const [name, value] of Object.entries(own)) merged.set(name, value);
    return merged;
  }
  // A plain record keeps its form: openapi-fetch reads a `null` value as
  // "remove this header", which a `Headers` cannot hold.
  return typeof headers === 'object' && headers !== null ? { ...headers, ...own } : own;
};

const withInitHeaders = (init: unknown): Record<string, unknown> =>
  typeof init === 'object' && init !== null
    ? { ...init, headers: withDeploySourceHeadersIn(Reflect.get(init, 'headers')) }
    : { headers: deploySourceHeaders() };

/**
 * A view of a caller's client whose every request carries the deploy-source
 * headers, set over any the client sends by default. The caller's client is
 * not changed: under `prisma deploy` it is the `prisma` CLI's own client, and
 * the CLI's own requests keep its headers. Only Composer's requests through
 * this view say they came from Composer.
 */
export const withDeploySourceHeaders = (client: ManagementApiClient): ManagementApiClient =>
  new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'request') {
        return (method: unknown, url: unknown, init?: unknown) =>
          Reflect.apply(value, target, [method, url, withInitHeaders(init)]);
      }
      if (typeof property === 'string' && PATH_METHODS.has(property)) {
        return (url: unknown, init?: unknown) =>
          Reflect.apply(value, target, [url, withInitHeaders(init)]);
      }
      return value;
    },
  });

/**
 * By default the base URL comes from `managementApiBaseUrl()` — the SAME
 * resolver upstream's providers use (see providers.ts), so `PRISMA_API_URL`
 * can never split the postgres family and the compute/bucket/state clients
 * across hosts. `apiOrigin` overrides it (tests point it at a fake).
 */
export const layer = (options?: {
  readonly apiOrigin?: string;
}): Layer.Layer<ManagementClient, Config.ConfigError | Error, PrismaCredentials> =>
  Layer.effect(
    ManagementClient,
    Effect.gen(function* () {
      const { token } = yield* PrismaCredentials;
      const baseUrl = options?.apiOrigin ?? (yield* managementApiBaseUrl());
      return createManagementApiClient({
        token: Redacted.value(token),
        baseUrl,
        headers: deploySourceHeaders(),
      });
    }),
  );
