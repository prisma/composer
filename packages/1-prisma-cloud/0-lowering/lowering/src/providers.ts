import { Credentials, Retry } from '@distilled.cloud/prisma';
import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import * as Prisma from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';
import * as client from './client.ts';
import {
  deploySourceHeaders,
  fromEnv,
  managementApiBaseUrl,
  PrismaCredentials,
} from './credentials.ts';

/** The collection of Prisma resource providers. */
export class Providers extends Provider.ProviderCollection<Providers>()('PrismaComposer') {}

/**
 * Upstream's `PrismaEnvironment`, built from Composer's own env credentials —
 * no profile store, so no TTY prompt and no non-interactive hard-fail:
 * `PRISMA_SERVICE_TOKEN` (redacted, via `PrismaCredentials`) plus the base
 * URL from `managementApiBaseUrl()` — the SAME resolver `client.ts` uses,
 * so `PRISMA_API_URL` moves the postgres family and the compute/bucket/state
 * clients together, never one without the other.
 */
const prismaEnvironment = () =>
  Layer.effect(
    Prisma.PrismaEnvironment,
    Effect.gen(function* () {
      const { token } = yield* PrismaCredentials;
      const baseUrl = yield* managementApiBaseUrl();
      return {
        type: 'serviceToken' as const,
        serviceToken: token,
        source: { type: 'env' as const, details: 'PRISMA_SERVICE_TOKEN' },
        baseUrl,
      };
    }),
  );

/** Both upstream client generations read the same Composer token and API origin. */
const prismaOperationEnvironment = () =>
  Layer.mergeAll(
    Layer.effect(
      Credentials,
      Effect.gen(function* () {
        const { token } = yield* PrismaCredentials;
        const apiBaseUrl = yield* managementApiBaseUrl();
        return Effect.succeed({ apiToken: token, apiBaseUrl });
      }),
    ),
    Layer.succeed(Retry.Retry, Retry.makeDefault),
  );

/**
 * A node:http transport that adds deploy-source headers to Management API calls.
 */
const prismaManagementHttpLayer = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient;
    return HttpClient.mapRequest(base, HttpClientRequest.setHeaders(deploySourceHeaders()));
  }),
).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));

/**
 * Upstream alchemy's live providers for the postgres family (Project,
 * Database, Connection), the compute family (App, Deployment,
 * EnvironmentVariable), and the bucket family (Bucket, BucketAccessKey),
 * over upstream's management clients, authenticated by the same env token.
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
  ).pipe(
    Layer.provideMerge(Prisma.PrismaClientLive),
    // The legacy client captures this transport at layer construction.
    Layer.provide(prismaManagementHttpLayer),
    Layer.provideMerge(prismaEnvironment()),
    Layer.provideMerge(prismaOperationEnvironment()),
  );

/**
 * The Prisma provider bundle: every resource provider, the Management API
 * client, and env-based credentials. Plug into a stack with
 * `{ providers: Prisma.providers() }`.
 *
 * The node transport is also the bundle's ambient `HttpClient`: newer upstream
 * providers call the generated Management API operations through it, and
 * deployment uploads need its explicit Content-Length. Composer's own API
 * client carries its own transport and does not consume this ambient service.
 */
export const providers = () =>
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
    ]),
  ).pipe(
    Layer.provideMerge(upstreamPrismaProviders()),
    Layer.provideMerge(prismaManagementHttpLayer),
    Layer.provideMerge(client.layer()),
    Layer.provideMerge(fromEnv()),
    Layer.orDie,
  );
