import * as Prisma from '@alchemy.run/prisma';
import { Credentials } from '@distilled.cloud/prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { ManagementApiClient } from './client.ts';
import * as client from './client.ts';
import { managementApiBaseUrl } from './credentials.ts';
import { managementHttpClientLayer } from './management-http-client.ts';

/** The collection of Prisma resource providers. */
export class Providers extends Provider.ProviderCollection<Providers>()('PrismaComposer') {}

/**
 * Upstream's `PrismaEnvironment` and the generated operations' `Credentials`,
 * with the base URL from `managementApiBaseUrl()` (the resolver `client.ts`
 * uses, so `PRISMA_API_URL` moves every client together) and no token: the
 * bundle's `HttpClient` sends Management API requests through
 * `ManagementClient`, which authenticates them.
 */
const prismaEnvironment = () =>
  Layer.effect(
    Prisma.PrismaEnvironment,
    Effect.map(managementApiBaseUrl(), (baseUrl) => ({
      type: 'serviceToken' as const,
      source: { type: 'env' as const, details: "the deploy's Management API client" },
      baseUrl,
    })),
  );

const operationCredentials = () =>
  Layer.effect(
    Credentials,
    Effect.map(managementApiBaseUrl(), (apiBaseUrl) => Effect.succeed({ apiBaseUrl })),
  );

/** The bundle's `HttpClient`, over `ManagementClient` (see `managementHttpClientLayer`). */
const prismaManagementHttpLayer = Layer.unwrap(
  Effect.gen(function* () {
    const management = yield* client.ManagementClient;
    const origin = yield* managementApiBaseUrl();
    return managementHttpClientLayer(management, origin);
  }),
);

/**
 * Upstream alchemy's live providers for the postgres family (Project,
 * Database, Connection), the compute family (App, Deployment,
 * EnvironmentVariable, CustomDomain), and the bucket family (Bucket, BucketAccessKey),
 * over upstream's management clients, configured by
 * {@link prismaEnvironment}.
 *
 * Composed from the per-resource provider layers rather than upstream's own
 * `providers()` bundle: that bundle pulls in the profile store
 * (`AlchemyProfile`/`CredentialsStore`), and Composer deliberately runs
 * without one — no TTY prompt, no non-interactive hard-fail.
 */
const upstreamPrismaProviders = () =>
  Layer.mergeAll(
    Prisma.ProjectProvider(),
    Prisma.DatabaseProvider(),
    Prisma.ConnectionProvider(),
    Prisma.AppProvider(),
    Prisma.DeploymentProvider(),
    Prisma.EnvironmentVariableProvider(),
    Prisma.BucketProvider(),
    Prisma.BucketAccessKeyProvider(),
    Prisma.CustomDomainProvider(),
  ).pipe(
    Layer.provideMerge(Prisma.PrismaClientLive),
    Layer.provideMerge(prismaEnvironment()),
    Layer.provideMerge(operationCredentials()),
  );

/**
 * The Prisma provider bundle: every resource provider and the Management API
 * client. Plug into a stack with `{ providers: Prisma.providers() }`.
 *
 * `options.client` is the caller's authenticated Management API client; without
 * one, the bundle builds its own from `PRISMA_SERVICE_TOKEN`. Either way, every
 * Management API request, upstream's and Composer's, goes through that client.
 *
 * The bundle's ambient `HttpClient` is {@link prismaManagementHttpLayer}:
 * upstream's operations resolve it when they run. Upstream's providers run
 * their operations against this bundle's output, so their credentials are
 * merged into it. Invariant: no Composer provider may resolve the ambient
 * `HttpClient` — each carries its own client — or it would silently get this
 * override.
 */
export const providers = (options?: { readonly client?: ManagementApiClient | undefined }) =>
  Layer.effect(
    Providers,
    Provider.collection([
      Prisma.Project,
      Prisma.Database,
      Prisma.Connection,
      Prisma.App,
      Prisma.Deployment,
      Prisma.EnvironmentVariable,
      Prisma.Bucket,
      Prisma.BucketAccessKey,
      Prisma.CustomDomain,
    ]),
  ).pipe(
    Layer.provideMerge(upstreamPrismaProviders()),
    Layer.provideMerge(prismaManagementHttpLayer),
    Layer.provideMerge(client.suppliedOrFromEnv(options?.client)),
    Layer.orDie,
  );
