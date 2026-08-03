import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import * as Prisma from 'alchemy/Prisma';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Bucket, BucketProvider } from './buckets/Bucket.ts';
import { BucketKey, BucketKeyProvider } from './buckets/BucketKey.ts';
import * as client from './client.ts';
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
 * Upstream alchemy's live providers for the postgres family (Project,
 * Database, Connection) and the compute family (App, Deployment,
 * EnvironmentVariable), over upstream's management client, authenticated by
 * {@link prismaEnvironment}.
 *
 * alchemy 2.0.0-beta.67 exports only the per-resource provider layers, so
 * they are composed by hand here. TODO: switch to upstream's
 * `liveProviderLayer` in the alchemy release that exports it.
 */
const upstreamPrismaProviders = () =>
  Layer.mergeAll(
    Prisma.ProjectProvider(),
    Prisma.DatabaseProvider(),
    Prisma.ConnectionProvider(),
    Prisma.AppProvider(),
    Prisma.DeploymentProvider(),
    Prisma.EnvironmentVariableProvider(),
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
 *
 * The node transport is ALSO exposed as the bundle's ambient `HttpClient`,
 * overriding the stack's fetch client. Upstream's `Deployment` PUTs the
 * artifact to a presigned URL, which requires an explicit Content-Length on a
 * file-backed body — what node's transport sends and fetch's chunked streaming
 * does not. Upstream serves that from a Prisma-scoped service whose package
 * subpath (`alchemy/Prisma/Internal/*`) is exported as `null`, so it cannot be
 * composed in privately from outside; upstream documents the ambient client as
 * the supported fallback, which is what this makes correct.
 *
 * The invariant that keeps this safe, and that new code must preserve: **no
 * Composer provider may resolve the ambient `HttpClient`**. Every one of them
 * carries its own client — the Management API client (openapi-fetch), the
 * bucket resources through it, `PgWarm`/`PnMigration` over postgres.js — so
 * this layer's override reaches only upstream's artifact upload. A provider
 * that starts taking `HttpClient.HttpClient` would silently be handed the node
 * transport by this line. Filed upstream: export the scoped upload client (or
 * open the Internal subpath), after which this becomes a private
 * `PrismaUploadClientLive` and the invariant can be retired.
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
      Bucket,
      BucketKey,
    ]),
  ).pipe(
    Layer.provide(Layer.mergeAll(upstreamPrismaProviders(), BucketProvider(), BucketKeyProvider())),
    Layer.provideMerge(NodeHttpClient.layerNodeHttp),
    Layer.provideMerge(client.layer()),
    Layer.provideMerge(fromEnv()),
    Layer.orDie,
  );
