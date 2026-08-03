import * as Provider from 'alchemy/Provider';
import * as Layer from 'effect/Layer';
import { Bucket, BucketProvider } from './buckets/Bucket.ts';
import { BucketKey, BucketKeyProvider } from './buckets/BucketKey.ts';
import * as client from './client.ts';
import { ComputeService, ComputeServiceProvider } from './compute/ComputeService.ts';
import { Deployment, DeploymentProvider } from './compute/Deployment.ts';
import { EnvironmentVariable, EnvironmentVariableProvider } from './compute/EnvironmentVariable.ts';
import { fromEnv } from './credentials.ts';
import { Connection, ConnectionProvider } from './postgres/Connection.ts';
import { Database, DatabaseProvider } from './postgres/Database.ts';
import { Project, ProjectProvider } from './postgres/Project.ts';

/** The collection of Prisma resource providers. */
export class Providers extends Provider.ProviderCollection<Providers>()('PrismaComposer') {}

/**
 * The Prisma provider bundle: every resource provider, the Management API
 * client, and env-based credentials. Plug into a stack with
 * `{ providers: Prisma.providers() }`.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      Database,
      Connection,
      ComputeService,
      Deployment,
      EnvironmentVariable,
      Bucket,
      BucketKey,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectProvider(),
        DatabaseProvider(),
        ConnectionProvider(),
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
