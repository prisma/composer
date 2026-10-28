import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import { ManagementClient } from '@internal/lowering';
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type { EnvironmentSetApi } from './environment-set-api.ts';

export interface DeploymentArtifactProps {
  readonly deploymentId: string;
  readonly artifactHash: string;
  readonly requiredEnvironmentVariables: readonly string[];
  readonly release: boolean;
}

export interface DeploymentArtifactAttributes {
  readonly deploymentId: string;
  readonly artifactHash: string;
  readonly consoleUrl: string;
  readonly serviceEndpointDomain?: string;
}

/** Records a completed upstream upload before release can fail; upstream retains ownership of the bundle. */
export type DeploymentArtifact = Resource<
  'PrismaComposer.DeploymentArtifact',
  DeploymentArtifactProps,
  DeploymentArtifactAttributes
>;
export const DeploymentArtifact = Resource<DeploymentArtifact>('PrismaComposer.DeploymentArtifact');

export function deploymentArtifactProviderService(
  api: EnvironmentSetApi,
): Provider.ProviderService<DeploymentArtifact> {
  return {
    list: () => Effect.succeed([]),
    delete: () => Effect.void,
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          const params = { path: { deploymentId: news.deploymentId } };
          const recorded = await api.PUT('/v1/deployments/{deploymentId}/artifact', {
            params,
            body: {
              artifactHash: news.artifactHash,
              requiredEnvironmentVariables: [...news.requiredEnvironmentVariables],
            },
          });
          if (recorded.data === undefined) {
            throw new CliStructuredError(
              'DEPLOY.ARTIFACT_RECORD_FAILED',
              `Could not record the uploaded bundle (HTTP ${recorded.response.status}).`,
              {
                fix: 'Deploy again after checking platform access. The uploaded bundle has been retained.',
              },
            );
          }
          const { consoleUrl } = recorded.data.data;
          if (!news.release) {
            console.info(
              `Bundle retained. Configure environment values and redeploy: ${consoleUrl}`,
            );
            return { deploymentId: news.deploymentId, artifactHash: news.artifactHash, consoleUrl };
          }
          const released = await api.POST('/v1/deployments/{deploymentId}/release', { params });
          if (released.data === undefined) {
            throw new CliStructuredError(
              'DEPLOY.RELEASE_FAILED',
              `The uploaded bundle could not start (HTTP ${released.response.status}).`,
              {
                why: 'The bundle is retained and the previous healthy deployment keeps serving.',
                fix: `Check the logs and environment values at ${consoleUrl}, then click Redeploy.`,
                meta: { deploymentId: news.deploymentId, consoleUrl },
              },
            );
          }
          return {
            deploymentId: news.deploymentId,
            artifactHash: news.artifactHash,
            consoleUrl,
            serviceEndpointDomain: released.data.data.serviceEndpointDomain,
          };
        },
        catch: (error) => error,
      }),
  };
}

export const DeploymentArtifactProvider = () =>
  Provider.effect(
    DeploymentArtifact,
    Effect.gen(function* () {
      const client = yield* ManagementClient;
      const api = blindCast<
        EnvironmentSetApi,
        'the companion platform adds these routes; the existing openapi-fetch transport supports them before the generated SDK release'
      >(client);
      return deploymentArtifactProviderService(api);
    }),
  );
