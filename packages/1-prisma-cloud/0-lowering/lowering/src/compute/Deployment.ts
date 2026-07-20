import * as fs from 'node:fs';
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import { ManagementClient } from '../client.ts';
import { call, callOptional, PrismaApiError } from '../http.ts';
import type { EnvironmentVariable } from './EnvironmentVariable.ts';

export interface DeploymentProps {
  /** The app this deployment targets. */
  computeServiceId: string;
  /** Path to a PREBUILT artifact (tar.gz) to upload. */
  artifactPath: string;
  /**
   * sha256 of the artifact. Part of the props so a new build (new hash)
   * registers as a change and forces a fresh deployment; a byte-identical
   * `artifactPath` alone would diff as a no-op.
   */
  artifactHash: string;
  /**
   * HTTP port the app listens on. Compute routes external HTTP to it
   * (`portMapping.http`); without it the endpoint has no route and 404s.
   */
  port?: number;
  /**
   * The env-var records this deployment boots with. The provider never reads
   * this — PDP materializes the branch's ConfigVariables into the deployment
   * itself at deployment-create. Its only job is the Alchemy dependency edge:
   * order this Deployment after those writes, and force a new deployment when
   * any upstream value changes (the environment edge that kills PRO-211 —
   * see docs/design/05-prisma-cloud/alchemy-lowering.md).
   */
  environment?: readonly EnvironmentVariable[];
}

export interface DeploymentAttributes {
  deploymentId: string;
  deployedUrl?: string;
}

export type Deployment = Resource<'Prisma.Deployment', DeploymentProps, DeploymentAttributes>;

/**
 * A **deployment** of a Prisma app — creates a deployment, uploads
 * its artifact, starts the VM, waits for it to run, then promotes it to the
 * app's stable endpoint.
 */
export const Deployment = Resource<Deployment>('Prisma.Deployment');

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      // `start` is asynchronous — the VM is not running when it returns. Poll
      // the deployment until its status is `running` before promoting, or the
      // promote call fails with 409 "not running".
      const waitForRunning = (deploymentId: string) =>
        call(() =>
          client.GET('/v1/deployments/{deploymentId}', {
            params: { path: { deploymentId } },
          }),
        ).pipe(
          Effect.flatMap((v) =>
            v.data.status === 'running'
              ? Effect.void
              : Effect.fail(
                  new PrismaApiError({
                    status: 409,
                    message: `deployment ${deploymentId} is ${v.data.status}, not running`,
                  }),
                ),
          ),
          Effect.retry(Schedule.max([Schedule.spaced('2 seconds'), Schedule.during('2 minutes')])),
        );

      return {
        stables: [],
        list: () => Effect.succeed([] as DeploymentAttributes[]),
        reconcile: Effect.fn(function* ({ news }) {
          // Every reconcile ships a new deployment: create → upload → start →
          // wait-until-running → promote. There is no observe short-circuit —
          // a props change (a new artifactHash) is what brought us here, so
          // returning the previous deployment would strand the new build.
          const created = yield* call(() =>
            client.POST('/v1/apps/{appId}/deployments', {
              params: { path: { appId: news.computeServiceId } },
              body: news.port !== undefined ? { portMapping: { http: news.port } } : {},
            }),
          );
          const deploymentId = created.data.id;

          if (created.data.uploadUrl) {
            const uploadUrl = created.data.uploadUrl;
            const artifact = yield* Effect.try({
              try: () => fs.readFileSync(news.artifactPath),
              catch: (cause) =>
                new PrismaApiError({
                  status: 0,
                  message: `failed to read artifact ${news.artifactPath}: ${String(cause)}`,
                }),
            });
            yield* Effect.tryPromise({
              try: async () => {
                const res = await fetch(uploadUrl, { method: 'PUT', body: artifact });
                if (!res.ok) {
                  throw new PrismaApiError({
                    status: res.status,
                    message: `artifact upload failed: ${res.status} ${res.statusText}`,
                  });
                }
              },
              catch: (cause) =>
                cause instanceof PrismaApiError
                  ? cause
                  : new PrismaApiError({ status: 0, message: String(cause) }),
            });
          }

          yield* call(() =>
            client.POST('/v1/deployments/{deploymentId}/start', {
              params: { path: { deploymentId } },
            }),
          );

          yield* waitForRunning(deploymentId);

          // The serving domain only resolves to the running deployment's
          // region once promoted; the app's create-time `appEndpointDomain`
          // is a placeholder. Promote returns the live one.
          const promoted = yield* call(() =>
            client.POST('/v1/apps/{appId}/promote', {
              params: { path: { appId: news.computeServiceId } },
              body: { deploymentId },
            }),
          );

          const deployedUrl = promoted.data.appEndpointDomain;
          return { deploymentId, ...(deployedUrl !== undefined && { deployedUrl }) };
        }),
        delete: Effect.fn(function* () {
          // A promoted deployment is retained as the app's deploy history;
          // deleting the ComputeService itself tears down its deployments.
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.deploymentId) return undefined;
          const v = yield* callOptional(() =>
            client.GET('/v1/deployments/{deploymentId}', {
              params: { path: { deploymentId: output.deploymentId } },
            }),
          );
          return v
            ? {
                deploymentId: v.data.id,
                ...(v.data.previewDomain && { deployedUrl: v.data.previewDomain }),
              }
            : undefined;
        }),
      };
    }),
  );
