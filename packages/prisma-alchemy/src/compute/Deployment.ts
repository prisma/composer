import * as fs from 'node:fs';
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import { ManagementClient } from '../client.ts';
import { call, callOptional, PrismaApiError } from '../http.ts';

export interface DeploymentProps {
  /** The compute service this deployment targets. */
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
}

export interface DeploymentAttributes {
  versionId: string;
  deployedUrl?: string;
}

export type Deployment = Resource<'Prisma.Deployment', DeploymentProps, DeploymentAttributes>;

/**
 * A **deployment** of a Prisma Compute service — creates a version, uploads
 * its artifact, starts the VM, waits for it to run, then promotes it to the
 * service's stable endpoint.
 */
export const Deployment = Resource<Deployment>('Prisma.Deployment');

export const DeploymentProvider = () =>
  Provider.effect(
    Deployment,
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      // `start` is asynchronous — the VM is not running when it returns. Poll
      // the version until its status is `running` before promoting, or the
      // promote call fails with 409 "not running".
      const waitForRunning = (versionId: string) =>
        call(() =>
          client.GET('/v1/compute-services/versions/{versionId}', {
            params: { path: { versionId } },
          }),
        ).pipe(
          Effect.flatMap((v) =>
            v.data.status === 'running'
              ? Effect.void
              : Effect.fail(
                  new PrismaApiError({
                    status: 409,
                    message: `compute version ${versionId} is ${v.data.status}, not running`,
                  }),
                ),
          ),
          Effect.retry(Schedule.both(Schedule.spaced('2 seconds'), Schedule.during('2 minutes'))),
        );

      return {
        stables: [],
        list: () => Effect.succeed([] as DeploymentAttributes[]),
        reconcile: Effect.fn(function* ({ news }) {
          // Every reconcile ships a new version: create → upload → start →
          // wait-until-running → promote. There is no observe short-circuit —
          // a props change (a new artifactHash) is what brought us here, so
          // returning the previous version would strand the new build.
          const created = yield* call(() =>
            client.POST('/v1/compute-services/{computeServiceId}/versions', {
              params: { path: { computeServiceId: news.computeServiceId } },
              body: news.port !== undefined ? { portMapping: { http: news.port } } : {},
            }),
          );
          const versionId = created.data.id;

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
            client.POST('/v1/compute-services/versions/{versionId}/start', {
              params: { path: { versionId } },
            }),
          );

          yield* waitForRunning(versionId);

          yield* call(() =>
            client.POST('/v1/compute-services/{computeServiceId}/promote', {
              params: { path: { computeServiceId: news.computeServiceId } },
              body: { versionId },
            }),
          );

          // The serving domain only resolves to the running version's region
          // once promoted; the service's create-time `serviceEndpointDomain` is
          // a placeholder. Re-read the service for the live URL.
          const service = yield* call(() =>
            client.GET('/v1/compute-services/{computeServiceId}', {
              params: { path: { computeServiceId: news.computeServiceId } },
            }),
          );

          const deployedUrl = service.data.serviceEndpointDomain;
          return { versionId, ...(deployedUrl !== undefined && { deployedUrl }) };
        }),
        delete: Effect.fn(function* () {
          // A promoted version is retained as the service's deploy history;
          // deleting the ComputeService itself tears down its versions.
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.versionId) return undefined;
          const v = yield* callOptional(() =>
            client.GET('/v1/compute-services/versions/{versionId}', {
              params: { path: { versionId: output.versionId } },
            }),
          );
          return v
            ? {
                versionId: v.data.id,
                ...(v.data.previewDomain && { deployedUrl: v.data.previewDomain }),
              }
            : undefined;
        }),
      };
    }),
  );
