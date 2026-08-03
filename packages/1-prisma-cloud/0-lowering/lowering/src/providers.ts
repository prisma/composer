import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import * as Prisma from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Bucket, BucketProvider } from './buckets/Bucket.ts';
import { BucketKey, BucketKeyProvider } from './buckets/BucketKey.ts';
import * as client from './client.ts';
import { ComputeService, ComputeServiceProvider } from './compute/ComputeService.ts';
import { Deployment, DeploymentProvider } from './compute/Deployment.ts';
import { EnvironmentVariable, EnvironmentVariableProvider } from './compute/EnvironmentVariable.ts';
import { fromEnv, managementApiBaseUrl, PrismaCredentials } from './credentials.ts';

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

/**
 * Upstream alchemy's live postgres-family providers (Project, Database,
 * Connection) over upstream's management client, authenticated by
 * {@link prismaEnvironment}.
 *
 * alchemy 2.0.0-beta.67 exports only the per-resource provider layers, so
 * they are composed by hand here. TODO: switch to upstream's
 * `liveProviderLayer` in the alchemy release that exports it.
 */
const upstreamPostgresProviders = () =>
  Layer.mergeAll(
    Prisma.ProjectProvider(),
    Prisma.DatabaseProvider(),
    Prisma.ConnectionProvider(),
  ).pipe(
    Layer.provideMerge(Prisma.PrismaClientLive),
    // Provide (NOT provideMerge) the node transport privately — mirrors
    // upstream's Providers.ts: it must serve only the Prisma management
    // client, never override the ambient HttpClient of other providers.
    Layer.provide(NodeHttpClient.layerNodeHttp),
    Layer.provideMerge(prismaEnvironment()),
  );

/**
 * The Prisma provider bundle: every resource provider, the Management API
 * client, and env-based credentials. Plug into a stack with
 * `{ providers: Prisma.providers() }`.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Prisma.Project,
      Prisma.Database,
      Prisma.Connection,
      ComputeService,
      Deployment,
      EnvironmentVariable,
      Bucket,
      BucketKey,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        upstreamPostgresProviders(),
        ComputeServiceProvider(),
        DeploymentProvider(),
        EnvironmentVariableProvider(),
        BucketProvider(),
        BucketKeyProvider(),
      ),
    ),
    Layer.provideMerge(client.layer()),
    Layer.provideMerge(fromEnv()),
    Layer.orDie,
  );
