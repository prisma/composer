/** The `compute` node kind's descriptor: the four service hooks — provision, serialize, package, deploy. */

import type { ServiceNode } from '@internal/core';
import type { NodeDescriptor } from '@internal/core/config';
import * as Prisma from '@internal/lowering';
import * as Effect from 'effect/Effect';
import { configKey, encode, paramEntries } from '../serializer.ts';
import { DEFAULT_REGION, projectIdOf, type ResolvedCloudOptions, validateName } from './shared.ts';

export function computeDescriptor(o: ResolvedCloudOptions): NodeDescriptor {
  return {
    kind: 'service' as const,
    // The service as a PLACE inside the application's Project: the App,
    // identity-bearing only, no code runs.
    provision: ({ id, application }) =>
      Effect.gen(function* () {
        validateName(id, 'service name (from provision id)');
        const svc = yield* Prisma.ComputeService(`${id}-svc`, {
          projectId: projectIdOf(application),
          name: id,
          region: o.region ?? DEFAULT_REGION,
          ...(o.branchId !== undefined ? { branchId: o.branchId } : {}),
        });
        return {
          outputs: { serviceId: svc.id, projectId: application.outputs['projectId'] },
        };
      }),

    // A dependency-input value may be a provisioning ref, not a literal
    // string — `encode` passes it through untouched so it keeps carrying the
    // ordering edge; only service-own literals are actually stringified.
    serialize: ({ address, node }, provisioned, config) =>
      Effect.gen(function* () {
        const records = [];
        for (const d of paramEntries(node as ServiceNode)) {
          const value =
            d.owner === 'service' ? config.service[d.name] : config.inputs[d.owner.input]?.[d.name];
          const key = configKey(address, d);
          records.push(
            yield* Prisma.EnvironmentVariable(`${key}-var`, {
              projectId: projectIdOf(provisioned),
              key,
              value: encode(d.owner, value),
              class: o.branchId ? 'preview' : 'production',
              ...(o.branchId !== undefined ? { branchId: o.branchId } : {}),
            }),
          );
        }
        // Carries the resolved port to deploy() via serialize's outputs; falls back to 3000 if unset.
        const port = typeof config.service['port'] === 'number' ? config.service['port'] : 3000;
        return { outputs: { environment: records, port } };
      }),

    // Deterministic tar.gz (fixed mtimes/ordering) so unchanged inputs hash
    // identically; the fs/tar work itself lives in @internal/lowering.
    package: ({ id }, { assembled, address }) =>
      Effect.try(() =>
        Prisma.packageComputeArtifact({
          id,
          bundleDir: assembled.dir,
          appEntry: assembled.entry,
          address,
        }),
      ),

    // The environment prop references serialize's env-var records, so the deploy depends on them.
    deploy: ({ id }, provisioned, artifact, serialized) =>
      Effect.gen(function* () {
        const deployment = yield* Prisma.Deployment(`${id}-deploy`, {
          computeServiceId: provisioned.outputs['serviceId'] as string,
          artifactPath: artifact.path,
          artifactHash: artifact.sha256,
          environment: serialized.outputs['environment'] as readonly Prisma.EnvironmentVariable[],
          // Route to the port the app actually binds (the service's `port`
          // param, resolved by serialize) — not a hardcoded constant.
          port: typeof serialized.outputs['port'] === 'number' ? serialized.outputs['port'] : 3000,
        });
        return {
          outputs: { url: deployment.deployedUrl, projectId: provisioned.outputs['projectId'] },
        };
      }),
  };
}
