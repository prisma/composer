/**
 * The dev provider bundle (local-dev spec § 4): the SAME `Providers`
 * collection tag `providers()` uses, backed by the eight local providers
 * instead of the hosted Management-API-backed ones. No `ManagementClient`,
 * no credentials layer — the dev bundle must typecheck without either.
 */
import type { DevProvidersInput } from '@internal/core/config';
import * as Provider from 'alchemy/Provider';
import * as Layer from 'effect/Layer';
import { Bucket } from '../buckets/Bucket.ts';
import { BucketKey } from '../buckets/BucketKey.ts';
import { ComputeService } from '../compute/ComputeService.ts';
import { Deployment } from '../compute/Deployment.ts';
import { EnvironmentVariable } from '../compute/EnvironmentVariable.ts';
import { Connection } from '../postgres/Connection.ts';
import { Database } from '../postgres/Database.ts';
import { Project } from '../postgres/Project.ts';
import { Providers } from '../providers.ts';
import { LocalBucketKeyProvider, LocalBucketProvider } from './bucket.ts';
import {
  LocalComputeServiceProvider,
  LocalDeploymentProvider,
  LocalEnvironmentVariableProvider,
  LocalProjectProvider,
} from './compute.ts';
import { LocalConnectionProvider, LocalDatabaseProvider } from './postgres.ts';

export const devProviders = (input: DevProvidersInput): Layer.Layer<never> =>
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
        LocalProjectProvider(input),
        LocalDatabaseProvider(input),
        LocalConnectionProvider(input),
        LocalComputeServiceProvider(input),
        LocalDeploymentProvider(input),
        LocalEnvironmentVariableProvider(input),
        LocalBucketProvider(input),
        LocalBucketKeyProvider(input),
      ),
    ),
    Layer.orDie,
  );
