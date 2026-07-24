/**
 * The local-target provider bundle (local-dev spec § 4): the SAME
 * `Providers` collection tag `providers()` uses, backed by the eight local
 * providers instead of the hosted Management-API-backed ones. No
 * `ManagementClient`, no credentials layer — this bundle must typecheck
 * without either.
 */
import type { LocalTargetProvidersInput } from '@internal/core/config';
import { Providers } from '@internal/lowering';
import { Bucket, BucketKey } from '@internal/lowering/buckets';
import { ComputeService, Deployment, EnvironmentVariable } from '@internal/lowering/compute';
import { Connection, Database, Project } from '@internal/lowering/postgres';
import * as Provider from 'alchemy/Provider';
import * as Layer from 'effect/Layer';
import { LocalBucketKeyProvider, LocalBucketProvider } from './bucket.ts';
import {
  LocalComputeServiceProvider,
  LocalDeploymentProvider,
  LocalEnvironmentVariableProvider,
  LocalProjectProvider,
} from './compute.ts';
import { LocalConnectionProvider, LocalDatabaseProvider } from './postgres.ts';

export const localTargetProviders = (input: LocalTargetProvidersInput): Layer.Layer<never> =>
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
