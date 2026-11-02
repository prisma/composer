/**
 * The local-target provider bundle (local-dev spec § 4): the SAME
 * `Providers` collection tag `providers()` uses, backed by the local
 * providers instead of the hosted Management-API-backed ones. No
 * `ManagementClient`, no credentials layer — this bundle must typecheck
 * without either.
 */

import {
  App,
  Bucket,
  BucketAccessKey,
  Connection,
  CustomDomain,
  Database,
  Deployment,
  EnvironmentVariable,
  Project,
} from '@alchemy.run/prisma';
import type { LocalTargetProvidersInput } from '@internal/core/config';
import { Providers } from '@internal/lowering';
import * as Provider from 'alchemy/Provider';
import * as Layer from 'effect/Layer';
import { LocalBucketAccessKeyProvider, LocalBucketProvider } from './bucket.ts';
import {
  LocalAppProvider,
  LocalDeploymentProvider,
  LocalEnvironmentVariableProvider,
  LocalProjectProvider,
} from './compute.ts';
import { LocalCustomDomainProvider } from './custom-domain.ts';
import { LocalConnectionProvider, LocalDatabaseProvider } from './postgres.ts';

export const localTargetProviders = (input: LocalTargetProvidersInput): Layer.Layer<never> =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      Database,
      Connection,
      App,
      Deployment,
      EnvironmentVariable,
      Bucket,
      BucketAccessKey,
      CustomDomain,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        LocalProjectProvider(input),
        LocalDatabaseProvider(input),
        LocalConnectionProvider(input),
        LocalAppProvider(input),
        LocalDeploymentProvider(input),
        LocalEnvironmentVariableProvider(input),
        LocalBucketProvider(input),
        LocalBucketAccessKeyProvider(input),
        LocalCustomDomainProvider(input),
      ),
    ),
    Layer.orDie,
  );
