import * as Prisma from '@alchemy.run/prisma';
import { Credentials } from '@distilled.cloud/prisma';
import type { CallerCredentials } from '@internal/core/config';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { ManagementApiClient } from './client.ts';
import * as client from './client.ts';
import { suppliedClientOrigin, tokenClientOrigin } from './credentials.ts';
import { managementApiHttpClientLayer } from './management-api-http-client.ts';

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
  Layer.succeed(
    Prisma.PrismaEnvironment,
    Effect.succeed({
      type: 'serviceToken' as const,
      source: clientSupplied
        ? {
            type: 'stored' as const,
            details:
              "held by the caller's Management API client (for `prisma deploy`, the `prisma` CLI's signed-in credential), which authenticates each request",
          }
        : { type: 'env' as const, details: 'PRISMA_SERVICE_TOKEN' },
      baseUrl,
    }),
  );

const operationCredentials = (apiBaseUrl: string) =>
  Layer.succeed(Credentials, Effect.succeed({ apiBaseUrl }));

/** The bundle's `HttpClient`, over `ManagementClient` (see `managementApiHttpClientLayer`). */
const managementApiHttpLayer = (origin: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      return managementApiHttpClientLayer(yield* client.ManagementClient, origin);
    }),
  );

type EnvironmentVariableService = Provider.ProviderService<Prisma.EnvironmentVariable>;

// Correct only while hosted deploys declare no rows, so every delete is of a row an older Composer wrote:
// a row whose recorded identity no longer matches would otherwise fail this deploy and every later one.
const droppingMismatchedRows = (
  service: EnvironmentVariableService,
): EnvironmentVariableService => ({
  ...service,
  delete: (input) =>
    service.delete(input).pipe(
      Effect.catchIf(
        (error) => error._tag === 'EnvironmentVariableConflict',
        () =>
          Effect.logWarning(
            `Composer could not delete the variable ${input.output.key} that an older Composer wrote, ` +
              "because the platform's record of it no longer matches the deploy state. Composer has " +
              'stopped tracking it. Delete it in Console if it is still listed.',
          ),
      ),
    ),
  ...(service.modes === undefined
    ? {}
    : {
        modes: {
          live: Effect.map(service.modes.live, droppingMismatchedRows),
          local: Effect.map(service.modes.local, droppingMismatchedRows),
        },
      }),
});

export const providerForDeletingOldVariableRows = () =>
  Provider.effect(
    Prisma.EnvironmentVariable,
    Effect.map(Prisma.EnvironmentVariable.Provider, droppingMismatchedRows),
  ).pipe(Layer.provide(Prisma.EnvironmentVariableProvider()));

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
    providerForDeletingOldVariableRows(),
    Prisma.BucketProvider(),
    Prisma.BucketAccessKeyProvider(),
    Prisma.CustomDomainProvider(),
  ).pipe(
    Layer.provideMerge(Prisma.PrismaClientLive),
    Layer.provideMerge(prismaEnvironment(baseUrl, clientSupplied)),
    Layer.provideMerge(operationCredentials(baseUrl)),
  );

/** Throws `DEPLOY.MANAGEMENT_API_URL_CONFLICT` when the caller supplies a client and `PRISMA_API_URL` names another host. */
export const providers = (credentials?: Pick<CallerCredentials<ManagementApiClient>, 'client'>) => {
  const suppliedOrigin =
    credentials?.client === undefined ? undefined : suppliedClientOrigin(process.env);
  return Layer.unwrap(
    Effect.map(
      suppliedOrigin === undefined ? tokenClientOrigin() : Effect.succeed(suppliedOrigin),
      (origin) =>
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
          Layer.provideMerge(upstreamPrismaProviders(origin, credentials?.client !== undefined)),
          Layer.provideMerge(managementApiHttpLayer(origin)),
          Layer.provideMerge(client.suppliedOrFromEnv(credentials, origin)),
        ),
    ),
  ).pipe(Layer.orDie);
};
