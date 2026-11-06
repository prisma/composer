import * as Prisma from '@alchemy.run/prisma';
import { Credentials } from '@distilled.cloud/prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { ManagementApiClient } from './client.ts';
import * as client from './client.ts';
import { deployHttpClientLayer } from './deploy-http-client.ts';

/** The collection of Prisma resource providers. */
export class Providers extends Provider.ProviderCollection<Providers>()('PrismaComposer') {}

/**
 * Upstream's `PrismaEnvironment`, with no token: the bundle's `HttpClient`
 * sends Management API requests through `ManagementClient`, which
 * authenticates them. Upstream's type has no case for "the HTTP client
 * authenticates", so `type` is the only value it allows, and `source` says
 * where the credential really is.
 */
const prismaEnvironment = (baseUrl: string, clientSupplied: boolean) =>
  Layer.succeed(Prisma.PrismaEnvironment, {
    type: 'serviceToken' as const,
    source: clientSupplied
      ? {
          type: 'stored' as const,
          details:
            "held by the caller's Management API client (for `prisma deploy`, the `prisma` CLI's signed-in credential), which authenticates each request",
        }
      : { type: 'env' as const, details: 'PRISMA_SERVICE_TOKEN' },
    baseUrl,
  });

const operationCredentials = (apiBaseUrl: string) =>
  Layer.succeed(Credentials, Effect.succeed({ apiBaseUrl }));

/** The bundle's `HttpClient`, over `ManagementClient` (see `deployHttpClientLayer`). */
const prismaDeployHttpLayer = (origin: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      return deployHttpClientLayer(yield* client.ManagementClient, origin);
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
const upstreamPrismaProviders = (baseUrl: string, clientSupplied: boolean) =>
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
    Layer.provideMerge(prismaEnvironment(baseUrl, clientSupplied)),
    Layer.provideMerge(operationCredentials(baseUrl)),
  );

/**
 * The Prisma provider bundle: every resource provider and the Management API
 * client. Plug into a stack with `{ providers: Prisma.providers() }`.
 *
 * `options.client` is the caller's authenticated Management API client; without
 * one, the bundle builds its own from `PRISMA_SERVICE_TOKEN`. Either way, every
 * Management API request, upstream's and Composer's, goes through that client,
 * at the origin `client.managementApiOrigin` resolves.
 *
 * The bundle's ambient `HttpClient` is {@link prismaDeployHttpLayer}:
 * upstream's operations resolve it when they run. Upstream's providers run
 * their operations against this bundle's output, so their credentials are
 * merged into it. Invariant: no Composer provider may resolve the ambient
 * `HttpClient` — each carries its own client — or it would silently get this
 * override.
 */
export const providers = (options?: { readonly client?: ManagementApiClient | undefined }) =>
  Layer.unwrap(
    Effect.map(client.managementApiOrigin(options?.client), (origin) =>
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
        Layer.provideMerge(upstreamPrismaProviders(origin, options?.client !== undefined)),
        Layer.provideMerge(prismaDeployHttpLayer(origin)),
        Layer.provideMerge(client.suppliedOrFromEnv(options?.client, origin)),
      ),
    ),
  ).pipe(Layer.orDie);
